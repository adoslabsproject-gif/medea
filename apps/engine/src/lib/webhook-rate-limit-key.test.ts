import { describe, it, expect } from 'vitest';
import { publicWebhookRateLimitKey } from './webhook-rate-limit-key.js';

describe('🔒 publicWebhookRateLimitKey — rate-limit per (webhook, IP)', () => {
  it('chiave = primo segmento (webhook id) + IP', () => {
    expect(publicWebhookRateLimitKey('/webhooks/wf-123/tok', '1.2.3.4')).toBe('wf-123:1.2.3.4');
    expect(publicWebhookRateLimitKey('/webhooks/stripe', '9.9.9.9')).toBe('stripe:9.9.9.9');
    expect(publicWebhookRateLimitKey('/forms/form-1', '5.5.5.5')).toBe('form-1:5.5.5.5');
  });

  it('stesso IP su webhook DIVERSI → chiavi DIVERSE (budget indipendente, no cap globale per-IP)', () => {
    expect(publicWebhookRateLimitKey('/webhooks/wf-a/t', '1.1.1.1'))
      .not.toBe(publicWebhookRateLimitKey('/webhooks/wf-b/t', '1.1.1.1'));
  });

  it('stesso webhook da IP DIVERSI → chiavi DIVERSE (provider legit indipendenti)', () => {
    expect(publicWebhookRateLimitKey('/webhooks/wf-a/t', '1.1.1.1'))
      .not.toBe(publicWebhookRateLimitKey('/webhooks/wf-a/t', '2.2.2.2'));
  });

  it('stesso (webhook, IP) → chiave STABILE (così il bucket accumula)', () => {
    expect(publicWebhookRateLimitKey('/webhooks/wf-a/t1', '1.1.1.1'))
      .toBe(publicWebhookRateLimitKey('/webhooks/wf-a/t1', '1.1.1.1'));
  });

  it('path senza segmento → "unknown" (mai chiave vuota che collassa tutto su un bucket)', () => {
    expect(publicWebhookRateLimitKey('/webhooks/', '1.1.1.1')).toBe('unknown:1.1.1.1');
  });
});
