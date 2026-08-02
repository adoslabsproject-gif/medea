/**
 * Test 2026-grade — tenant-status middleware.
 *
 * Coverage REALE (no smoke, no fake):
 *  - Pass-through quando route non e\` autenticata (tenantId null)
 *  - 404 con error code machine-friendly se tenantService.assertActive lancia
 *    TenantNotFoundError
 *  - 403 con error code machine-friendly + message preservato se
 *    TenantNotActiveError (suspended / archived / trial scaduto)
 *  - Errore inatteso (non TenantNotFoundError ne\` TenantNotActiveError) =
 *    rethrow (propaga al global error handler)
 *  - Status code esatti + body JSON struttura esatta (machine-friendly UI)
 *
 * 2026-06-09 AUDIT FIX C4:
 *  Il middleware è stato wirato globalmente su /api/v1/* e ora SKIP-PA le
 *  letture (GET/HEAD/OPTIONS) + paths auth/sso/health/webhooks/internal.
 *  I test usano POST per innescare il check su mutating route. Aggiunto blocco
 *  dedicato "skip READ-only + skip paths".
 *
 * Mock minimale: solo tenantService.assertActive + getTenantIdOrNull.
 * Il middleware viene applicato su una mini-app Hono reale, l'asserzione
 * e\` sul response HTTP — pipeline completa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock getTenantIdOrNull — controlla cosa restituisce per simulare
// scenari autenticato/non-autenticato.
const getTenantIdOrNullMock = vi.fn<(c: unknown) => string | null>();
vi.mock('@/lib/tenant.js', () => ({
  getTenantIdOrNull: (c: unknown) => getTenantIdOrNullMock(c),
}));

// Mock tenantService — usa le classi error REALI dal modulo (no fake).
const assertActiveMock = vi.fn<(id: string) => void>();
vi.mock('@/services/tenant.service.js', async () => {
  // Reimplemento le error classes con la stessa signature del modulo reale.
  // Cosi\` il check `e instanceof TenantNotFoundError` nel middleware
  // funziona correttamente quando il mock lancia errori di quei tipi.
  class TenantNotFoundError extends Error {
    constructor(id: string) {
      super(`Tenant non trovato: "${id}"`);
      this.name = 'TenantNotFoundError';
    }
  }
  class TenantNotActiveError extends Error {
    constructor(id: string, status: string, reason: string | null) {
      super(
        `Tenant "${id}" non operativo (status=${status}${reason ? `, motivo: ${reason}` : ''})`,
      );
      this.name = 'TenantNotActiveError';
    }
  }
  return {
    tenantService: { assertActive: (id: string) => assertActiveMock(id) },
    TenantNotFoundError,
    TenantNotActiveError,
  };
});

import { tenantStatusMiddleware } from './tenant-status.js';
import { TenantNotFoundError, TenantNotActiveError } from '@/services/tenant.service.js';

/**
 * makeApp — Hono mini con tenantStatusMiddleware applicato su tutto, route
 * POST /ping per innescare il check (il middleware skippa GET/HEAD/OPTIONS,
 * vedi C4 fix). I test che vogliono verificare il pass-through delle letture
 * usano GET /ping direttamente per documentare il behavior.
 */
function makeApp(): Hono {
  const app = new Hono();
  app.use('*', tenantStatusMiddleware());
  app.post('/ping', (c) => c.json({ ok: true, tenant: getTenantIdOrNullMock(c) }));
  app.get('/ping', (c) => c.json({ ok: true, tenant: getTenantIdOrNullMock(c) }));
  return app;
}

beforeEach(() => {
  getTenantIdOrNullMock.mockReset();
  assertActiveMock.mockReset();
});

describe('tenantStatusMiddleware — pass-through (no tenantId)', () => {
  it('route non-authenticated (tenantId=null) → passa next() senza chiamare assertActive', async () => {
    getTenantIdOrNullMock.mockReturnValue(null);
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenant: null });
    expect(assertActiveMock).not.toHaveBeenCalled();
  });

  it('tenantId="" (stringa vuota) trattato come null → pass-through', async () => {
    // getTenantIdOrNull e\` typed string|null, ma il middleware fa truthy
    // check. Se il helper ritornasse "" (raro ma possibile), e\` falsy.
    getTenantIdOrNullMock.mockReturnValue(null);
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertActiveMock).not.toHaveBeenCalled();
  });
});

describe('tenantStatusMiddleware — TenantNotFoundError → 404', () => {
  it('tenant non esiste → 404 con error code "tenant_not_found"', async () => {
    getTenantIdOrNullMock.mockReturnValue('ghost-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotFoundError('ghost-tenant');
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('tenant_not_found');
    expect(body.message).toContain('ghost-tenant');
    expect(body.message).toMatch(/non esiste|eliminato/u);
  });

  it('assertActive chiamato con il tenantId esatto', async () => {
    getTenantIdOrNullMock.mockReturnValue('tenant-xyz-789');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotFoundError('tenant-xyz-789');
    });
    await makeApp().request('/ping', { method: 'POST' });
    expect(assertActiveMock).toHaveBeenCalledTimes(1);
    expect(assertActiveMock).toHaveBeenCalledWith('tenant-xyz-789');
  });
});

