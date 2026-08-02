/**
 * Tests per honeypot middleware runtime tenant (#194 audit fix).
 *
 * Coverage:
 *   - path benigni → next() (no 404)
 *   - path malevolo → 404 + body "Not Found"
 *   - notifySentinel chiamato con payload corretto
 *   - SENTINEL_ENABLED=false → skip fetch
 *   - timeout → degrada gracefully (request resta 404)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/lib/logger.js');

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.SENTINEL_INTERNAL_SECRET = 'test-secret';
  process.env.SENTINEL_URL = 'http://sentinel-test:8080';
  process.env.SENTINEL_ENABLED = 'true';
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SENTINEL_ENABLED;
});

async function buildApp() {
  const { honeypotMiddleware } = await import('./honeypot.js');
  const app = new Hono();
  app.use('*', honeypotMiddleware());
  app.get('/', (c) => c.text('homepage'));
  app.get('/api/v1/workflows', (c) => c.json({ ok: true }));
  return app;
}

describe('honeypot middleware runtime', () => {
  it('lascia passare path legittimi (/, /api/v1/*)', async () => {
    const app = await buildApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('homepage');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocca /@fs/etc/passwd con 404 (#194 reported)', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ hit_count: 1, banned: false })));
    const app = await buildApp();
    const res = await app.request('/@fs/etc/passwd');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('blocca /wp-admin/install.php con 404', async () => {
    fetchSpy.mockResolvedValue(new Response('{}'));
    const app = await buildApp();
    const res = await app.request('/wp-admin/install.php');
    expect(res.status).toBe(404);
  });

  it('blocca /.env con 404 (env_leak)', async () => {
    fetchSpy.mockResolvedValue(new Response('{}'));
    const app = await buildApp();
    const res = await app.request('/.env');
    expect(res.status).toBe(404);
  });

  it('notifySentinel POST con payload ip+endpoint+ua', async () => {
    fetchSpy.mockResolvedValue(new Response('{}'));
    const app = await buildApp();
    await app.request('/.env', {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'user-agent': 'Mozilla/5.0 ScannerBot' },
    });
    // L'invocazione è fire-and-forget — diamo un tick per la promise.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/honeypot/hit');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      ip: string;
      endpoint: string;
      user_agent: string;
    };
    expect(body.ip).toBe('1.2.3.4');
    expect(body.endpoint).toBe('/.env');
    expect(body.user_agent).toContain('ScannerBot');
  });

  it('SENTINEL_ENABLED=false → skip fetch ma 404 resta', async () => {
    process.env.SENTINEL_ENABLED = 'false';
    const app = await buildApp();
    const res = await app.request('/.env');
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sentinel timeout → request comunque 404 (fail-soft)', async () => {
    fetchSpy.mockRejectedValue(new Error('AbortError'));
    const app = await buildApp();
    const res = await app.request('/.env');
    expect(res.status).toBe(404);
  });
});
