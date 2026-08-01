/**
 * Tests per integrations-webhooks routes — focus security guards.
 *
 * Coverage chiave (Stripe path):
 *   - HMAC verify reject → 400
 *   - Missing secret → 503
 *   - SECURITY: Stripe Connect event quando STRIPE_CONNECT_ENABLED=false
 *     → 200 + ignored:true (no cross-tenant contamination)
 *   - Connect enabled → routes normalmente al tenant
 *   - Idempotent dedup via DB lookup
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { logger } from '@/lib/logger.js';

const m = vi.hoisted(() => ({
  sqliteRun: vi.fn(),
  sqliteGet: vi.fn(),
  eventBusEmit: vi.fn(),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => m.sqliteRun(...args),
        get: (...args: unknown[]) => m.sqliteGet(...args),
      }),
    },
  }),
}));

import { createIntegrationWebhookRoutes } from './integrations-webhooks.js';

const SECRET = 'whsec_test_secret_value_for_unit_tests';

function signStripeBody(rawBody: string, secret: string, ts?: number): string {
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${rawBody}`;
  const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_CONNECT_ENABLED;
  m.sqliteRun.mockReturnValue({ changes: 1 });
  m.sqliteGet.mockReturnValue(undefined);
  app = createIntegrationWebhookRoutes({
    emit: (...a: unknown[]) => m.eventBusEmit(...a),
  } as unknown as Parameters<typeof createIntegrationWebhookRoutes>[0]);
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_CONNECT_ENABLED;
});

describe('POST /stripe — config guards', () => {
  it('STRIPE_WEBHOOK_SECRET non set → 503', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await app.request('/stripe', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt_1', type: 'invoice.paid' }),
      headers: { 'stripe-signature': 'whatever' },
    });
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('non configurato');
  });

  it('missing stripe-signature header → 400', async () => {
    const res = await app.request('/stripe', {
      method: 'POST',
      body: JSON.stringify({ id: 'evt_1', type: 'invoice.paid' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('Stripe-Signature');
  });
});

describe('POST /stripe — HMAC verify', () => {
  it('signature INVALIDA → 400 + reason', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': 't=1234567890,v1=deadbeef' },
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; reason: string };
    expect(json.error).toContain('invalid signature');
    expect(json.reason).toBeTruthy();
  });

  it('signature VALIDA + JSON malformato → 400', async () => {
    const body = 'not-json';
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(400);
  });

  it('event senza id → 400', async () => {
    const body = JSON.stringify({ type: 'invoice.paid' });
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /stripe — Stripe Connect explicit guard', () => {
  it('SECURITY: event.account presente + STRIPE_CONNECT_ENABLED=false → 200 ignored', async () => {
    const body = JSON.stringify({
      id: 'evt_connect_1',
      type: 'invoice.paid',
      account: 'acct_1ABcdEfGhIjKlMn',
      data: { object: { metadata: {} } },
    });
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean; ignored: boolean; reason: string };
    expect(json.received).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe('connect_not_enabled');
    // Event bus NON emesso — no contaminazione cross-tenant
    expect(m.eventBusEmit).not.toHaveBeenCalled();
    // INSERT in webhook_events NON eseguito (skip prima del checkAndStoreEvent)
    expect(m.sqliteRun).not.toHaveBeenCalled();
  });

  it('SECURITY: Connect event loggato per audit downstream', async () => {
    const body = JSON.stringify({
      id: 'evt_connect_x',
      type: 'charge.refunded',
      account: 'acct_attacker',
    });
    const sig = signStripeBody(body, SECRET);
    await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: 'evt_connect_x',
        eventType: 'charge.refunded',
        connectAccount: 'acct_attacker',
      }),
      expect.stringContaining('Connect event ignored'),
    );
  });

  it('Connect ENABLED via env → routes normalmente (no ignored)', async () => {
    process.env.STRIPE_CONNECT_ENABLED = 'true';
    const body = JSON.stringify({
      id: 'evt_connect_ok',
      type: 'invoice.paid',
      account: 'acct_legitimate',
      data: { object: { metadata: { tenantId: 'ws-123' } } },
    });
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean; ignored?: boolean };
    expect(json.received).toBe(true);
    expect(json.ignored).toBeUndefined();
    expect(m.eventBusEmit).toHaveBeenCalled();
  });

  it('event SENZA account → routes normalmente platform (no Connect guard triggered)', async () => {
    const body = JSON.stringify({
      id: 'evt_platform_1',
      type: 'customer.subscription.updated',
      data: { object: { metadata: { tenantId: 'ws-abc' } } },
    });
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean; ignored?: boolean };
    expect(json.ignored).toBeUndefined();
    expect(m.eventBusEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.webhook.stripe',
        tenantId: 'ws-abc',
      }),
    );
  });
});

describe('POST /stripe — tenant attribution + dedup', () => {
  it('event senza metadata.tenantId + senza account → tenantId="global"', async () => {
    const body = JSON.stringify({
      id: 'evt_global_1',
      type: 'application_fee.created',
      data: { object: { metadata: {} } },
    });
    const sig = signStripeBody(body, SECRET);
    await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    const emitArg = m.eventBusEmit.mock.calls[0]?.[0] as { tenantId: string };
    expect(emitArg.tenantId).toBe('global');
  });

  it('dedup: alreadyProcessed → 200 dedup:true (no emit)', async () => {
    // INSERT OR IGNORE → changes=0 quando l'event_id esiste già (dedup hit)
    m.sqliteRun.mockReturnValue({ changes: 0 });
    const body = JSON.stringify({
      id: 'evt_dup_1',
      type: 'invoice.paid',
      data: { object: { metadata: { tenantId: 'ws-x' } } },
    });
    const sig = signStripeBody(body, SECRET);
    const res = await app.request('/stripe', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean; dedup: boolean };
    expect(json.dedup).toBe(true);
    expect(m.eventBusEmit).not.toHaveBeenCalled();
  });
});
