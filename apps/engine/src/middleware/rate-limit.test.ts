/**
 * Test 2026-grade — rate-limit middleware flowforge-runtime.
 *
 * Algoritmo: fixed-window con sliding-window approximation (Cloudflare-style
 * weighted prev + current).
 *
 * Coverage REALE (no smoke, no fake):
 *  - Identity hardening (HIGH 2026-05-29): tenantFrom/userFrom usano
 *    auth.tenantId/userId dal context, NIENTE fallback su header.
 *    REGRESSION test: client che setta X-Tenant-Id arbitrario NON bypassa.
 *  - perTenant limit raggiunto → 429 con body { error, scope: 'tenant',
 *    message, retryAfterSeconds }
 *  - perUser limit raggiunto → 429 con scope: 'user'
 *  - Tenant limit hit prima di user limit → tenant 429 (priority order)
 *  - Sliding-window math: dopo windowMs/2 il bucket precedente contribuisce
 *    al 50% del peso
 *  - GAP > 1 windowMs → prev azzerato (no stale contribution)
 *  - Bucket shift esatto (current.start !== bucketStart) → prev = current
 *  - Multi-tenant isolation: tenantA non vede counter tenantB
 *  - Multi-user nello stesso tenant: counter user separato
 *  - counterInc metric chiamato con scope corretto (tenant vs user)
 *  - llmRateLimit preset (30/10 req/min)
 *  - Default tenantFrom: auth.tenantId presente → usa; assente → 'default'
 *  - Default userFrom: priority auth.userId → auth.sub → 'anon'
 *  - tenantFrom/userFrom custom override
 *  - Boundary exact: perTenant=N → al colpo N+1 → 429 (non N)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const counterIncMock = vi.fn();
vi.mock('@/lib/metrics-store.js', () => ({
  counterInc: (args: unknown) => counterIncMock(args),
}));

import { rateLimit, llmRateLimit, _resetRateLimitState } from './rate-limit.js';

interface AuthLike {
  tenantId?: string;
  userId?: string;
  sub?: string;
}

function appWithAuth(
  auth: AuthLike | undefined,
  mw: ReturnType<typeof rateLimit>,
): Hono<{ Variables: { auth: AuthLike } }> {
  const app = new Hono<{ Variables: { auth: AuthLike } }>();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.use('*', mw);
  app.get('/hit', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  counterIncMock.mockReset();
  _resetRateLimitState();
});

describe('rateLimit — identity hardening (HIGH 2026-05-29)', () => {
  it('default tenantFrom legge auth.tenantId (NON X-Tenant-Id header)', async () => {
    const mw = rateLimit({ label: 'h', windowMs: 60_000, perTenant: 1 });
    const app = appWithAuth({ tenantId: 'real-tenant', userId: 'u' }, mw);

    // Primo hit con auth.tenantId='real-tenant' → ok
    const r1 = await app.request('/hit');
    expect(r1.status).toBe(200);
    // Secondo hit con header X-Tenant-Id='fake-bypass' — ma auth e\` ancora 'real-tenant'
    // → bucket 'real-tenant' SEMPRE → 429 (no bypass)
    const r2 = await app.request('/hit', { headers: { 'X-Tenant-Id': 'fake-bypass' } });
    expect(r2.status).toBe(429);
  });

  it('🚨 REGRESSION pre-2026-05-29: header SOLO non basta a creare bucket diverso', async () => {
    // Pre-fix: il client poteva mandare X-Tenant-Id arbitrario e ottenere
    // bucket diverso → quote illimitate, bypass su LLM cost.
    const mw = rateLimit({ label: 'rl', windowMs: 60_000, perTenant: 2 });
    const app = appWithAuth({ tenantId: 'authentic' }, mw);
    await app.request('/hit');
    await app.request('/hit');
    // Terzo hit con header rotation → DOVREBBE essere 429 (bucket condiviso da auth)
    const r3 = await app.request('/hit', { headers: { 'X-Tenant-Id': 'rotated-1' } });
    expect(r3.status).toBe(429);
    const r4 = await app.request('/hit', { headers: { 'X-Tenant-Id': 'rotated-2' } });
    expect(r4.status).toBe(429);
  });

  it('no auth context (route pubblica) → tenant=default, user=anon', async () => {
    const mw = rateLimit({ label: 'pub', windowMs: 60_000, perTenant: 1 });
    const app = appWithAuth(undefined, mw);
    const r1 = await app.request('/hit');
    expect(r1.status).toBe(200);
    const r2 = await app.request('/hit');
    expect(r2.status).toBe(429); // bucket 'default' exhausted
  });

  it('default userFrom: auth.userId presente → usa', async () => {
    const mw = rateLimit({ label: 'uid', windowMs: 60_000, perUser: 1 });
    const a = appWithAuth({ tenantId: 't', userId: 'alice' }, mw);
    expect((await a.request('/hit')).status).toBe(200);
    expect((await a.request('/hit')).status).toBe(429);

    // Resetta bucket alice; con userId='bob' nuovo bucket
    _resetRateLimitState();
    const b = appWithAuth({ tenantId: 't', userId: 'bob' }, mw);
    expect((await b.request('/hit')).status).toBe(200);
  });

  it('default userFrom: auth.sub fallback se manca userId (JWT std claim)', async () => {
    const mw = rateLimit({ label: 'sub', windowMs: 60_000, perUser: 1 });
    const a = appWithAuth({ tenantId: 't', sub: 'jwt-sub-xyz' } as AuthLike, mw);
    expect((await a.request('/hit')).status).toBe(200);
    expect((await a.request('/hit')).status).toBe(429);
  });

  it('custom tenantFrom override applicato', async () => {
    const mw = rateLimit({
      label: 'cust',
      windowMs: 60_000,
      perTenant: 1,
      tenantFrom: (c) => c.req.header('x-custom-tenant') ?? 'fallback',
    });
    const app = appWithAuth({ tenantId: 'auth-ignored' }, mw);
    await app.request('/hit', { headers: { 'x-custom-tenant': 'cust-A' } });
    // Different tenant via custom override → counter SEPARATO
    const r = await app.request('/hit', { headers: { 'x-custom-tenant': 'cust-B' } });
    expect(r.status).toBe(200);
  });
});

describe('rateLimit — perTenant scope', () => {
  it('limite N → primo hit OK fino a N, N+1 → 429', async () => {
    const mw = rateLimit({ label: 't', windowMs: 60_000, perTenant: 3 });
    const app = appWithAuth({ tenantId: 'acme', userId: 'alice' }, mw);
    expect((await app.request('/hit')).status).toBe(200);
    expect((await app.request('/hit')).status).toBe(200);
    expect((await app.request('/hit')).status).toBe(200);
    const blocked = await app.request('/hit');
    expect(blocked.status).toBe(429);
  });

  it('body 429 ha struttura completa { error, scope, message, retryAfterSeconds }', async () => {
    const mw = rateLimit({ label: 'tag-x', windowMs: 30_000, perTenant: 1 });
    const app = appWithAuth({ tenantId: 'acme' }, mw);
    await app.request('/hit');
    const res = await app.request('/hit');
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: string;
      scope: string;
      message: string;
      retryAfterSeconds: number;
    };
    expect(body.error).toBe('rate_limit_exceeded');
    expect(body.scope).toBe('tenant');
    expect(body.message).toContain('Troppe richieste per il tenant');
    expect(body.message).toContain('Limite 1/30s');
    expect(body.retryAfterSeconds).toBe(30); // ceil(30000/1000)
  });

  it('metric counterInc chiamato con scope=tenant', async () => {
    const mw = rateLimit({ label: 'mlbl', windowMs: 60_000, perTenant: 1 });
    const app = appWithAuth({ tenantId: 'acme' }, mw);
    await app.request('/hit');
    await app.request('/hit');
    expect(counterIncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'flowforge_rate_limit_exceeded_total',
        tags: { label: 'mlbl', scope: 'tenant' },
      }),
    );
  });

  it('tenant DIVERSI non interferiscono (isolation)', async () => {
    const mw = rateLimit({ label: 'iso', windowMs: 60_000, perTenant: 2 });
    const tenantA = appWithAuth({ tenantId: 'A' }, mw);
    const tenantB = appWithAuth({ tenantId: 'B' }, mw);
    await tenantA.request('/hit');
    await tenantA.request('/hit');
    // A exhausted; B vergine
    expect((await tenantA.request('/hit')).status).toBe(429);
    expect((await tenantB.request('/hit')).status).toBe(200);
    expect((await tenantB.request('/hit')).status).toBe(200);
    expect((await tenantB.request('/hit')).status).toBe(429);
  });
});

describe('rateLimit — perUser scope', () => {
  it('user separati nello stesso tenant → counter indipendenti', async () => {
    const mw = rateLimit({ label: 'u', windowMs: 60_000, perUser: 1 });
    const aliceApp = appWithAuth({ tenantId: 't', userId: 'alice' }, mw);
    const bobApp = appWithAuth({ tenantId: 't', userId: 'bob' }, mw);
    expect((await aliceApp.request('/hit')).status).toBe(200);
    expect((await aliceApp.request('/hit')).status).toBe(429);
    // Bob ancora vergine
    expect((await bobApp.request('/hit')).status).toBe(200);
  });

  it('429 user scope con message specifico "per il tuo account"', async () => {
    const mw = rateLimit({ label: 'u', windowMs: 60_000, perUser: 1 });
    const app = appWithAuth({ tenantId: 't', userId: 'u1' }, mw);
    await app.request('/hit');
    const res = await app.request('/hit');
    const body = (await res.json()) as { scope: string; message: string };
    expect(body.scope).toBe('user');
    expect(body.message).toContain('Troppe richieste per il tuo account');
  });

  it('metric counterInc chiamato con scope=user', async () => {
    const mw = rateLimit({ label: 'metr', windowMs: 60_000, perUser: 1 });
    const app = appWithAuth({ tenantId: 't', userId: 'u' }, mw);
    await app.request('/hit');
    await app.request('/hit');
    expect(counterIncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: { label: 'metr', scope: 'user' },
      }),
    );
  });
});

describe('rateLimit — tenant + user combined', () => {
  it('tenant limit hit PRIMA di user limit → 429 tenant (priority order del check)', async () => {
    // perTenant=2, perUser=5 → al colpo 3 si attiva tenant prima
    const mw = rateLimit({ label: 'comb', windowMs: 60_000, perTenant: 2, perUser: 5 });
    const app = appWithAuth({ tenantId: 't', userId: 'u' }, mw);
    await app.request('/hit');
    await app.request('/hit');
    const res = await app.request('/hit');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe('tenant');
  });

  it('user limit hit PRIMA di tenant limit → 429 user', async () => {
    // perTenant=10, perUser=1 → al colpo 2 user blocca
    const mw = rateLimit({ label: 'comb2', windowMs: 60_000, perTenant: 10, perUser: 1 });
    const app = appWithAuth({ tenantId: 't', userId: 'u' }, mw);
    await app.request('/hit');
    const res = await app.request('/hit');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe('user');
  });
});

describe('rateLimit — sliding-window approximation', () => {
  // start allineato al bucket boundary (multiplo di windowMs)
  const ALIGNED_START = 60_000 * 1_000;

  it('a inizio nuovo bucket: prev pesa 100% → score=prev+current (full overlap)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ALIGNED_START);

    const mw = rateLimit({ label: 'sw1', windowMs: 60_000, perTenant: 2 });
    const app = appWithAuth({ tenantId: 't' }, mw);

    // Riempio bucket precedente: 3 hit → 2 OK, 3° blocked. current.count = 3.
    expect((await app.request('/hit')).status).toBe(200);
    expect((await app.request('/hit')).status).toBe(200);
    expect((await app.request('/hit')).status).toBe(429);

    // Avanzo ESATTAMENTE 1 windowMs → siamo al primo ms del nuovo bucket
    // elapsedInCurrent=0 → prevWeight=1 → score = 3 (prev) * 1 + 1 (new) = 4 > 2 → BLOCKED
    vi.setSystemTime(ALIGNED_START + 60_000);
    expect((await app.request('/hit')).status).toBe(429);

    vi.useRealTimers();
  });

  it('dopo gap > 1 windowMs (es. 2 finestre) → prev azzerato', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ALIGNED_START);

    const mw = rateLimit({ label: 'sw-gap', windowMs: 60_000, perTenant: 1 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    await app.request('/hit');
    expect((await app.request('/hit')).status).toBe(429);

    // Salto di 2*windowMs + qualcosa → prev = stale, azzerato
    vi.setSystemTime(ALIGNED_START + 2 * 60_000 + 1000);
    expect((await app.request('/hit')).status).toBe(200);

    vi.useRealTimers();
  });

  it('weighted prev: a metà del nuovo bucket → prev pesa 50%', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ALIGNED_START);

    // perTenant=4. Riempio prev con 4 hit (tutti 200 fino a 4, 5° sarebbe 429).
    const mw = rateLimit({ label: 'sw-half', windowMs: 60_000, perTenant: 4 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    await app.request('/hit');
    await app.request('/hit');
    await app.request('/hit');
    await app.request('/hit'); // current.count=4 nel bucket originale

    // Avanzo a meta\` del bucket successivo (elapsedInCurrent=30000, weight=0.5)
    vi.setSystemTime(ALIGNED_START + 60_000 + 30_000);

    // Score con 1 hit nuovo: 4*0.5 + 1 = 3 (<=4) → OK
    expect((await app.request('/hit')).status).toBe(200);
    // Score con 2 hit nuovi: 4*0.5 + 2 = 4 (<=4) → OK
    expect((await app.request('/hit')).status).toBe(200);
    // Score con 3 hit nuovi: 4*0.5 + 3 = 5 (>4) → BLOCKED
    expect((await app.request('/hit')).status).toBe(429);

    vi.useRealTimers();
  });

  it('gap multi-window: prev azzerato anche su gap=10 windowMs', async () => {
    vi.useFakeTimers();
    const start = 3_000_000;
    vi.setSystemTime(start);

    const mw = rateLimit({ label: 'gp', windowMs: 60_000, perTenant: 1 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    await app.request('/hit');
    expect((await app.request('/hit')).status).toBe(429);

    // Salto di 10 windowMs
    vi.setSystemTime(start + 10 * 60_000);
    expect((await app.request('/hit')).status).toBe(200);

    vi.useRealTimers();
  });
});

describe('rateLimit — boundary exact', () => {
  it('perTenant=5: hit 1-5 → 200, hit 6 → 429 (boundary precisa)', async () => {
    const mw = rateLimit({ label: 'bd', windowMs: 60_000, perTenant: 5 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    for (let i = 1; i <= 5; i += 1) {
      const r = await app.request('/hit');
      expect(r.status).toBe(200);
    }
    expect((await app.request('/hit')).status).toBe(429);
  });

  it('perTenant=0 → SEMPRE 429 (limite degenere)', async () => {
    // Score sempre > 0 al primo hit → 429 SUBITO
    const mw = rateLimit({ label: 'z', windowMs: 60_000, perTenant: 0 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    expect((await app.request('/hit')).status).toBe(429);
  });
});

describe('rateLimit — llmRateLimit preset', () => {
  it('30 req/min per tenant, 10 req/min per user', async () => {
    const mw = llmRateLimit('preset-test');
    const app = appWithAuth({ tenantId: 't', userId: 'u' }, mw);
    // 10 hit user-level: 1-10 ok, 11 → 429 user
    for (let i = 1; i <= 10; i += 1) {
      expect((await app.request('/hit')).status).toBe(200);
    }
    const res = await app.request('/hit');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe('user');
  });

  it('30 tenant > 10 user: nuovo user resetta user counter ma tenant cumulativo', async () => {
    const mw = llmRateLimit('preset2');
    const aliceApp = appWithAuth({ tenantId: 't', userId: 'alice' }, mw);
    for (let i = 1; i <= 10; i += 1) await aliceApp.request('/hit');
    const aliceBlocked = await aliceApp.request('/hit');
    expect(((await aliceBlocked.json()) as { scope: string }).scope).toBe('user');

    // Bob arriva: tenant counter già a 10, può fare altri 10 prima del tenant 30
    const bobApp = appWithAuth({ tenantId: 't', userId: 'bob' }, mw);
    for (let i = 1; i <= 10; i += 1) {
      expect((await bobApp.request('/hit')).status).toBe(200);
    }
    // Bob 11° → user limit → 429
    expect((await bobApp.request('/hit')).status).toBe(429);
  });
});

describe('rateLimit — happy path (no limit configured)', () => {
  it('senza perTenant/perUser → bypass tutto, sempre 200', async () => {
    const mw = rateLimit({ label: 'no-limit', windowMs: 60_000 });
    const app = appWithAuth({ tenantId: 't' }, mw);
    for (let i = 0; i < 100; i += 1) {
      const r = await app.request('/hit');
      expect(r.status).toBe(200);
    }
  });
});
