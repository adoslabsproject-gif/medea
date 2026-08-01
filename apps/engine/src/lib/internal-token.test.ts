import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { constantTimeEquals, verifyInternalToken, requireInternalToken, getOutboundPortalToken, getLoopbackInternalToken } from './internal-token.js';

const SECRET = 'a'.repeat(40);

describe('constantTimeEquals', () => {
  it('uguali → true, diversi/lunghezze diverse → false', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('verifyInternalToken — fail-closed', () => {
  afterEach(() => { delete process.env.FLOWFORGE_INTERNAL_TOKEN; });

  it('secret non configurato → sempre false (anche con input non vuoto)', () => {
    delete process.env.FLOWFORGE_INTERNAL_TOKEN;
    expect(verifyInternalToken(SECRET)).toBe(false);
  });
  it('input vuoto → false anche con secret configurato', () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = SECRET;
    expect(verifyInternalToken('')).toBe(false);
  });
  it('match esatto → true; mismatch → false', () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = SECRET;
    expect(verifyInternalToken(SECRET)).toBe(true);
    expect(verifyInternalToken('b'.repeat(40))).toBe(false);
  });
});

describe('requireInternalToken — middleware', () => {
  const build = (): Hono => {
    const app = new Hono();
    app.use(requireInternalToken());
    app.get('/x', (c) => c.json({ ok: true }));
    return app;
  };
  afterEach(() => { delete process.env.FLOWFORGE_INTERNAL_TOKEN; });

  it('secret non configurato → 401', async () => {
    delete process.env.FLOWFORGE_INTERNAL_TOKEN;
    const res = await build().request('/x', { headers: { 'x-internal-token': SECRET } });
    expect(res.status).toBe(401);
  });
  it('header mancante → 401', async () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = SECRET;
    expect((await build().request('/x')).status).toBe(401);
  });
  it('token errato → 401', async () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = SECRET;
    const res = await build().request('/x', { headers: { 'x-internal-token': 'b'.repeat(40) } });
    expect(res.status).toBe(401);
  });
  it('token valido → 200 + passa al next', async () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = SECRET;
    const res = await build().request('/x', { headers: { 'x-internal-token': SECRET } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('getOutboundPortalToken', () => {
  beforeEach(() => { delete process.env.PORTAL_CALLBACK_TOKEN; delete process.env.FLOWFORGE_INTERNAL_TOKEN; });
  afterEach(() => { delete process.env.PORTAL_CALLBACK_TOKEN; delete process.env.FLOWFORGE_INTERNAL_TOKEN; });

  it('preferisce PORTAL_CALLBACK_TOKEN', () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'portal';
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'internal';
    expect(getOutboundPortalToken()).toBe('portal');
  });
  it('fallback a FLOWFORGE_INTERNAL_TOKEN', () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'internal';
    expect(getOutboundPortalToken()).toBe('internal');
  });
  it('nessuno dei due → stringa vuota (mai undefined)', () => {
    expect(getOutboundPortalToken()).toBe('');
  });
});

describe('getLoopbackInternalToken — loopback runtime→se stesso (gap #7)', () => {
  beforeEach(() => { delete process.env.PORTAL_CALLBACK_TOKEN; delete process.env.FLOWFORGE_INTERNAL_TOKEN; });
  afterEach(() => { delete process.env.PORTAL_CALLBACK_TOKEN; delete process.env.FLOWFORGE_INTERNAL_TOKEN; });

  it('ritorna FLOWFORGE_INTERNAL_TOKEN', () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'internal';
    expect(getLoopbackInternalToken()).toBe('internal');
  });

  it('🚨 IGNORA PORTAL_CALLBACK_TOKEN — il proprio auth valida solo FLOWFORGE_INTERNAL_TOKEN', () => {
    // Se questo helper preferisse PORTAL_CALLBACK_TOKEN (come getOutboundPortalToken),
    // il loopback al proprio /api/v1 darebbe 401 (verifyInternalToken confronta
    // SOLO con FLOWFORGE_INTERNAL_TOKEN). Deve restare l'altro secret.
    process.env.PORTAL_CALLBACK_TOKEN = 'portal';
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'internal';
    expect(getLoopbackInternalToken()).toBe('internal');
  });

  it('il token del loopback è ACCETTATO dal proprio verifyInternalToken (contract round-trip)', () => {
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'secret-xyz';
    // ciò che l'outbound loopback presenta DEVE passare l'inbound dello stesso processo
    expect(verifyInternalToken(getLoopbackInternalToken())).toBe(true);
  });

  it('🚨 il token del PORTAL invece NON passa il proprio verifyInternalToken (prova che sono direzioni diverse)', () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'portal-only';
    process.env.FLOWFORGE_INTERNAL_TOKEN = 'internal-only';
    expect(verifyInternalToken(getOutboundPortalToken())).toBe(false);
    expect(verifyInternalToken(getLoopbackInternalToken())).toBe(true);
  });

  it('secret non settato → stringa vuota (mai undefined)', () => {
    expect(getLoopbackInternalToken()).toBe('');
  });
});

describe('🔒 [GUARD anti-classe] requireInternalToken mai montato senza path-scope', () => {
  // Becca la CLASSE del bug 2026-06-11: `app.use(requireInternalToken())` = use('*')
  // → su un sub-app montato `app.route('/api/v1', ...)` leakava su /api/v1/dashboard.
  // La coverage NON lo vedeva (la riga era "coperta"). Questo guard sì.
  it('requireInternalToken applicato SOLO per-route, mai via .use() (anche path-scoped leaka su sub-app montati)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
        const src = readFileSync(p, 'utf8');
        // QUALSIASI `.use(...requireInternalToken...)` è vietato: anche
        // `.use('/internal/*', requireInternalToken())` su un sub-app montato
        // `app.route('/api/v1', ...)` leakava su /api/v1/dashboard (prod 2026-06-11).
        // L'unico modo sicuro è per-route: app.get('/internal/x', gate, handler).
        if (/\.use\([^)]*requireInternalToken/.test(src)) offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders, `monta il middleware con un path scope, es. app.use('/internal/*', requireInternalToken()): ${offenders.join(', ')}`).toEqual([]);
  });
});
