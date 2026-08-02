/**
 * Tests 2026-grade per LlmQueue — fair scheduling per-user + priority.
 *
 * Coverage:
 *  - enqueue + run with concurrency cap
 *  - priority ordering: chat (0) > workflow (1) > background (2)
 *  - per-user depth limit (anti-flood)
 *  - total depth limit (backpressure)
 *  - QueueBackpressureError carries Retry-After
 *  - FIFO within same priority
 *  - failure propagation
 *  - stats() snapshot accuracy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

import { LlmQueue, QueueBackpressureError } from './llm-queue.service.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  /* fresh queue per test in each it() */
});

describe('LlmQueue basics', () => {
  it('enqueue → resolve con il risultato del runner', async () => {
    const q = new LlmQueue();
    const result = await q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => 'ok',
    });
    expect(result).toBe('ok');
  });

  it('runner failure → reject propagato', async () => {
    const q = new LlmQueue();
    await expect(
      q.enqueue({
        userId: 'u-1',
        source: 'chat',
        runner: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('concurrency cap 5 → 6° job aspetta che uno si liberi', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 6 }, () => deferred<string>());
    const results = blockers.map((b, i) =>
      q.enqueue({ userId: `u-${i.toString()}`, source: 'workflow', runner: () => b.promise }),
    );
    // Wait microtask flush
    await new Promise((r) => setTimeout(r, 5));
    const s = q.stats();
    expect(s.active).toBe(5);
    expect(s.queued).toBe(1);
    blockers[0]!.resolve('a');
    await results[0];
    await new Promise((r) => setTimeout(r, 5));
    expect(q.stats().active).toBe(5);
    for (const b of blockers.slice(1)) b.resolve('x');
    await Promise.all(results);
  });
});

