import { describe, it, expect, vi } from 'vitest';
import { withRetry, computeDelay } from './retry.js';

describe('computeDelay', () => {
  it('returns base*factor^attempt capped by max', () => {
    expect(computeDelay(100, 2, 0, 10_000, 0)).toBe(100);
    expect(computeDelay(100, 2, 1, 10_000, 0)).toBe(200);
    expect(computeDelay(100, 2, 5, 10_000, 0)).toBe(3200);
    expect(computeDelay(100, 2, 20, 1000, 0)).toBe(1000); // capped
  });

  it('applies jitter in range ±jitter%', () => {
    const samples = Array.from({ length: 50 }, () => computeDelay(1000, 1, 0, 10_000, 0.5));
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(500);
      expect(s).toBeLessThanOrEqual(1500);
    }
    // Must not all be equal (would mean no jitter)
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(5);
  });
});

describe('withRetry', () => {
  it('succeeds on first try, no sleep', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls += 1;
      return 42;
    });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries up to count times then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { count: 3, initialDelayMs: 1 },
    );
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws last error if all retries exhausted', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${String(calls)}`);
        },
        { count: 2, initialDelayMs: 1 },
      ),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('shouldRetry predicate skips retry if false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('not-retryable');
        },
        { count: 3, initialDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('not-retryable');
    expect(calls).toBe(1);
  });

  it('shouldRetryOnResult triggers retry on success value', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls += 1;
        return calls === 1 ? 'transient' : 'final';
      },
      {
        count: 2,
        initialDelayMs: 1,
        shouldRetryOnResult: (v) => v === 'transient',
      },
    );
    expect(r).toBe('final');
    expect(calls).toBe(2);
  });

  it('onRetry hook called with attempt + delay + err', async () => {
    const hook = vi.fn();
    try {
      await withRetry(
        async () => {
          throw new Error('e');
        },
        {
          count: 2,
          initialDelayMs: 1,
          onRetry: hook,
        },
      );
    } catch {
      /* expected */
    }
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, err: expect.any(Error) });
  });

  it('aborts mid-sleep when signal triggered', async () => {
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort();
    }, 20);
    await expect(
      withRetry(
        async () => {
          throw new Error('e');
        },
        {
          count: 5,
          initialDelayMs: 200,
          signal: ctrl.signal,
        },
      ),
    ).rejects.toThrow(/Aborted|e/);
  });

  it('handles count=0 (single attempt only)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('once');
        },
        { count: 0 },
      ),
    ).rejects.toThrow('once');
    expect(calls).toBe(1);
  });
});
