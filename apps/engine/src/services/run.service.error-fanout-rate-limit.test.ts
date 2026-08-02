/**
 * AUDIT FIX WE-14 (2026-06-09) — REGRESSION GUARD, aggiornato 2026-06-19 (review on_error).
 *
 * Il cap leaky-bucket e il fan-out error-workflow sono stati RELOCATI dalla
 * finalizzazione del run (fire-and-forget) alla pipeline OUTBOX DUREVOLE:
 *   - rate-limit: services/error-outbox/fanout-rate-limit.ts (comportamento IDENTICO).
 *   - fan-out: dispatchato dal worker outbox (at-least-once), enqueued ATOMICAMENTE
 *     col mark-errored in run.service (#3).
 *
 * Questo file resta la guard WE-14: (1) il cap funziona ancora (behavioral sul modulo),
 * (2) run.service NON ri-introduce il fire-and-forget e usa l'enqueue atomico,
 * (3) l'anti-loop è preservato.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runServiceSource = readFileSync(join(__dirname, 'run.service.ts'), 'utf-8');

describe('🚨 [REGRESSION WE-14] error-workflow fan-out rate-limit (relocato in outbox)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('🚨 source-inspection: il fan-out è DUREVOLE/atomico, NON più fire-and-forget', () => {
    // Le notifiche d'errore sono enqueued atomicamente col mark-errored.
    expect(runServiceSource).toMatch(/buildErrorOutboxEvents/);
    expect(runServiceSource).toMatch(/enqueueErrorOutbox/);
    expect(runServiceSource).toMatch(/sqlite\.transaction/);
    // Il vecchio fire-and-forget NON deve tornare.
    expect(runServiceSource).not.toMatch(/notifyFailure/);
    expect(runServiceSource).not.toMatch(/void \(async \(\): Promise<void> => \{/);
  });

  it('🚨 source-inspection: anti-loop preservato (mai fanout per run error-handler)', () => {
    expect(runServiceSource).toMatch(/input\.triggerType !== 'error-handler'/);
  });

  it('🚨 source-inspection: il rate-limit è stato relocato fuori da run.service', () => {
    expect(runServiceSource).not.toMatch(/function checkErrorFanoutRateLimit/);
    const rlSource = readFileSync(join(__dirname, 'error-outbox', 'fanout-rate-limit.ts'), 'utf-8');
    expect(rlSource).toMatch(/function checkErrorFanoutRateLimit\(sourceWorkflowId: string\): boolean/);
    expect(rlSource).toMatch(/MEDEA_ERROR_FANOUT_MAX_PER_MIN/);
  });

  it('🚨 behavioral: bucket consente fino a max (60), blocca al 61°', async () => {
    const { __testHooks__ } = await import('./error-outbox/fanout-rate-limit.js');
    __testHooks__.errorFanoutBuckets.clear();
    const wfId = 'wf-test-bucket-limit';
    for (let i = 0; i < 60; i++) {
      expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(true);
    }
    expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(false);
    expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(false);
  });

  it('🚨 behavioral: bucket reset dopo 60s window', async () => {
    const { __testHooks__ } = await import('./error-outbox/fanout-rate-limit.js');
    __testHooks__.errorFanoutBuckets.clear();
    const wfId = 'wf-test-bucket-reset';
    for (let i = 0; i < 60; i++) __testHooks__.checkErrorFanoutRateLimit(wfId);
    expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(true);
  });

  it('🚨 behavioral: workflow distinti hanno bucket separati', async () => {
    const { __testHooks__ } = await import('./error-outbox/fanout-rate-limit.js');
    __testHooks__.errorFanoutBuckets.clear();
    for (let i = 0; i < 60; i++) __testHooks__.checkErrorFanoutRateLimit('wf-A');
    expect(__testHooks__.checkErrorFanoutRateLimit('wf-A')).toBe(false);
    expect(__testHooks__.checkErrorFanoutRateLimit('wf-B')).toBe(true);
    expect(__testHooks__.checkErrorFanoutRateLimit('wf-B')).toBe(true);
  });

  it('🚨 behavioral: env override MEDEA_ERROR_FANOUT_MAX_PER_MIN abbassa il cap', async () => {
    const { __testHooks__ } = await import('./error-outbox/fanout-rate-limit.js');
    __testHooks__.errorFanoutBuckets.clear();
    const oldEnv = process.env.MEDEA_ERROR_FANOUT_MAX_PER_MIN;
    process.env.MEDEA_ERROR_FANOUT_MAX_PER_MIN = '3';
    try {
      const wfId = 'wf-test-env-cap';
      expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(true);
      expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(true);
      expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(true);
      expect(__testHooks__.checkErrorFanoutRateLimit(wfId)).toBe(false);
    } finally {
      if (oldEnv === undefined) delete process.env.MEDEA_ERROR_FANOUT_MAX_PER_MIN;
      else process.env.MEDEA_ERROR_FANOUT_MAX_PER_MIN = oldEnv;
    }
  });
});