describe('LlmQueue priority ordering', () => {
  it('chat (P0) viene PRIMA di workflow (P1) anche se workflow arriva prima', async () => {
    const q = new LlmQueue();
    // Saturate active slots with blockers to force queue accumulation.
    const blockers = Array.from({ length: 5 }, () => deferred<string>());
    const initialResults = blockers.map((b) =>
      q.enqueue({ userId: 'filler', source: 'workflow', runner: () => b.promise }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(q.stats().active).toBe(5);

    // Now enqueue: workflow first, then chat. Chat should run first when slot frees.
    const order: string[] = [];
    const workflowResult = q.enqueue({
      userId: 'u-1',
      source: 'workflow',
      runner: async () => {
        order.push('workflow');
        return 'wf';
      },
    });
    const chatResult = q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => {
        order.push('chat');
        return 'chat';
      },
    });

    // Free one slot to allow next dequeue.
    blockers[0]!.resolve('x');
    await new Promise((r) => setTimeout(r, 5));
    // Free remaining
    for (const b of blockers.slice(1)) b.resolve('x');
    await Promise.all([workflowResult, chatResult, ...initialResults]);

    // Chat must come before workflow despite being enqueued AFTER.
    expect(order.indexOf('chat')).toBeLessThan(order.indexOf('workflow'));
  });

  it('FIFO within same priority (chat → chat → chat = enqueue order)', async () => {
    const q = new LlmQueue();
    // Saturate
    const fillerBlockers = Array.from({ length: 5 }, () => deferred<string>());
    fillerBlockers.forEach((b) => {
      void q.enqueue({ userId: 'filler', source: 'chat', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    const r1 = q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => {
        order.push('a');
        return 'a';
      },
    });
    const r2 = q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => {
        order.push('b');
        return 'b';
      },
    });
    const r3 = q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => {
        order.push('c');
        return 'c';
      },
    });

    for (const b of fillerBlockers) b.resolve('x');
    await Promise.all([r1, r2, r3]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('LlmQueue backpressure', () => {
  it('per-user depth limit "pro" 25 → 26° enqueue throws QueueBackpressureError', async () => {
    const q = new LlmQueue();
    // Default planTier = 'pro' → quota 25
    const blockers = Array.from({ length: 25 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({ userId: 'spammer', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(() => q.enqueue({ userId: 'spammer', source: 'chat', runner: async () => 'x' })).toThrow(
      QueueBackpressureError,
    );
    // Cleanup
    for (const b of blockers) b.resolve('x');
  });

  it('other user NON impatta dal limit di "spammer"', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 25 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({ userId: 'spammer', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));
    // u-other ok
    const result = q.enqueue({ userId: 'u-other', source: 'chat', runner: async () => 'fine' });
    // Cleanup spammer to free workers
    blockers[0]!.resolve('x');
    await new Promise((r) => setTimeout(r, 5));
    for (const b of blockers.slice(1)) b.resolve('x');
    expect(await result).toBe('fine');
  });

  it('QueueBackpressureError porta retryAfterMs in [2000, 3500]', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 25 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({ userId: 'spammer', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));
    try {
      void q.enqueue({ userId: 'spammer', source: 'chat', runner: async () => 'x' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(QueueBackpressureError);
      const err = e as QueueBackpressureError;
      expect(err.retryAfterMs).toBeGreaterThanOrEqual(2000);
      expect(err.retryAfterMs).toBeLessThanOrEqual(3500);
    }
    for (const b of blockers) b.resolve('x');
  });
});

describe('LlmQueue plan-weighted priority (paying customers privilege)', () => {
  it('enterprise + workflow scavalca free + workflow anche se free arriva prima', async () => {
    const q = new LlmQueue();
    // Saturate
    const fillers = Array.from({ length: 5 }, () => deferred<string>());
    fillers.forEach((b) => {
      void q.enqueue({ userId: 'filler', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    const freeJob = q.enqueue({
      userId: 'u-free',
      source: 'workflow',
      planTier: 'free',
      runner: async () => {
        order.push('free');
        return 'f';
      },
    });
    const entJob = q.enqueue({
      userId: 'u-ent',
      source: 'workflow',
      planTier: 'enterprise',
      runner: async () => {
        order.push('enterprise');
        return 'e';
      },
    });

    // Free ALL slots together so dispatcher picks by priority, not by order resolved.
    for (const b of fillers) b.resolve('x');
    await Promise.all([freeJob, entJob]);
    expect(order).toEqual(['enterprise', 'free']);
  });

  it('enterprise + background (eff -2+2=0) batte free + chat (eff 0+2=2)', async () => {
    const q = new LlmQueue();
    const fillers = Array.from({ length: 5 }, () => deferred<string>());
    fillers.forEach((b) => {
      void q.enqueue({ userId: 'filler', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    const freeChat = q.enqueue({
      userId: 'u-free',
      source: 'chat',
      planTier: 'free',
      runner: async () => {
        order.push('free-chat');
        return 'fc';
      },
    });
    const entBg = q.enqueue({
      userId: 'u-ent',
      source: 'background',
      planTier: 'enterprise',
      runner: async () => {
        order.push('ent-bg');
        return 'eb';
      },
    });

    for (const b of fillers) b.resolve('x');
    await Promise.all([freeChat, entBg]);
    expect(order).toEqual(['ent-bg', 'free-chat']);
  });

  it('pro (default) + chat (eff 0) batte starter + chat (eff 1)', async () => {
    const q = new LlmQueue();
    const fillers = Array.from({ length: 5 }, () => deferred<string>());
    fillers.forEach((b) => {
      void q.enqueue({ userId: 'filler', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    const starterJob = q.enqueue({
      userId: 'u-starter',
      source: 'chat',
      planTier: 'starter',
      runner: async () => {
        order.push('starter');
        return 's';
      },
    });
    const proJob = q.enqueue({
      userId: 'u-pro',
      source: 'chat', // no planTier → default 'pro'
      runner: async () => {
        order.push('pro');
        return 'p';
      },
    });

    for (const b of fillers) b.resolve('x');
    await Promise.all([starterJob, proJob]);
    expect(order).toEqual(['pro', 'starter']);
  });

  it('per-tier quota: free → 8 max, 9° throw QueueBackpressureError', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 8 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({
        userId: 'free-user',
        source: 'workflow',
        planTier: 'free',
        runner: () => b.promise,
      });
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(() =>
      q.enqueue({
        userId: 'free-user',
        source: 'workflow',
        planTier: 'free',
        runner: async () => 'x',
      }),
    ).toThrow(QueueBackpressureError);

    for (const b of blockers) b.resolve('x');
  });

  it('per-tier quota: enterprise → 50 max, 9° OK (free non lo sarebbe)', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 8 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({
        userId: 'ent-user',
        source: 'workflow',
        planTier: 'enterprise',
        runner: () => b.promise,
      });
    });
    await new Promise((r) => setTimeout(r, 5));

    // 9° per enterprise va ancora bene (quota 50, free sarebbe stato bloccato)
    expect(() =>
      q.enqueue({
        userId: 'ent-user',
        source: 'workflow',
        planTier: 'enterprise',
        runner: async () => 'x',
      }),
    ).not.toThrow();

    for (const b of blockers) b.resolve('x');
  });

  it('per-tier quota: team → 35 max, 36° throw', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 35 }, () => deferred<string>());
    blockers.forEach((b) => {
      void q.enqueue({
        userId: 'team-user',
        source: 'workflow',
        planTier: 'team',
        runner: () => b.promise,
      });
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(() =>
      q.enqueue({
        userId: 'team-user',
        source: 'workflow',
        planTier: 'team',
        runner: async () => 'x',
      }),
    ).toThrow(QueueBackpressureError);

    for (const b of blockers) b.resolve('x');
  });

  it('planTier omesso → default "pro" applicato (modifier 0)', async () => {
    const q = new LlmQueue();
    const fillers = Array.from({ length: 5 }, () => deferred<string>());
    fillers.forEach((b) => {
      void q.enqueue({ userId: 'filler', source: 'workflow', runner: () => b.promise });
    });
    await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    // No planTier passed → default 'pro' modifier 0 → effective = base
    // chat (0) deve battere workflow (1) come prima
    const wfJob = q.enqueue({
      userId: 'u-1',
      source: 'workflow',
      runner: async () => {
        order.push('wf');
        return 'w';
      },
    });
    const chatJob = q.enqueue({
      userId: 'u-1',
      source: 'chat',
      runner: async () => {
        order.push('chat');
        return 'c';
      },
    });

    for (const b of fillers) b.resolve('x');
    await Promise.all([wfJob, chatJob]);
    expect(order).toEqual(['chat', 'wf']);
  });
});

describe('LlmQueue stats', () => {
  it('stats() ritorna snapshot accurato', async () => {
    const q = new LlmQueue();
    const blockers = Array.from({ length: 7 }, () => deferred<string>());
    blockers.forEach((b, i) => {
      void q.enqueue({
        userId: `u-${i.toString()}`,
        source: i < 3 ? 'chat' : i < 5 ? 'workflow' : 'background',
        runner: () => b.promise,
      });
    });
    await new Promise((r) => setTimeout(r, 5));
    const s = q.stats();
    expect(s.active).toBe(5);
    expect(s.queued).toBe(2);
    expect(s.capacityTotal).toBe(100);
    expect(s.capacityPerUser).toBe(20);
    expect(s.concurrencyMax).toBe(5);
    // Cleanup
    for (const b of blockers) b.resolve('x');
  });
});
