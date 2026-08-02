/**
 * Integrazione FULL request-path — rate-limit per (webhook, IP) sulle route
 * pubbliche /webhooks/* e /forms/* (audit #3 / gap #8 masterplan).
 *
 * Il test della key (webhook-rate-limit-key.test.ts) prova la STRINGA; questo
 * prova il COMPORTAMENTO end-to-end col vero middleware `rateLimit`: flood da
 * un IP → 429 oltre il cap, bucket INDIPENDENTI per IP e per webhook, e il
 * bypass /webhooks/c/* (che ha già il suo bucket).
 *
 * Replica IL wiring di server.ts (publicHookLimiter + webhookKeyFrom) — se un
 * domani il cap o la key cambiassero in server.ts senza aggiornare qui, la
 * divergenza va riallineata; il valore è provare che il middleware fa davvero
 * quello che la chiave promette.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { rateLimit, _resetRateLimitState } from '@/middleware/rate-limit.js';
import { publicWebhookRateLimitKey } from '@/lib/webhook-rate-limit-key.js';

const CAP = 120;

function buildApp(): Hono {
  const app = new Hono();
  const webhookKeyFrom = (c: Context): string => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    return publicWebhookRateLimitKey(c.req.path, ip);
  };
  const publicHookLimiter = rateLimit({
    label: 'webhook_public',
    windowMs: 60_000,
    perTenant: CAP,
    tenantFrom: webhookKeyFrom,
  });
  app.use('/webhooks/*', async (c, next) => {
    if (c.req.path.startsWith('/webhooks/c/')) return next();
    return publicHookLimiter(c, next);
  });
  app.use('/forms/*', publicHookLimiter);
  app.all('/webhooks/*', (c) => c.json({ ok: true }));
  app.all('/forms/*', (c) => c.json({ ok: true }));
  return app;
}

async function hit(app: Hono, path: string, ip: string): Promise<number> {
  const res = await app.request(path, { headers: { 'cf-connecting-ip': ip } });
  return res.status;
}

beforeEach(() => {
  _resetRateLimitState();
});

describe('rate-limit webhook — flood da un IP → 429', () => {
  it('le prime CAP richieste passano, la CAP+1 → 429', async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i += 1) {
      expect(await hit(app, '/webhooks/wf-1/tok', '1.1.1.1')).toBe(200);
    }
    expect(await hit(app, '/webhooks/wf-1/tok', '1.1.1.1')).toBe(429);
  });

  it('il 429 ha body strutturato rate_limit_exceeded', async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i += 1) await hit(app, '/webhooks/wf-x/t', '9.9.9.9');
    const res = await app.request('/webhooks/wf-x/t', {
      headers: { 'cf-connecting-ip': '9.9.9.9' },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  });
});

describe('rate-limit webhook — bucket indipendenti', () => {
  it("🚨 IP diversi sullo stesso webhook → indipendenti (un provider non affama l'altro)", async () => {
    const app = buildApp();
    // IP A esaurisce il suo bucket
    for (let i = 0; i < CAP; i += 1) await hit(app, '/webhooks/wf-1/t', '1.1.1.1');
    expect(await hit(app, '/webhooks/wf-1/t', '1.1.1.1')).toBe(429);
    // IP B sullo STESSO webhook deve ancora passare
    expect(await hit(app, '/webhooks/wf-1/t', '2.2.2.2')).toBe(200);
  });

  it('🚨 webhook diversi dallo stesso IP → indipendenti (no cap globale per-IP)', async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i += 1) await hit(app, '/webhooks/wf-a/t', '1.1.1.1');
    expect(await hit(app, '/webhooks/wf-a/t', '1.1.1.1')).toBe(429);
    // stesso IP, webhook diverso → bucket nuovo
    expect(await hit(app, '/webhooks/wf-b/t', '1.1.1.1')).toBe(200);
  });

  it('/forms/* condivide lo stesso limiter (form trigger protetto)', async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i += 1) {
      expect(await hit(app, '/forms/form-1', '1.1.1.1')).toBe(200);
    }
    expect(await hit(app, '/forms/form-1', '1.1.1.1')).toBe(429);
  });
});

describe('rate-limit webhook — /webhooks/c/* bypassato (ha il suo bucket)', () => {
  it('/webhooks/c/* NON è limitato da publicHookLimiter (mai 429 da questo middleware)', async () => {
    const app = buildApp();
    // CAP+50 richieste: se il limiter pubblico le contasse, scatterebbe 429.
    for (let i = 0; i < CAP + 50; i += 1) {
      expect(await hit(app, '/webhooks/c/stream/x', '1.1.1.1')).toBe(200);
    }
  });
});