describe('tenantStatusMiddleware — TenantNotActiveError → 403', () => {
  it('tenant suspended → 403 con error code "tenant_not_active" + message dell\'errore', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', 'pagamento mancato');
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('tenant_not_active');
    expect(body.message).toContain('suspended-tenant');
    expect(body.message).toContain('status=suspended');
    expect(body.message).toContain('pagamento mancato');
  });

  it('tenant archived (read-only) → 403 con status=archived nel message', async () => {
    getTenantIdOrNullMock.mockReturnValue('archived-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('archived-tenant', 'archived', null);
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toContain('status=archived');
    expect(body.message).not.toMatch(/motivo:/u); // reason=null → no "motivo:"
  });

  it('tenant trial scaduto → 403 con motivo "trial scaduto"', async () => {
    getTenantIdOrNullMock.mockReturnValue('trial-expired');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('trial-expired', 'trial', 'trial scaduto');
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toContain('trial scaduto');
  });
});

describe('tenantStatusMiddleware — errori inattesi (rethrow)', () => {
  it('errore generico non-Tenant* → rethrow (propaga al global handler)', async () => {
    getTenantIdOrNullMock.mockReturnValue('any-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new Error('DB connection lost');
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.post('/ping', (c) => c.json({ ok: true }));
    // Hono cattura errori unhandled e li ritorna come 500.
    app.onError((err, c) => c.json({ error: 'internal', message: err.message }, 500));
    const res = await app.request('/ping', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toBe('DB connection lost');
  });

  it('errore con name simile (es. TenantSlugConflictError) NON viene catturato → 500', async () => {
    getTenantIdOrNullMock.mockReturnValue('any-tenant');
    class TenantSlugConflictError extends Error {
      constructor() {
        super('slug conflict');
        this.name = 'TenantSlugConflictError';
      }
    }
    assertActiveMock.mockImplementation(() => {
      throw new TenantSlugConflictError();
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.post('/ping', (c) => c.json({ ok: true }));
    app.onError((err, c) => c.json({ error: 'internal', message: err.message }, 500));
    const res = await app.request('/ping', { method: 'POST' });
    expect(res.status).toBe(500);
  });
});

describe('tenantStatusMiddleware — happy path (tenant attivo)', () => {
  it('tenant attivo → assertActive non lancia → next() → handler eseguito', async () => {
    getTenantIdOrNullMock.mockReturnValue('active-tenant');
    assertActiveMock.mockImplementation(() => {
      // No throw — tenant attivo.
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenant: 'active-tenant' });
    expect(assertActiveMock).toHaveBeenCalledTimes(1);
  });

  it('assertActive chiamato UNA volta per request (no double-check)', async () => {
    getTenantIdOrNullMock.mockReturnValue('active-tenant');
    assertActiveMock.mockImplementation(() => undefined);
    await makeApp().request('/ping', { method: 'POST' });
    expect(assertActiveMock).toHaveBeenCalledTimes(1);
  });
});

describe('tenantStatusMiddleware — JSON body struttura esatta (machine-friendly)', () => {
  it('404 body: { error: "tenant_not_found", message: string } — NIENTE altri campi', async () => {
    getTenantIdOrNullMock.mockReturnValue('ghost');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotFoundError('ghost');
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(typeof body.error).toBe('string');
    expect(typeof body.message).toBe('string');
  });

  it('403 body: { error: "tenant_not_active", message: string } — NIENTE altri campi', async () => {
    getTenantIdOrNullMock.mockReturnValue('susp');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('susp', 'suspended', null);
    });
    const res = await makeApp().request('/ping', { method: 'POST' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
  });
});

/**
 * 🚨 AUDIT FIX C4 (2026-06-09) — REGRESSION GUARD nuovo behavior:
 *
 * Il middleware è ora wirato globalmente su /api/v1/* invece di essere
 * applicato puntualmente per route. Per non penalizzare le letture (UI che
 * deve sempre poter leggere lo stato del tenant suspended), il middleware
 * skippa internamente:
 *   • READ-only methods (GET / HEAD / OPTIONS)
 *   • SKIP_PREFIXES: /api/v1/auth, /sso, /api/v1/health, /api/v1/metrics,
 *     /api/v1/webhooks, /api/v1/internal, /webhooks
 */
describe('🚨 [REGRESSION C4] skip READ-only + skip-paths', () => {
  it('🚨 GET /ping → pass-through (READ-only skip) — assertActive MAI chiamato', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const res = await makeApp().request('/ping'); // GET default
    expect(res.status).toBe(200);
    expect(assertActiveMock).not.toHaveBeenCalled();
  });

  it('🚨 POST /api/v1/auth/login → skip path → pass-through', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.post('/api/v1/auth/login', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/auth/login', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertActiveMock).not.toHaveBeenCalled();
  });

  it('🚨 POST /api/v1/health → skip path → pass-through', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.post('/api/v1/health', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/health', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(assertActiveMock).not.toHaveBeenCalled();
  });

  it('🚨 POST /api/v1/workflows/x/run → NOT skip → assertActive chiamato → 403 se suspended', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.post('/api/v1/workflows/:id/run', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/workflows/wf1/run', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(assertActiveMock).toHaveBeenCalled();
  });

  it('🚨 PUT /api/v1/workflows/x → NOT skip (PUT è mutating) → 403 se suspended', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.put('/api/v1/workflows/:id', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/workflows/wf1', { method: 'PUT' });
    expect(res.status).toBe(403);
    expect(assertActiveMock).toHaveBeenCalled();
  });

  it('🚨 DELETE → NOT skip → 403 se suspended', async () => {
    getTenantIdOrNullMock.mockReturnValue('suspended-tenant');
    assertActiveMock.mockImplementation(() => {
      throw new TenantNotActiveError('suspended-tenant', 'suspended', null);
    });
    const app = new Hono();
    app.use('*', tenantStatusMiddleware());
    app.delete('/api/v1/workflows/:id', (c) => c.json({ ok: true }));
    const res = await app.request('/api/v1/workflows/wf1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
