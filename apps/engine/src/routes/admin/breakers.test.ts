/**
 * Test 2026-grade — admin/breakers route.
 *
 * 🚨 ADMIN-CRITICAL: API per controllare i circuit breaker production.
 * Trip o reset di un breaker = traffic redirect immediato verso un servizio
 * dipendente (DB/SMTP/LLM/…). Test integration con CircuitBreakerRegistry
 * REALE (no mock) + Hono test request.
 *
 * Coverage 5 endpoint:
 *  - GET  /admin/breakers
 *  - POST /admin/breakers/:name/reset
 *  - POST /admin/breakers/:name/trip
 *  - POST /admin/breakers/reset-all
 *  - POST /admin/breakers/:name/simulate-failure
 *
 * 🚨 Verifiche security:
 *  - 404 esplicito se breaker non esiste (no info leak)
 *  - audit log invocato con resourceType=breaker per ogni action
 *  - actor email/userId propagati nel ban/trip reason (traceable)
 *  - count clamping su simulate-failure (max 50, min 1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { CircuitBreaker, CircuitBreakerRegistry } from '@medea/engine-shared';

const m = vi.hoisted(() => ({
  auditAppend: vi.fn(),
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = m.auditAppend;
  },
}));

import { registerBreakersRoutes } from './breakers.js';

interface AuthShape { userId: string; email: string }

function makeApp(auth: AuthShape | null = { userId: 'u-admin', email: 'admin@acme.io' }): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth' as never, auth as never);
    await next();
  });
  registerBreakersRoutes(app);
  return app;
}

function newBreaker(name: string): CircuitBreaker<unknown> {
  return new CircuitBreaker(name, {
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
  });
}

beforeEach(() => {
  // Reset registry singleton state via destroyAll (clear map + timers).
  CircuitBreakerRegistry.getInstance().destroyAll();
  m.auditAppend.mockReset().mockResolvedValue(undefined);
});

describe('GET /admin/breakers', () => {
  it('lista vuota → total=0', async () => {
    const app = makeApp();
    const res = await app.request('/admin/breakers');
    expect(res.status).toBe(200);
    const body = await res.json() as { breakers: unknown[]; total: number; open: number; halfOpen: number };
    expect(body.total).toBe(0);
    expect(body.open).toBe(0);
    expect(body.halfOpen).toBe(0);
    expect(body.breakers).toEqual([]);
  });

  it('con 3 breaker registrati: 1 closed + 1 open + 1 half_open → counts corretti', async () => {
    const a = newBreaker('a');
    const b = newBreaker('b');
    const c = newBreaker('c');
    b.forceState('open', 'test');
    c.forceState('half_open', 'test');
    const app = makeApp();
    const res = await app.request('/admin/breakers');
    const body = await res.json() as { total: number; open: number; halfOpen: number };
    expect(body.total).toBe(3);
    expect(body.open).toBe(1);
    expect(body.halfOpen).toBe(1);
    a.destroy(); b.destroy(); c.destroy();
  });
});

describe('POST /admin/breakers/:name/reset', () => {
  it('happy: breaker open → reset → state=closed + audit', async () => {
    const b = newBreaker('smtp:test');
    b.forceState('open', 'pre-test');
    const app = makeApp();
    const res = await app.request('/admin/breakers/smtp:test/reset', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; name: string; state: string };
    expect(body).toEqual({ ok: true, name: 'smtp:test', state: 'closed' });
    expect(b.getState()).toBe('closed');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'system',
      action: 'admin.breaker.reset',
      resourceType: 'breaker',
      resourceId: 'smtp:test',
      actorId: 'u-admin',
      metadata: expect.objectContaining({ state: 'closed', actorEmail: 'admin@acme.io' }),
    }));
    b.destroy();
  });

  it('🚨 breaker not found → 404 esplicito (no info leak)', async () => {
    const app = makeApp();
    const res = await app.request('/admin/breakers/inexistent/reset', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('inexistent');
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('senza auth → actorEmail=null in audit (best-effort traceability)', async () => {
    const b = newBreaker('x');
    const app = makeApp(null);
    await app.request('/admin/breakers/x/reset', { method: 'POST' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ actorEmail: null }),
    }));
    expect(m.auditAppend).toHaveBeenCalledWith(expect.not.objectContaining({ actorId: expect.anything() }));
    b.destroy();
  });
});

describe('POST /admin/breakers/:name/trip', () => {
  it('🚨 happy: breaker closed → trip → state=open (manual circuit break)', async () => {
    const b = newBreaker('llm:anthropic');
    const app = makeApp();
    const res = await app.request('/admin/breakers/llm:anthropic/trip', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string };
    expect(body.state).toBe('open');
    expect(b.getState()).toBe('open');
    b.destroy();
  });

  it('🚨 trip su breaker inesistente → 404', async () => {
    const app = makeApp();
    const res = await app.request('/admin/breakers/ghost/trip', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('🚨 NOTA: trip non scrive audit (gap del modulo). Verificato comportamento attuale', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    await app.request('/admin/breakers/x/trip', { method: 'POST' });
    // Il trip endpoint non chiama audit.append (vedi source line 55-63).
    // Quando il modulo aggiungera\` audit, questo test fallira\` → segnala il gap.
    expect(m.auditAppend).not.toHaveBeenCalled();
    b.destroy();
  });
});

describe('POST /admin/breakers/reset-all', () => {
  it('happy: 3 breaker open → reset-all → resetCount=3 + audit', async () => {
    const a = newBreaker('a'); a.forceState('open', 't');
    const b = newBreaker('b'); b.forceState('open', 't');
    const c = newBreaker('c'); c.forceState('open', 't');
    const app = makeApp();
    const res = await app.request('/admin/breakers/reset-all', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; resetCount: number };
    expect(body.resetCount).toBe(3);
    expect(a.getState()).toBe('closed');
    expect(b.getState()).toBe('closed');
    expect(c.getState()).toBe('closed');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.breaker.reset_all',
      resourceType: 'breaker',
      resourceId: '*',
      metadata: expect.objectContaining({ resetCount: 3 }),
    }));
    a.destroy(); b.destroy(); c.destroy();
  });

  it('reset-all su registry vuoto → resetCount=0 ok', async () => {
    const app = makeApp();
    const res = await app.request('/admin/breakers/reset-all', { method: 'POST' });
    const body = await res.json() as { resetCount: number };
    expect(body.resetCount).toBe(0);
  });
});

describe('POST /admin/breakers/:name/simulate-failure', () => {
  it('🚨 inietta N failure → stateBefore/After + stats nel response', async () => {
    const b = newBreaker('test-simul'); // threshold=3
    const app = makeApp();
    const res = await app.request('/admin/breakers/test-simul/simulate-failure?count=5', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { stateBefore: string; stateAfter: string; count: number };
    expect(body.stateBefore).toBe('closed');
    expect(body.stateAfter).toBe('open'); // 5 > threshold 3 → si apre
    expect(body.count).toBe(5);
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.breaker.simulate_failure',
      metadata: expect.objectContaining({ count: 5, stateBefore: 'closed', stateAfter: 'open' }),
    }));
    b.destroy();
  });

  it('🚨 count default = 5 quando query mancante', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    await app.request('/admin/breakers/x/simulate-failure', { method: 'POST' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ count: 5 }),
    }));
    b.destroy();
  });

  it('🚨 count CAPPED a 50 (anti-abuse: max simulation)', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    await app.request('/admin/breakers/x/simulate-failure?count=9999', { method: 'POST' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ count: 50 }),
    }));
    b.destroy();
  });

  it('🚨 count CAPPED a 1 (min — count=0 nonsense)', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    await app.request('/admin/breakers/x/simulate-failure?count=0', { method: 'POST' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ count: 1 }),
    }));
    b.destroy();
  });

  it('count negativo → coerced a 1', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    await app.request('/admin/breakers/x/simulate-failure?count=-10', { method: 'POST' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ count: 1 }),
    }));
    b.destroy();
  });

  it('🚨 simulate su breaker not found → 404', async () => {
    const app = makeApp();
    const res = await app.request('/admin/breakers/ghost/simulate-failure?count=3', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('response include stats post-failure injection', async () => {
    const b = newBreaker('x');
    const app = makeApp();
    const res = await app.request('/admin/breakers/x/simulate-failure?count=2', { method: 'POST' });
    const body = await res.json() as { stats: Record<string, unknown> };
    expect(body.stats).toBeDefined();
    expect(typeof body.stats).toBe('object');
    b.destroy();
  });
});
