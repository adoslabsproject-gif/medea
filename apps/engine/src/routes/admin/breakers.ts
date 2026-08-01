/**
 * Admin circuit breakers — list, reset, trip, simulate-failure.
 *
 * 5 endpoint:
 *   GET  /admin/breakers                              — list + counts per state
 *   POST /admin/breakers/:name/reset                  — force closed
 *   POST /admin/breakers/:name/trip                   — force open
 *   POST /admin/breakers/reset-all                    — reset all
 *   POST /admin/breakers/:name/simulate-failure       — inject synthetic failures
 *
 * Registry process-local; in distribuito ogni runtime ha i suoi breaker.
 * Per vista aggregata serve Redis pub/sub (out of scope v1).
 *
 * 2026-06-03: migrato a `@zeliai/shared` (consolidamento task #262 — la
 * versione runtime/lib/circuit-breaker.ts e\` stata rimossa).
 */

import type { Hono } from 'hono';
import { CircuitBreakerRegistry } from '@zeliai/shared';
import { AuditLogService } from '@/services/audit.service.js';

const audit = new AuditLogService();

function registry(): CircuitBreakerRegistry {
  return CircuitBreakerRegistry.getInstance();
}

export function registerBreakersRoutes(app: Hono): void {
  app.get('/admin/breakers', (c) => {
    const list = registry().list();
    return c.json({
      breakers: list,
      total: list.length,
      open: list.filter((b) => b.state === 'open').length,
      halfOpen: list.filter((b) => b.state === 'half_open').length,
    });
  });

  app.post('/admin/breakers/:name/reset', async (c) => {
    const auth = c.get('auth');
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'Bad request' }, 400);
    const breaker = registry().get(name);
    if (!breaker) return c.json({ error: `Breaker "${name}" not found` }, 404);
    breaker.forceState('closed', `admin reset by ${auth?.email ?? 'unknown'}`);
    await audit.append({
      tenantId: 'system', action: 'admin.breaker.reset',
      resourceType: 'breaker', resourceId: name,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { state: 'closed', actorEmail: auth?.email ?? null },
    });
    return c.json({ ok: true, name, state: 'closed' });
  });

  app.post('/admin/breakers/:name/trip', (c) => {
    const auth = c.get('auth');
    const name = c.req.param('name');
    if (!name) return Promise.resolve(c.json({ error: 'Bad request' }, 400));
    const breaker = registry().get(name);
    if (!breaker) return Promise.resolve(c.json({ error: `Breaker "${name}" not found` }, 404));
    breaker.forceState('open', `admin manual trip by ${auth?.email ?? 'unknown'}`);
    return Promise.resolve(c.json({ ok: true, name, state: 'open' }));
  });

  app.post('/admin/breakers/reset-all', async (c) => {
    const auth = c.get('auth');
    const n = registry().resetAll();
    await audit.append({
      tenantId: 'system', action: 'admin.breaker.reset_all',
      resourceType: 'breaker', resourceId: '*',
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { resetCount: n, actorEmail: auth?.email ?? null },
    });
    return Promise.resolve(c.json({ ok: true, resetCount: n }));
  });

  /**
   * POST /admin/breakers/:name/simulate-failure?count=N
   *
   * Inietta N failures sintetiche dentro un breaker SENZA toccare il
   * downstream provider — verifica che il breaker apra alla threshold
   * configurata in produzione, zero blast radius.
   */
  app.post('/admin/breakers/:name/simulate-failure', async (c) => {
    const auth = c.get('auth');
    const name = c.req.param('name');
    const count = Math.min(50, Math.max(1, Number(c.req.query('count') ?? '5')));
    if (!name) return c.json({ error: 'Bad request' }, 400);
    const breaker = registry().get(name);
    if (!breaker) return c.json({ error: `Breaker "${name}" not found` }, 404);
    const stateBefore = breaker.getState();
    breaker.simulateFailures(count, `simulated by ${auth?.email ?? 'admin'} for verification`);
    const stateAfter = breaker.getState();
    await audit.append({
      tenantId: 'system', action: 'admin.breaker.simulate_failure',
      resourceType: 'breaker', resourceId: name,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { count, stateBefore, stateAfter, actorEmail: auth?.email ?? null },
    });
    return c.json({ ok: true, name, count, stateBefore, stateAfter, stats: breaker.getStats() });
  });
}
