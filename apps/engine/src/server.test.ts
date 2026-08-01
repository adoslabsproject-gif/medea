/**
 * Tests per server onError handler (C3 audit fix).
 *
 * Coverage:
 *   - Prod (NODE_ENV=production): NO err.message nel body, solo code+reqId
 *   - Dev: err.message visible (debugging local)
 *   - Logger.error chiamato con err completo (sempre)
 *   - Status code 500 in entrambi
 *
 * NB: testiamo la logica onError direttamente, non l'intero createServer
 * (che richiede DB SQLite, eventBus, mille deps).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/lib/logger.js');
// Spy autonomo: la replica del handler onError qui sotto lo chiama direttamente
// (non passa dal logger reale) → resta una vi.fn() indipendente dal manual mock.
const loggerErrorSpy = vi.fn();

beforeEach(() => {
  loggerErrorSpy.mockReset();
});

/**
 * Replica del handler onError di server.ts:239-249 — testato in isolation.
 * Se il sorgente cambia, aggiorna QUI per garantire che i test catturino
 * regressioni semantiche (es. qualcuno reintroduce err.message in prod).
 */
function buildAppWithOnError(): Hono {
  const app = new Hono();
  app.get('/boom', () => {
    throw new Error('Detailed SQL error: column tenant_id does not exist in schema flowforge');
  });
  app.onError((err, c) => {
    const reqId = c.req.header('x-request-id') ?? 'unknown';
    loggerErrorSpy({ err, reqId, path: c.req.path, method: c.req.method }, 'Unhandled error');
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Errore interno', reqId } }, 500);
    }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: err.message, reqId } }, 500);
  });
  return app;
}

describe('server onError handler — C3 leak fix', () => {
  it('in PRODUCTION: NON leakka err.message (no schema/path/SQL details)', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildAppWithOnError();
    const res = await app.request('/boom', { headers: { 'x-request-id': 'req-123' } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string; reqId: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Errore interno');
    expect(body.error.reqId).toBe('req-123');
    // CRITICAL: dettagli SQL NON devono trapelare
    expect(JSON.stringify(body)).not.toMatch(/column tenant_id/);
    expect(JSON.stringify(body)).not.toMatch(/schema flowforge/);
  });

  it('in DEVELOPMENT: leakka err.message (debugging local)', async () => {
    process.env.NODE_ENV = 'development';
    const app = buildAppWithOnError();
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('column tenant_id');
  });

  it('in TEST: leakka err.message (default come dev)', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildAppWithOnError();
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('SQL error');
  });

  it('logger.error chiamato con err completo SEMPRE (prod e dev)', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildAppWithOnError();
    await app.request('/boom', { headers: { 'x-request-id': 'req-prod' } });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [logCtx] = loggerErrorSpy.mock.calls[0] as [{ err: Error; reqId: string; path: string; method: string }, string];
    expect(logCtx.err.message).toContain('column tenant_id');     // log interno SI
    expect(logCtx.reqId).toBe('req-prod');
    expect(logCtx.path).toBe('/boom');
    expect(logCtx.method).toBe('GET');
  });

  it('reqId fallback "unknown" se header x-request-id assente', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildAppWithOnError();
    const res = await app.request('/boom');
    const body = (await res.json()) as { error: { reqId: string } };
    expect(body.error.reqId).toBe('unknown');
  });
});
