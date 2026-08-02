/**
 * Email-tracking routes — endpoint contract tests.
 *
 * Validates:
 *  - /api/track/open/:token returns 200 + GIF bytes for any token shape
 *    (refusing the GIF would leak that we're filtering scanners)
 *  - good token → DB row in b2b_interactions
 *  - bot UA  → still GIF + 200 but NO db row
 *  - /api/track/click/:token redirects 302 to ?u=
 *  - missing/bad token → 400 with HTML error page
 *  - javascript:/data: destination refused
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { signTrackingToken } from '@medea/engine-nodes-stdlib/server';
import { TRANSPARENT_GIF_BYTES } from '@/services/email-tracking.service.js';

const SECRET = 'c'.repeat(40);

const sqliteMem = new Database(':memory:');
sqliteMem.exec(`
  CREATE TABLE IF NOT EXISTS b2b_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    campaign_id TEXT,
    send_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`);

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteMem }),
}));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({
  loadConfig: () => ({ MEDEA_SSO_SECRET: 'c'.repeat(40) }),
}));

beforeEach(() => {
  sqliteMem.prepare('DELETE FROM b2b_interactions').run();
});

async function buildApp(): Promise<Hono> {
  const { createEmailTrackingRoutes } = await import('./email-tracking.route.js');
  const app = new Hono();
  app.route('/', createEmailTrackingRoutes());
  return app;
}

async function freshOpenToken(): Promise<string> {
  const signed = await signTrackingToken({
    w: '00000000-0000-0000-0000-000000000ws',
    l: 'lead-1', c: 'c1', s: 's1', k: 'open',
  }, SECRET);
  return signed.token;
}
async function freshClickToken(): Promise<string> {
  const signed = await signTrackingToken({
    w: '00000000-0000-0000-0000-000000000ws',
    l: 'lead-1', c: 'c1', s: 's1', k: 'click', i: 0,
  }, SECRET);
  return signed.token;
}

describe('GET /api/track/open/:token', () => {
  it('valid token → 200 GIF + INSERT b2b_interactions row', async () => {
    const app = await buildApp();
    const res = await app.request(`/api/track/open/${await freshOpenToken()}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'x-forwarded-for': '203.0.113.10',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(TRANSPARENT_GIF_BYTES)).toBe(true);

    const rows = sqliteMem.prepare("SELECT * FROM b2b_interactions WHERE type='email_open'").all();
    expect(rows).toHaveLength(1);
  });

  it('bot UA (GoogleImageProxy) → 200 GIF but NO DB row', async () => {
    const app = await buildApp();
    const res = await app.request(`/api/track/open/${await freshOpenToken()}`, {
      headers: { 'user-agent': 'GoogleImageProxy/1.0' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    const rows = sqliteMem.prepare('SELECT * FROM b2b_interactions').all();
    expect(rows).toHaveLength(0);
  });

  it('invalid token → 200 GIF + NO DB row (do NOT leak filtering)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/track/open/garbage.signature');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    const rows = sqliteMem.prepare('SELECT * FROM b2b_interactions').all();
    expect(rows).toHaveLength(0);
  });

  it('Cache-Control set to no-store', async () => {
    const app = await buildApp();
    const res = await app.request(`/api/track/open/${await freshOpenToken()}`);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });
});

describe('GET /api/track/click/:token', () => {
  it('valid token + valid dest → 302 redirect + INSERT b2b_interactions', async () => {
    const app = await buildApp();
    const dest = 'https://redivivogin.it/catalog?ref=campaign1';
    const res = await app.request(`/api/track/click/${await freshClickToken()}?u=${encodeURIComponent(dest)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(dest);

    const rows = sqliteMem.prepare("SELECT payload_json FROM b2b_interactions WHERE type='email_click'").all() as { payload_json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json).url).toBe(dest);
  });

  it('missing ?u= → 400 HTML error', async () => {
    const app = await buildApp();
    const res = await app.request(`/api/track/click/${await freshClickToken()}`);
    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain('link senza destinazione');
  });

  it('bad token → 400 HTML error', async () => {
    const app = await buildApp();
    const res = await app.request('/api/track/click/garbage.sig?u=https://example.com/');
    expect(res.status).toBe(400);
  });

  it('javascript: destination → 400', async () => {
    const app = await buildApp();
    const res = await app.request(
      `/api/track/click/${await freshClickToken()}?u=${encodeURIComponent('javascript:alert(1)')}`,
    );
    expect(res.status).toBe(400);
  });

  it('data: destination → 400', async () => {
    const app = await buildApp();
    const res = await app.request(
      `/api/track/click/${await freshClickToken()}?u=${encodeURIComponent('data:text/html,<script>alert(1)</script>')}`,
    );
    expect(res.status).toBe(400);
  });

  it('open-only token used on /click → 400 (kind-mismatch)', async () => {
    const app = await buildApp();
    const res = await app.request(
      `/api/track/click/${await freshOpenToken()}?u=${encodeURIComponent('https://x.com/')}`,
    );
    expect(res.status).toBe(400);
  });

  it('bot UA on click → still 302 (we DO let real human links redirect) BUT no DB row', async () => {
    const app = await buildApp();
    const res = await app.request(
      `/api/track/click/${await freshClickToken()}?u=${encodeURIComponent('https://x.com/')}`,
      { headers: { 'user-agent': 'mimecast-scanner/2.0' } },
    );
    expect(res.status).toBe(302);
    const rows = sqliteMem.prepare("SELECT * FROM b2b_interactions WHERE type='email_click'").all();
    expect(rows).toHaveLength(0);
  });
});
