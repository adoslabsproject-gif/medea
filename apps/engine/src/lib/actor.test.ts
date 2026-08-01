/**
 * Tests per actor.ts — fix #194 H4 (audit attribution forgery).
 *
 * Invariante critica: header `x-actor-id` da client non-internal e` IGNORATO.
 */

import type { Context } from 'hono';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { getActorId, requireActorId, systemActor, SYSTEM_ACTOR_ID } from './actor.js';

function makeApp(authValue: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, authValue as never);
    return next();
  });
  app.get('/probe', (c) => {
    const id = getActorId(c);
    return c.json({ actorId: id });
  });
  return app;
}

describe('getActorId', () => {
  it('ritorna auth.userId quando autenticato regular', async () => {
    const app = makeApp({ userId: 'user-real-uuid', tenantId: 't1', role: 'editor', email: 'u@x.it' });
    const res = await app.request('/probe', {
      headers: { 'x-actor-id': 'SPOOFED-USER-ID' },
    });
    const body = (await res.json()) as { actorId: string };
    // CRITICAL: header x-actor-id IGNORATO per utente non-internal.
    expect(body.actorId).toBe('user-real-uuid');
    expect(body.actorId).not.toBe('SPOOFED-USER-ID');
  });

  it('ritorna null se nessuna sessione (auth=null)', async () => {
    const app = makeApp(null);
    const res = await app.request('/probe', {
      headers: { 'x-actor-id': 'attempted-spoof' },
    });
    const body = (await res.json()) as { actorId: string | null };
    expect(body.actorId).toBeNull();
  });

  it('S2S internal: accetta x-actor-id come actor delegato', async () => {
    const app = makeApp({ userId: 'internal', tenantId: 't1', role: 'owner', email: 'internal@flowforge' });
    const res = await app.request('/probe', {
      headers: { 'x-actor-id': 'delegated-by-cron-uuid' },
    });
    const body = (await res.json()) as { actorId: string };
    expect(body.actorId).toBe('delegated-by-cron-uuid');
  });

  it('S2S internal senza header → "internal" come actor', async () => {
    const app = makeApp({ userId: 'internal', tenantId: 't1', role: 'owner', email: 'internal@flowforge' });
    const res = await app.request('/probe');
    const body = (await res.json()) as { actorId: string };
    expect(body.actorId).toBe('internal');
  });

  it('S2S internal con x-actor-id vuoto/whitespace → "internal" fallback', async () => {
    const app = makeApp({ userId: 'internal', tenantId: 't1', role: 'owner', email: 'internal@flowforge' });
    const res = await app.request('/probe', { headers: { 'x-actor-id': '   ' } });
    const body = (await res.json()) as { actorId: string };
    expect(body.actorId).toBe('internal');
  });
});

describe('requireActorId', () => {
  it('throws se auth=null', () => {
    const c = { get: () => null, req: { header: () => undefined } } as unknown as Context;
    expect(() => requireActorId(c)).toThrow(/Actor ID not available/);
  });

  it('OK con auth presente', () => {
    const c = {
      get: () => ({ userId: 'u-1' }),
      req: { header: () => undefined },
    } as unknown as Context;
    expect(requireActorId(c)).toBe('u-1');
  });
});

describe('systemActor / SYSTEM_ACTOR_ID', () => {
  it('costante stabile per cron/sweeper attribution', () => {
    expect(SYSTEM_ACTOR_ID).toBe('system');
    expect(systemActor()).toBe('system');
  });
});
