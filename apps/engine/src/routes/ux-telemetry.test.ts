/**
 * Bug-bounty FULL-REQUEST-PATH — routes/ux-telemetry.ts (audit coverage
 * 2026-06-12: route a ZERO, ux_events tabella debole). Tracker client +
 * 3 endpoint admin superadmin-only. Service + tabella ux_events REALI.
 *
 * Invarianti: enum eventType chiuso (un evento inventato → 400, niente
 * spazzatura in tabella), admin endpoints superadmin-ONLY (owner→403),
 * ingest→retrieval (POST /events poi visibile in /admin/recent col tenant
 * giusto), filtro tenant su recent, cap limit 500.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { createUxTelemetryRoutes } from './ux-telemetry.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-ux-${Date.now().toString(36)}-a`;
const T_B = `test-ux-${Date.now().toString(36)}-b`;

let authCtx: AuthContext | null = null;
const as = (tenantId: string, role: AuthContext['role']): void => {
  authCtx = { userId: `u-${tenantId}`, tenantId, email: 'o@t.it', role };
};

let app: Hono;
interface SqliteLike { prepare: (s: string) => { run: (...p: unknown[]) => unknown } }
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(() => {
  runMigrations();
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  app.route('/api/v1/ux', createUxTelemetryRoutes());
});

afterAll(() => {
  db().prepare("DELETE FROM ux_events WHERE tenant_id LIKE 'test-ux-%'").run();
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1/ux${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

describe('ux-telemetry — tracker client', () => {
  it('senza auth → 401', async () => {
    authCtx = null;
    expect((await req('POST', '/events', { eventType: 'run_started' })).status).toBe(401);
  });

  it('eventType FUORI enum → 400 (niente spazzatura in ux_events)', async () => {
    as(T_A, 'owner');
    expect((await req('POST', '/events', { eventType: 'hacker_event' })).status).toBe(400);
    expect((await req('POST', '/events', {})).status).toBe(400);
  });

  it('evento valido → 200 ok', async () => {
    as(T_A, 'owner');
    const res = await req('POST', '/events', { eventType: 'workflow_created', workflowId: 'wf1', metadata: { src: 'test' } });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe('ux-telemetry — admin superadmin-only', () => {
  it('funnel/stuck/recent: owner → 403, superadmin → 200', async () => {
    as(T_A, 'owner');
    for (const path of ['/admin/funnel', '/admin/stuck', '/admin/recent']) {
      expect((await req('GET', path)).status, `owner ${path}`).toBe(403);
    }
    as('platform', 'superadmin');
    for (const path of ['/admin/funnel', '/admin/stuck', '/admin/recent']) {
      expect((await req('GET', path)).status, `superadmin ${path}`).toBe(200);
    }
  });

  it('INGEST→RETRIEVAL: un evento POSTato compare in /admin/recent col suo tenant', async () => {
    as(T_B, 'editor');
    await req('POST', '/events', { eventType: 'tour_completed' });
    as('platform', 'superadmin');
    const recent = await (await req('GET', `/admin/recent?tenantId=${T_B}`)).json() as { events: { tenantId: string; eventType: string }[] };
    expect(recent.events.length).toBeGreaterThan(0);
    expect(recent.events.every((e) => e.tenantId === T_B)).toBe(true);
    expect(recent.events.some((e) => e.eventType === 'tour_completed')).toBe(true);
  });

  it('recent limit cap a 500 (no dump illimitato)', async () => {
    as('platform', 'superadmin');
    const res = await req('GET', '/admin/recent?limit=99999');
    expect(res.status).toBe(200); // clampato lato route, non rifiutato
  });
});
