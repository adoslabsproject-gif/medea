/**
 * Batch scheduler — pure unit tests with fake clock + injected sleep.
 *
 * The whole point of extracting the scheduler is to make every timing
 * decision observable. These tests cover:
 *
 *  - steady-state interval respects ratePerHour
 *  - jitter stays within ±X% bounds
 *  - exponential backoff between attempts of the same item
 *  - non-retryable error bypasses retry budget
 *  - retry budget exhausted → ok=false, attempts=maxAttempts
 *  - budget exceeded → unsent items get requeued
 *  - aborted signal → remaining items requeued, in-flight finishes
 *  - effectiveRatePerHour reflects the real send pace
 *
 * @vitest-environment node
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved per estensione futura (interface compat)
import { describe, it, expect, vi } from 'vitest';
import { runBatch, type BatchItem, type AttemptResult } from './scheduler.js';

function items(n: number): BatchItem[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, overrides: { to: `r${i}@x.it` } }));
}

function fakeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: (ms: number): Promise<void> => { t += ms; return Promise.resolve(); },
  };
}

describe('runBatch — steady-state cadence', () => {
  it('paces between items at ~3600s / ratePerHour', async () => {
    const clk = fakeClock();
    const sleepCalls: number[] = [];
    const out = await runBatch({
      items: items(3),
      ratePerHour: 60,        // 1/min = 60_000ms interval
      jitter: 0,              // disable jitter for deterministic test
      now: clk.now,
      sleep: async (ms) => { sleepCalls.push(ms); return clk.sleep(ms); },
      attempt: async (item) => ({ ok: true, messageId: `mid-${item.index}`, sendId: `sid-${item.index}` }),
    });
    expect(out.stats.sent).toBe(3);
    expect(out.stats.failed).toBe(0);
    // 2 inter-item sleeps (no sleep after last)
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(60_000);
    expect(sleepCalls[1]).toBe(60_000);
  });

  it('applies jitter within bounds', async () => {
    const clk = fakeClock();
    const sleeps: number[] = [];
    await runBatch({
      items: items(4),
      ratePerHour: 60,
      jitter: 0.2,
      random: () => 0.5,        // deterministic random → delta = 0
      now: clk.now,
      sleep: async (ms) => { sleeps.push(ms); return clk.sleep(ms); },
      attempt: async (item) => ({ ok: true, messageId: 'x', sendId: `s-${item.index}` }),
    });
    // random()=0.5 → delta = (0.5*2-1)*span = 0 → identical baseline
    for (const s of sleeps) {
      expect(s).toBeGreaterThanOrEqual(60_000 * 0.8);
      expect(s).toBeLessThanOrEqual(60_000 * 1.2);
    }
  });
});

describe('runBatch — retry + backoff', () => {
  it('exponential backoff between retries of the same item', async () => {
    const clk = fakeClock();
    const sleeps: number[] = [];
    let firstItemAttempts = 0;
    await runBatch({
      items: items(1),
      ratePerHour: 60, jitter: 0, maxAttempts: 4, backoffBaseMs: 1_000,
      now: clk.now,
      sleep: async (ms) => { sleeps.push(ms); return clk.sleep(ms); },
      attempt: async (_item, attempt) => {
        firstItemAttempts = attempt;
        if (attempt < 4) return { ok: false, retry: true, error: '429 throttled' };
        return { ok: true, messageId: 'm', sendId: 's' };
      },
    });
    expect(firstItemAttempts).toBe(4);
    // 3 backoffs: 1_000, 2_000, 4_000 (no inter-item sleep — only 1 item)
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('non-retryable error skips remaining attempts', async () => {
    let attempts = 0;
    const out = await runBatch({
      items: items(1),
      ratePerHour: 60, jitter: 0, maxAttempts: 5,
      sleep: async () => undefined,
      attempt: async (_item, n) => {
        attempts = n;
        return { ok: false, retry: false, error: '400 bad recipient' };
      },
    });
    expect(attempts).toBe(1);
    expect(out.results[0]!.ok).toBe(false);
    expect(out.results[0]!.attempts).toBe(1);
    expect(out.results[0]!.error).toContain('400');
  });

  it('exhausted retry budget → ok=false, attempts=maxAttempts', async () => {
    const out = await runBatch({
      items: items(1),
      ratePerHour: 60, jitter: 0, maxAttempts: 3, backoffBaseMs: 100,
      sleep: async () => undefined,
      attempt: async (): Promise<AttemptResult> => ({ ok: false, retry: true, error: '429' }),
    });
    expect(out.results[0]!.attempts).toBe(3);
    expect(out.results[0]!.ok).toBe(false);
    expect(out.stats.failed).toBe(1);
  });
});

describe('runBatch — budget / abort', () => {
  it('budget exceeded → unsent items get requeued', async () => {
    const clk = fakeClock();
    const out = await runBatch({
      items: items(10),
      ratePerHour: 60, jitter: 0,
      budgetMs: 90_000,        // ~1.5 minutes → only 1-2 items fit
      now: clk.now,
      sleep: async (ms) => clk.sleep(ms),
      attempt: async (item) => ({ ok: true, messageId: 'x', sendId: `s-${item.index}` }),
    });
    expect(out.stats.sent).toBeLessThan(10);
    const requeued = out.results.filter((r) => r.requeued);
    expect(requeued.length).toBeGreaterThan(0);
    expect(out.stats.sent + requeued.length).toBe(10);
  });

  it('aborted signal → remaining items requeued', async () => {
    const ac = new AbortController();
    const clk = fakeClock();
    let processed = 0;
    const out = await runBatch({
      items: items(5),
      ratePerHour: 60, jitter: 0,
      signal: ac.signal,
      now: clk.now,
      sleep: async (ms) => clk.sleep(ms),
      attempt: async (item) => {
        processed += 1;
        if (processed === 2) ac.abort();
        return { ok: true, messageId: 'm', sendId: `s-${item.index}` };
      },
    });
    expect(out.stats.sent).toBe(2);
    const requeued = out.results.filter((r) => r.requeued);
    expect(requeued.length).toBe(3);
  });
});

describe('runBatch — effectiveRatePerHour', () => {
  it('reports the actual throughput', async () => {
    const clk = fakeClock();
    const out = await runBatch({
      items: items(6),
      ratePerHour: 3600,       // 1/sec → 1_000ms interval
      jitter: 0,
      now: clk.now,
      sleep: async (ms) => clk.sleep(ms),
      attempt: async (item) => ({ ok: true, messageId: 'm', sendId: `s-${item.index}` }),
    });
    expect(out.stats.sent).toBe(6);
    // 5 sleeps of 1s = 5000ms total; 6 sends → 6/5s = 4320/h. Allow 5%.
    expect(out.stats.effectiveRatePerHour).toBeGreaterThan(4000);
    expect(out.stats.effectiveRatePerHour).toBeLessThan(5000);
  });
});

describe('runBatch — attempt throws', () => {
  it('treats a thrown error as retryable', async () => {
    let n = 0;
    const out = await runBatch({
      items: items(1),
      ratePerHour: 60, jitter: 0, maxAttempts: 3, backoffBaseMs: 100,
      sleep: async () => undefined,
      attempt: async () => {
        n += 1;
        if (n < 3) throw new Error('TCP reset');
        return { ok: true, messageId: 'm', sendId: 's' };
      },
    });
    expect(out.stats.sent).toBe(1);
    expect(out.results[0]!.attempts).toBe(3);
  });
});
