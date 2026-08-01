/**
 * Test webhook-guards — bug-bounty + anti-regressione.
 *
 * Clock iniettato → determinismo su finestre/TTL. Copre rate-limit (finestra,
 * reset, soglia, disabilitato, NaN), idempotency (first/dup/scope/expiry/empty)
 * e bodyHash (determinismo + sensibilità). Le cache sono module-level → reset
 * in beforeEach per isolamento.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkWebhookRateLimit, __resetWebhookRateLimit,
  webhookIdempotencySeen, __resetWebhookIdempotency,
  bodyHash,
} from './webhook-guards.js';

beforeEach(() => {
  __resetWebhookRateLimit();
  __resetWebhookIdempotency();
});

describe('checkWebhookRateLimit', () => {
  it('limitPerMin<=0 → DISABILITATO (sempre allowed, remaining infinito)', () => {
    for (const lim of [0, -1]) {
      const r = checkWebhookRateLimit('k', lim, 1000);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('🚨 NaN limit → trattato come disabilitato (no crash, no blocco)', () => {
    expect(checkWebhookRateLimit('k', Number.NaN, 1000).allowed).toBe(true);
  });

  it('🚨 sotto soglia allowed con remaining decrescente; alla soglia+1 → 429 + Retry-After', () => {
    const now = 1_000_000;
    expect(checkWebhookRateLimit('k', 3, now)).toMatchObject({ allowed: true, remaining: 2 });
    expect(checkWebhookRateLimit('k', 3, now)).toMatchObject({ allowed: true, remaining: 1 });
    expect(checkWebhookRateLimit('k', 3, now)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = checkWebhookRateLimit('k', 3, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('🚨 la finestra si resetta dopo 60s → di nuovo allowed', () => {
    const t0 = 0;
    checkWebhookRateLimit('k', 1, t0);
    expect(checkWebhookRateLimit('k', 1, t0).allowed).toBe(false); // 2ª nella finestra
    expect(checkWebhookRateLimit('k', 1, t0 + 60_001).allowed).toBe(true); // finestra nuova
  });

  it('🚨 chiavi distinte (nodeId/IP) NON condividono la quota', () => {
    const now = 5000;
    expect(checkWebhookRateLimit('node:1.1.1.1', 1, now).allowed).toBe(true);
    expect(checkWebhookRateLimit('node:1.1.1.1', 1, now).allowed).toBe(false); // stessa chiave esaurita
    expect(checkWebhookRateLimit('node:2.2.2.2', 1, now).allowed).toBe(true);  // chiave diversa fresca
  });
});

describe('webhookIdempotencySeen', () => {
  it('chiave vuota → MAI duplicato (nessuna idempotenza richiesta)', () => {
    expect(webhookIdempotencySeen('node', '', 1000)).toBe(false);
    expect(webhookIdempotencySeen('node', '', 1000)).toBe(false);
  });

  it('🚨 prima volta false, stessa chiave entro TTL → true (duplicato)', () => {
    expect(webhookIdempotencySeen('node', 'idem-1', 1000)).toBe(false);
    expect(webhookIdempotencySeen('node', 'idem-1', 2000)).toBe(true);
  });

  it('🚨 chiave diversa o nodeId diverso → non duplicato (scope corretto)', () => {
    webhookIdempotencySeen('node', 'idem-1', 1000);
    expect(webhookIdempotencySeen('node', 'idem-2', 1000)).toBe(false);     // key diversa
    expect(webhookIdempotencySeen('node-X', 'idem-1', 1000)).toBe(false);   // nodeId diverso
  });

  it('🚨 dopo il TTL la chiave NON è più duplicato (scade)', () => {
    const ttl = 1000;
    expect(webhookIdempotencySeen('node', 'k', 0, ttl)).toBe(false);
    expect(webhookIdempotencySeen('node', 'k', 500, ttl)).toBe(true);   // entro TTL
    expect(webhookIdempotencySeen('node', 'k', 2000, ttl)).toBe(false); // oltre TTL → riemesso
  });
});

describe('bodyHash', () => {
  it('deterministico, esadecimale 64 char (SHA-256)', () => {
    const h = bodyHash('{"a":1}');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash('{"a":1}')).toBe(h);
  });

  it('🚨 body diverso → hash diverso (rileva manomissione/duplicati)', () => {
    expect(bodyHash('{"a":1}')).not.toBe(bodyHash('{"a":2}'));
    expect(bodyHash('')).toMatch(/^[0-9a-f]{64}$/); // body vuoto non crasha
  });
});
