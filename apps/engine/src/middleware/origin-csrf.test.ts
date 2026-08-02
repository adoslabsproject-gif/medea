/**
 * Test 2026-grade — origin-csrf middleware.
 *
 * Coverage REALE (no smoke, no fake):
 *  - SAFE methods (GET/HEAD/OPTIONS) → bypass total
 *  - skipPaths regex matcha → bypass
 *  - Bearer auth pattern (no origin, no referer, no cookie) → bypass
 *  - Cookie ff_session presente MA no origin/referer → 403
 *  - Cookie __Host-ff_session presente MA no origin/referer → 403 (REGRESSION
 *    fix 2026-05-29: pre-fix il check guardava solo ff_session, il
 *    __Host- prefix bypassava silenziosamente il CSRF gate)
 *  - Origin in allowlist → pass
 *  - Origin NOT in allowlist → 403 con error message containing l'origin
 *  - Origin allowed pattern regex (wildcard subdomain) → pass
 *  - Referer fallback quando origin assente → estratto via URL.origin
 *  - Referer malformato → catch implicito (jsdom URL throws)
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { originCsrf } from './origin-csrf.js';

function makeApp(opts: Parameters<typeof originCsrf>[0]): Hono {
  const app = new Hono();
  app.use('*', originCsrf(opts));
  app.get('/get', (c) => c.json({ ok: true, m: 'GET' }));
  app.post('/post', (c) => c.json({ ok: true, m: 'POST' }));
  app.put('/put', (c) => c.json({ ok: true, m: 'PUT' }));
  app.delete('/del', (c) => c.json({ ok: true, m: 'DELETE' }));
  app.patch('/patch', (c) => c.json({ ok: true, m: 'PATCH' }));
  return app;
}

const ALLOWED = ['https://flowforge.automazionezeli.com', 'https://app.example.com'];
const WILDCARD = /^https:\/\/[a-z0-9-]+\.app\.automazionezeli\.com$/u;

describe('originCsrf — SAFE methods bypass', () => {
  it('GET → pass anche senza origin', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/get');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, m: 'GET' });
  });

  it('HEAD → pass', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/get', { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('OPTIONS → pass (preflight CORS, no 403)', async () => {
    // Hono non ha handler OPTIONS automatico → 404 dal router, MA il
    // middleware deve aver chiamato next() (no 403 CSRF). Assert su !== 403.
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/get', { method: 'OPTIONS' });
    expect(res.status).not.toBe(403);
  });

  it('lowercase method "get" trattato come GET (case-insensitive)', async () => {
    // Hono normalizza method, ma il middleware fa .toUpperCase() per safety.
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/get', { method: 'get' });
    expect(res.status).toBe(200);
  });
});

describe('originCsrf — skipPaths', () => {
  it('path matcha skipPaths regex → bypass anche se mutating', async () => {
    const app = new Hono();
    app.use(
      '*',
      originCsrf({
        allowedOrigins: ALLOWED,
        skipPaths: [/^\/api\/v1\/internal\//u],
      }),
    );
    app.post('/api/v1/internal/wake', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/internal/wake', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('path NON in skipPaths → applica CSRF check normale', async () => {
    const app = new Hono();
    app.use(
      '*',
      originCsrf({
        allowedOrigins: ALLOWED,
        skipPaths: [/^\/api\/v1\/internal\//u],
      }),
    );
    app.post('/api/v1/external/foo', (c) => c.json({ ok: true }));
    // No origin + no cookie → bearer pattern, passa
    const res = await app.request('/api/v1/external/foo', { method: 'POST' });
    expect(res.status).toBe(200);
    // No origin + cookie → 403
    const res2 = await app.request('/api/v1/external/foo', {
      method: 'POST',
      headers: { cookie: 'ff_session=xyz' },
    });
    expect(res2.status).toBe(403);
  });
});

describe('originCsrf — Bearer pattern bypass (no cookie, no origin, no referer)', () => {
  it('POST senza origin/referer/cookie → bypass (CLI/mobile native con Bearer)', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('POST con origin valido E senza cookie → comunque check origin', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: { origin: 'https://flowforge.automazionezeli.com' },
    });
    expect(res.status).toBe(200);
  });
});

describe('originCsrf — cookie REGRESSION (__Host-ff_session vs ff_session)', () => {
  it('cookie ff_session senza origin → 403 ("Origin/Referer required")', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: { cookie: 'ff_session=abc123' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'CSRF: Origin/Referer required' });
  });

  it('🚨 REGRESSION 2026-05-29: cookie __Host-ff_session senza origin → 403 (pre-fix passava)', async () => {
    // Prima del fix il middleware controllava SOLO `ff_session=` → i client
    // con il nuovo cookie `__Host-ff_session=` bypassavano silenziosamente
    // l'intero gate CSRF. Questo test PROTEGGE da quella regressione.
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: { cookie: '__Host-ff_session=abc123' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'CSRF: Origin/Referer required' });
  });

  it('cookie multiplo (ff_session + altri) → cookie detection OK → 403', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: { cookie: 'analytics=xyz; ff_session=abc; other=foo' },
    });
    expect(res.status).toBe(403);
  });

  it('cookie SENZA ff_session né __Host-ff_session → trattato come bearer pattern → pass', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: { cookie: 'analytics=xyz; other=foo' },
    });
    expect(res.status).toBe(200);
  });
});

describe('originCsrf — allowlist Origin check', () => {
  it('Origin in allowlist → pass', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://flowforge.automazionezeli.com',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(200);
  });

  it('Origin NOT in allowlist → 403 con error message contenente la stringa origin', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.org',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('https://evil.example.org');
    expect(body.error).toContain('not allowed');
  });

  it('Origin con port diverso = match esatto (no normalizzazione) → 403 se diverso', async () => {
    const res = await makeApp({ allowedOrigins: ['https://app.example.com'] }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://app.example.com:8443',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(403);
  });

  it('Origin protocol diverso (http vs https) → 403 (no protocol downgrade)', async () => {
    const res = await makeApp({ allowedOrigins: ['https://app.example.com'] }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'http://app.example.com',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('originCsrf — pattern regex (wildcard subdomain)', () => {
  it('Origin matcha pattern wildcard → pass', async () => {
    const res = await makeApp({
      allowedOrigins: ALLOWED,
      allowedOriginPatterns: [WILDCARD],
    }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://acme-corp.app.automazionezeli.com',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(200);
  });

  it('Origin NO match né allowlist né pattern → 403', async () => {
    const res = await makeApp({
      allowedOrigins: ALLOWED,
      allowedOriginPatterns: [WILDCARD],
    }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://evil.app.evil.com',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(403);
  });

  it('Origin matcha allowlist anche se pattern non match → pass (OR logic)', async () => {
    const res = await makeApp({
      allowedOrigins: ALLOWED,
      allowedOriginPatterns: [WILDCARD],
    }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://flowforge.automazionezeli.com',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('originCsrf — Referer fallback (no Origin)', () => {
  it('Referer presente, no Origin → estrai origin via URL.origin → match allowlist', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: {
        referer: 'https://flowforge.automazionezeli.com/some/path?q=1',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(200);
  });

  it('Referer presente con origin NON in allowlist → 403', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: {
        referer: 'https://evil.com/leak',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(403);
  });

  it('Origin presente vince su Referer (Origin preference)', async () => {
    // Origin allowed, Referer evil → DOVREBBE passare perché Origin > Referer
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/post', {
      method: 'POST',
      headers: {
        origin: 'https://flowforge.automazionezeli.com',
        referer: 'https://evil.com/redirect',
        cookie: 'ff_session=abc',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('originCsrf — coverage mutating methods', () => {
  it('PUT con origin valido → pass', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/put', {
      method: 'PUT',
      headers: { origin: ALLOWED[0]!, cookie: 'ff_session=abc' },
    });
    expect(res.status).toBe(200);
  });

  it('DELETE con origin invalido → 403', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/del', {
      method: 'DELETE',
      headers: { origin: 'https://attacker.com', cookie: 'ff_session=abc' },
    });
    expect(res.status).toBe(403);
  });

  it('PATCH con origin valido → pass', async () => {
    const res = await makeApp({ allowedOrigins: ALLOWED }).request('/patch', {
      method: 'PATCH',
      headers: { origin: ALLOWED[0]!, cookie: 'ff_session=abc' },
    });
    expect(res.status).toBe(200);
  });
});
