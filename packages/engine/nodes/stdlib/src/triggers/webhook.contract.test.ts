/**
 * Contract test ANTI-DRIFT — trigger_webhook.
 *
 * Storia (review nodi #2): la description prometteva dedup Idempotency-Key,
 * rate-limit configurabile, audit body_hash (claim fantasma) → rimossi, poi
 * RIPRISTINATI IMPLEMENTANDOLI (webhook-guards.ts: rate-limit fixed-window +
 * idempotency LRU + bodyHash SHA-256, cablati in webhooks.ts). Ora il guard
 * pretende il CONTRARIO: questi claim DEVONO esserci e avere il loro config field
 * reale. Restano FUORI i nomi mai esistiti (fire-and-forget/sync-200) e la feature
 * NON implementata (50MB stream-to-disk).
 */
import { describe, it, expect } from 'vitest';
import { webhookTriggerNode } from './webhook.js';

const def = webhookTriggerNode.def;
const description = def.description;

function selectOptions(key: string): readonly string[] {
  const field = def.configFields.find((f) => f.key === key);
  return field?.type === 'select' ? field.options : [];
}

const responseModes = selectOptions('responseMode');
const authModes = selectOptions('authMode');

describe('trigger_webhook — contract description ⊆ schema (anti-aspirazionale)', () => {
  it('🚨 i responseMode citati ⊆ enum reale; niente nomi fantasma (fire-and-forget/sync-200)', () => {
    expect(responseModes).toEqual(['immediate', 'wait-for-workflow', 'use-respond-node']);
    for (const m of responseModes) {
      expect(description, `responseMode '${m}' non documentato`).toContain(m);
    }
    expect(description).not.toMatch(/fire-and-forget/i);
    expect(description).not.toMatch(/sync-200/i);
  });

  it('🚨 gli authMode citati ⊆ enum reale (nomi esatti, non "bearer" generico)', () => {
    expect(authModes).toEqual(['none', 'header-token', 'basic-auth', 'hmac-signature', 'jwt']);
    for (const m of authModes) {
      if (m === 'none') continue;
      expect(description, `authMode '${m}' non documentato`).toContain(m);
    }
  });

  it('🚨 feature ORA implementate sono documentate (Idempotency-Key, rate-limit, audit SHA-256) + anti-replay', () => {
    expect(description).toMatch(/Idempotency-Key/i);
    expect(description).toMatch(/rate.?limit/i);
    expect(description).toMatch(/SHA-256/i);   // audit on-hit = digest del body, non payload
    expect(description).toMatch(/anti-replay/i); // meccanismo HMAC preesistente resta
  });

  it('🚨 il rate-limit ha il suo config field reale (rateLimitPerMin), default disabilitato', () => {
    const field = def.configFields.find((f) => f.key === 'rateLimitPerMin');
    expect(field, 'configField rateLimitPerMin mancante').toBeDefined();
    expect(field?.type).toBe('number');
    expect(field?.defaultValue).toBe('0'); // 0 = nessun limite
  });

  it('🚨 NON promette la feature NON implementata (50MB stream-to-disk) né nomi mai esistiti', () => {
    expect(description).not.toMatch(/stream(ing)? (a|to).disk/i);
    expect(description).not.toMatch(/50\s*MB/i);
    expect(description).not.toMatch(/body_hash/i); // usiamo "SHA-256 del body", non il nome fantasma
  });
});
