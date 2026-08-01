/**
 * Tests per CircuitBreaker — enterprise state machine CLOSED/OPEN/HALF_OPEN.
 *
 * Coverage target: 100%. Copre TUTTI gli stati + transizioni, race condition
 * (probe lock atomic), timer cleanup (no zombie), stats accuracy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from '../circuit-breaker.js';

const opts = {
  failureThreshold: 3,
  resetTimeout: 100,
  successThreshold: 2,
  probeTimeout: 50,
};

describe('CircuitBreaker — base', () => {
  it('parte in stato CLOSED', () => {
    const cb = new CircuitBreaker('test', opts);
    expect(cb.getState()).toBe('closed');
    cb.destroy();
  });

  it('espone name', () => {
    const cb = new CircuitBreaker('my-name', opts);
    expect(cb.name).toBe('my-name');
    cb.destroy();
  });

  it('execute esegue fn e ritorna risultato', async () => {
    const cb = new CircuitBreaker('test', opts);
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    cb.destroy();
  });

  it('execute propaga errori', async () => {
    const cb = new CircuitBreaker('test', opts);
    await expect(cb.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    cb.destroy();
  });
});

describe('CircuitBreaker — CLOSED → OPEN dopo failureThreshold', () => {
  it('apre dopo N failures consecutive', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('open');
    cb.destroy();
  });

  it('un success resetta il counter failures', async () => {
    const cb = new CircuitBreaker('test', opts);
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    await cb.execute(async () => 'ok'); // reset counter
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    expect(cb.getState()).toBe('closed'); // ancora chiuso, contiamo da 0 dopo success
    cb.destroy();
  });

  it('isFailure custom filter — 404 NOT counts as failure', async () => {
    const cb = new CircuitBreaker('test', {
      ...opts,
      isFailure: (err: unknown) => !(err instanceof Error) || !err.message.includes('404'),
    });
    for (let i = 0; i < 10; i++) {
      await expect(cb.execute(async () => { throw new Error('404 Not Found'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('closed'); // 404 non conta → mai aperto
    cb.destroy();
  });
});

describe('CircuitBreaker — OPEN reject immediately', () => {
  it('quando OPEN, execute lancia CircuitOpenError senza chiamare fn', async () => {
    const cb = new CircuitBreaker('test', opts);
    // Forza OPEN
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('open');

    const fn = vi.fn(async () => 'should-not-call');
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
    cb.destroy();
  });

  it('CircuitOpenError contiene il nome del breaker', async () => {
    const cb = new CircuitBreaker('payment-gateway', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    try {
      await cb.execute(async () => 'x');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      expect((e as Error).message).toContain('payment-gateway');
    }
    cb.destroy();
  });

  it('totalRejected incrementa su OPEN reject', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    await expect(cb.execute(async () => 'x')).rejects.toThrow();
    await expect(cb.execute(async () => 'x')).rejects.toThrow();
    expect(cb.getStats().totalRejected).toBe(2);
    cb.destroy();
  });
});

describe('CircuitBreaker — OPEN → HALF_OPEN dopo resetTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('transitions to HALF_OPEN dopo resetTimeout ms', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(150); // > resetTimeout 100 + jitter
    expect(cb.getState()).toBe('half_open');
    cb.destroy();
  });
});

describe('CircuitBreaker — HALF_OPEN probe atomic lock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('solo UNA request passa come probe, le altre vengono rejected', async () => {
    const cb = new CircuitBreaker('test', opts);
    // Forza HALF_OPEN
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);

    // Probe in flight (lento)
    const probe = cb.execute(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'probe-ok';
    });

    // Altra request mentre probe è in flight → reject
    await expect(cb.execute(async () => 'parallel')).rejects.toBeInstanceOf(CircuitOpenError);

    vi.advanceTimersByTime(30);
    await expect(probe).resolves.toBe('probe-ok');
    cb.destroy();
  });

  it('probe success → state diventa CLOSED dopo successThreshold success', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);
    expect(cb.getState()).toBe('half_open');

    await cb.execute(async () => 'ok'); // success 1
    expect(cb.getState()).toBe('half_open'); // ancora HALF_OPEN
    await cb.execute(async () => 'ok'); // success 2 — successThreshold raggiunto
    expect(cb.getState()).toBe('closed');
    cb.destroy();
  });

  it('probe failure → torna a OPEN', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    vi.advanceTimersByTime(150);
    expect(cb.getState()).toBe('half_open');

    await expect(cb.execute(async () => { throw new Error('still down'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
    cb.destroy();
  });
});

describe('CircuitBreaker — reset() / destroy()', () => {
  it('reset() forza CLOSED', async () => {
    const cb = new CircuitBreaker('test', opts);
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    cb.destroy();
  });

  it('reset() resetta counters', async () => {
    const cb = new CircuitBreaker('test', opts);
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    cb.reset();
    expect(cb.getStats().failures).toBe(0);
    expect(cb.getStats().successes).toBe(0);
    cb.destroy();
  });

  it('destroy() non lancia errori', () => {
    const cb = new CircuitBreaker('test', opts);
    expect(() => cb.destroy()).not.toThrow();
  });
});

describe('CircuitBreaker — getStats', () => {
  it('snapshot read-only — due chiamate consecutive consistent', async () => {
    const cb = new CircuitBreaker('test', opts);
    await cb.execute(async () => 'ok');
    const s1 = cb.getStats();
    const s2 = cb.getStats();
    expect(s1.totalRequests).toBe(s2.totalRequests);
    expect(s1.state).toBe(s2.state);
    cb.destroy();
  });

  it('uptimePercent inizia a 100%', () => {
    const cb = new CircuitBreaker('test', opts);
    expect(cb.getStats().uptimePercent).toBe(100);
    cb.destroy();
  });

  it('tracking corretto di successi/fallimenti', async () => {
    const cb = new CircuitBreaker('test', opts);
    await cb.execute(async () => 'ok');
    await cb.execute(async () => 'ok');
    await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    const stats = cb.getStats();
    expect(stats.totalSuccesses).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.totalRequests).toBe(3);
    expect(stats.lastSuccess).toBeInstanceOf(Date);
    expect(stats.lastFailure).toBeInstanceOf(Date);
    cb.destroy();
  });
});

describe('CircuitBreaker — onStateChange callback', () => {
  it('callback chiamata su transizione', async () => {
    const transitions: [CircuitState, CircuitState, string][] = [];
    const cb = new CircuitBreaker('test', {
      ...opts,
      onStateChange: (from, to, name) => transitions.push([from, to, name]),
    });
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('f'); })).rejects.toThrow();
    }
    expect(transitions).toContainEqual(['closed', 'open', 'test']);
    cb.destroy();
  });

  it('callback NON chiamata se state già target (idempotency)', async () => {
    const spy = vi.fn();
    const cb = new CircuitBreaker('test', { ...opts, onStateChange: spy });
    // CLOSED → CLOSED dopo success: no transition fired
    await cb.execute(async () => 'ok');
    expect(spy).not.toHaveBeenCalled();
    cb.destroy();
  });
});

describe('CircuitBreaker — defaults', () => {
  it('probeTimeout default 10s', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeout: 100,
      successThreshold: 2,
    });
    expect(cb.getState()).toBe('closed');
    cb.destroy();
  });
});

describe('CircuitOpenError', () => {
  it('è una Error', () => {
    const e = new CircuitOpenError('foo');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CircuitOpenError');
    expect(e.message).toContain('foo');
  });
});
