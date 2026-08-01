/**
 * Test bug-bounty — twilio-guards (rate-limit anti toll-fraud).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkTwilioSendRateLimit, __testHooks__ } from './twilio-guards.js';

describe('checkTwilioSendRateLimit', () => {
  beforeEach(() => { __testHooks__.sendBuckets.clear(); });
  afterEach(() => { delete process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN; });

  it('consente fino al cap, poi blocca', () => {
    process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN = '3';
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(true);
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(true);
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(true);
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(false); // 4° oltre cap
  });

  it('🚨 isolamento PER-TENANT: il budget di un tenant non intacca l\'altro', () => {
    process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN = '1';
    expect(checkTwilioSendRateLimit('a').allowed).toBe(true);
    expect(checkTwilioSendRateLimit('a').allowed).toBe(false);
    expect(checkTwilioSendRateLimit('b').allowed).toBe(true); // b ha il suo budget
  });

  it('🚨 finestra scaduta → reset del bucket (GC su accesso)', () => {
    process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN = '1';
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(true);
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(false);
    // simulo finestra scaduta spostando windowStart indietro di >60s
    const b = __testHooks__.sendBuckets.get('t1');
    if (b) b.windowStart = Date.now() - 61_000;
    expect(checkTwilioSendRateLimit('t1').allowed).toBe(true);
  });

  it('🚨 env invalida/non-positiva → fallback default 30', () => {
    process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN = 'banana';
    expect(__testHooks__.maxSendsPerMin()).toBe(30);
    process.env.FLOWFORGE_TWILIO_MAX_SENDS_PER_MIN = '-5';
    expect(__testHooks__.maxSendsPerMin()).toBe(30);
  });
});
