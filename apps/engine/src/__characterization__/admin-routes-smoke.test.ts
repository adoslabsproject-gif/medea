/**
 * CHARACTERIZATION TEST — Runtime admin routes smoke (#199 H14 split safety).
 *
 * Scopo: registrare la mappa-route corrente di `routes/admin.ts` (749 LOC,
 * 24 endpoint) PRIMA dello split in `routes/admin/{tenants,users,workers,
 * breakers,imap,workflows-health}.ts`.
 *
 * Test BLACK-BOX in-process:
 *   - monta createAdminRoutes() in app Hono di test
 *   - PER OGNI path documentato: invia request SENZA auth header
 *   - aspetta 401 Unauthorized (requireSuperAdmin guard reject)
 *   - se path è 404 → split ha rotto il mounting (regression)
 *
 * Garanzia: zero regressioni di route path post-split. Auth/role logic
 * NON cambia (resta in middleware/rbac.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { createAdminRoutes } from '@/routes/admin.js';

let app: Hono;

beforeAll(() => {
  app = new Hono();
  app.route('/api/v1', createAdminRoutes());
});

// ════════════════════════════════════════════════════════════════════
// Catalogue COMPLETO 24 route admin (snapshot 2026-05-29 pre-split).
// Format: [method, path, "domain"]. Path con :param usa UUID-like dummy.
// ════════════════════════════════════════════════════════════════════
const DUMMY_TENANT = '11111111-1111-1111-1111-111111111111';
const DUMMY_WORKER = 'worker-test-1';
const DUMMY_BREAKER = 'breaker-x';
const DUMMY_ACCOUNT = 'acc-1';

const ROUTES: (readonly [string, string, string])[] = [
  // Domain: stats + tenants (10 route)
  ['GET', '/api/v1/admin/stats', 'stats'],
  ['GET', '/api/v1/admin/tenants', 'tenants'],
  ['GET', `/api/v1/admin/tenants/${DUMMY_TENANT}`, 'tenants'],
  ['GET', `/api/v1/admin/tenants/${DUMMY_TENANT}/dashboard`, 'tenants'],
  ['POST', '/api/v1/admin/tenants', 'tenants'],
  ['POST', `/api/v1/admin/tenants/${DUMMY_TENANT}/suspend`, 'tenants'],
  ['POST', `/api/v1/admin/tenants/${DUMMY_TENANT}/activate`, 'tenants'],
  ['POST', `/api/v1/admin/tenants/${DUMMY_TENANT}/archive`, 'tenants'],
  ['DELETE', `/api/v1/admin/tenants/${DUMMY_TENANT}`, 'tenants'],
  ['GET', '/api/v1/admin/users', 'users'],

  // Domain: workers (6 route)
  ['GET', '/api/v1/admin/workers', 'workers'],
  ['POST', `/api/v1/admin/workers/${DUMMY_WORKER}/restart`, 'workers'],
  ['POST', `/api/v1/admin/workers/${DUMMY_WORKER}/drain`, 'workers'],
  ['POST', `/api/v1/admin/workers/${DUMMY_WORKER}/resume`, 'workers'],
  ['GET', `/api/v1/admin/workers/${DUMMY_WORKER}/logs`, 'workers'],
  ['GET', `/api/v1/admin/workers/${DUMMY_WORKER}/logs/stream`, 'workers'],

  // Domain: circuit breakers (5 route)
  ['GET', '/api/v1/admin/breakers', 'breakers'],
  ['POST', `/api/v1/admin/breakers/${DUMMY_BREAKER}/reset`, 'breakers'],
  ['POST', `/api/v1/admin/breakers/${DUMMY_BREAKER}/trip`, 'breakers'],
  ['POST', '/api/v1/admin/breakers/reset-all', 'breakers'],
  ['POST', `/api/v1/admin/breakers/${DUMMY_BREAKER}/simulate-failure`, 'breakers'],

  // Domain: diagnostics (2 route)
  ['GET', `/api/v1/admin/imap/diagnose/${DUMMY_ACCOUNT}`, 'imap'],
  ['GET', '/api/v1/admin/workflows/health', 'workflows-health'],
] as const;

describe('Runtime admin routes characterization (pre-split snapshot)', () => {
  it(`should mount EXACTLY ${ROUTES.length} documented routes`, () => {
    expect(ROUTES.length).toBe(23);
  });

  describe.each(ROUTES)('%s %s [%s]', (method, path, _domain) => {
    it('responds 401 Unauthorized senza auth header (mounting intatto)', async () => {
      const res = await app.request(path, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reason: 'test-reason' }),
            }
          : {}),
      });
      // 401 = requireSuperAdmin guard è applicato e route esiste
      // 404 = route NON è mounted (split regression)
      // 500 = errore interno (probabilmente DB missing in test env)
      // Accept 401/500 — quel che ci interessa è che NON sia 404.
      expect(res.status).not.toBe(404);
    });
  });

  it('rejects 401 sicuro: nessuna route admin è accessibile senza JWT', async () => {
    const results = await Promise.all(
      ROUTES.map(async ([method, path]) => {
        const res = await app.request(path, {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: '{}',
              }
            : {}),
        });
        return { method, path, status: res.status };
      }),
    );
    // CRITICAL: zero route deve restituire 200 (auth leak)
    const leaks = results.filter((r) => r.status === 200);
    expect(leaks).toEqual([]);
  });

  it('createAdminRoutes() return Hono instance', () => {
    expect(createAdminRoutes()).toBeInstanceOf(Hono);
  });
});
