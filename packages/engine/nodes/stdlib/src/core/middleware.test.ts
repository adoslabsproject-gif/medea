import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  compose,
  wrap,
  withTelemetry,
  withIdempotency,
  withHostBreaker,
  withErrorMapping,
  withAbortGuard,
  httpMiddlewarePreset,
  type Middleware,
} from './middleware.js';
import { InMemoryIdempotencyStore } from './idempotency.js';
import { clearBreakerRegistry } from './host-circuit-breaker.js';
import { NodeError, AbortedError, CircuitOpenError, ValidationError } from './node-error.js';
import { registerTracer, unregisterTracer } from './telemetry.js';
import type { NodeExecutor, NodeExecutionContext } from '../types.js';

const makeCtx = (over: Partial<NodeExecutionContext> = {}): NodeExecutionContext => ({
  tenantId: 't1',
  workflowId: 'w1',
  runId: 'r1',
  nodeId: 'n1',
  secrets: {},
  ...over,
});

const dummyExec: NodeExecutor = async () => ({ output: 'inner', durationMs: 1 });

describe('compose / wrap', () => {
  it('runs middlewares in onion order: A-before → B-before → B-after → A-after', async () => {
    const order: string[] = [];
    const mw = (label: string): Middleware => (next) => async (...args) => {
      order.push(`${label}-before`);
      const r = await next(...args);
      order.push(`${label}-after`);
      return r;
    };
    await compose([mw('A'), mw('B')])(dummyExec)({}, null, makeCtx());
    expect(order).toEqual(['A-before', 'B-before', 'B-after', 'A-after']);
  });

  it('empty middleware list returns executor as-is', async () => {
    const r = await compose([])(dummyExec)({}, null, makeCtx());
    expect(r.output).toBe('inner');
  });

  it('wrap is alias for compose+invoke', async () => {
    const order: string[] = [];
    const mw: Middleware = (next) => async (...args) => {
      order.push('wrapped');
      return next(...args);
    };
    const wrapped = wrap(dummyExec, [mw]);
    await wrapped({}, null, makeCtx());
    expect(order).toEqual(['wrapped']);
  });
});

describe('withTelemetry', () => {
  afterEach(() => { unregisterTracer(); });

  it('passes through when no tracer is registered', async () => {
    const exec = wrap(dummyExec, [withTelemetry({ spanName: 'x' })]);
    const r = await exec({}, null, makeCtx());
    expect(r.output).toBe('inner');
  });

  it('uses tracer.startActiveSpan with given name + attrs', async () => {
    const mockSpan = mkMockSpan();
    const tracer = { startActiveSpan: vi.fn((_n, fn) => fn(mockSpan)) };
    registerTracer(tracer);
    const exec = wrap(dummyExec, [withTelemetry({ spanName: 'mynode', attrs: { vendor: 'x' } })]);
    await exec({ a: 1 }, null, makeCtx({ defId: 'd1' }));
    expect(tracer.startActiveSpan).toHaveBeenCalledWith('mynode', expect.any(Function));
    expect(mockSpan.setAttributes).toHaveBeenCalled();
    const callAttrs = mockSpan.setAttributes.mock.calls[0]?.[0];
    expect(callAttrs).toMatchObject({
      'flowforge.tenant_id': 't1',
      'flowforge.run_id': 'r1',
      'flowforge.node_id': 'n1',
      'flowforge.def_id': 'd1',
      'vendor': 'x',
    });
  });

  it('dynamicAttrs computed from config + ctx', async () => {
    const mockSpan = mkMockSpan();
    const tracer = { startActiveSpan: vi.fn((_n, fn) => fn(mockSpan)) };
    registerTracer(tracer);
    const exec = wrap(dummyExec, [withTelemetry({
      spanName: 'x',
      dynamicAttrs: (cfg) => ({ 'cfg.url': String(cfg.url) }),
    })]);
    await exec({ url: 'https://x.com' }, null, makeCtx());
    expect(mockSpan.setAttributes.mock.calls[0]?.[0]['cfg.url']).toBe('https://x.com');
  });
});

describe('withIdempotency', () => {
  let store: InMemoryIdempotencyStore;
  beforeEach(() => { store = new InMemoryIdempotencyStore(); });

  it('first call executes, second call returns cached', async () => {
    let runCount = 0;
    const exec: NodeExecutor = async () => {
      runCount += 1;
      return { output: { count: runCount }, durationMs: 5 };
    };
    const wrapped = wrap(exec, [withIdempotency({ store })]);
    const r1 = await wrapped({}, null, makeCtx());
    const r2 = await wrapped({}, null, makeCtx());
    expect(runCount).toBe(1);
    expect(r1.output).toEqual({ count: 1 });
    expect(r2.output).toEqual({ count: 1 });
    expect(r2.warnings).toContain('idempotency:cached');
    expect(r2.durationMs).toBe(0);
  });

  it('different runId allows re-execution', async () => {
    let runCount = 0;
    const exec: NodeExecutor = async () => { runCount += 1; return { output: 'x', durationMs: 1 }; };
    const wrapped = wrap(exec, [withIdempotency({ store })]);
    await wrapped({}, null, makeCtx({ runId: 'r1' }));
    await wrapped({}, null, makeCtx({ runId: 'r2' }));
    expect(runCount).toBe(2);
  });

  it('throw releases the lock (next attempt re-runs)', async () => {
    let attempt = 0;
    const exec: NodeExecutor = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('first-fails');
      return { output: 'ok', durationMs: 1 };
    };
    const wrapped = wrap(exec, [withIdempotency({ store })]);
    await expect(wrapped({}, null, makeCtx())).rejects.toThrow('first-fails');
    const r = await wrapped({}, null, makeCtx());
    expect(r.output).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('subKey distinguishes item-level idempotency', async () => {
    let runCount = 0;
    const exec: NodeExecutor = async () => { runCount += 1; return { output: 'x', durationMs: 1 }; };
    const wrapped = wrap(exec, [withIdempotency({ store, subKey: (_c, input) => String(input) })]);
    await wrapped({}, 'item-a', makeCtx());
    await wrapped({}, 'item-b', makeCtx());
    await wrapped({}, 'item-a', makeCtx());
    expect(runCount).toBe(2); // a + b run; a-retry hits cache
  });
});

describe('withHostBreaker', () => {
  beforeEach(() => { clearBreakerRegistry(); });

  it('passes through when urlFrom returns undefined (no host bucket)', async () => {
    const exec: NodeExecutor = async () => ({ output: 'no-url', durationMs: 1 });
    const wrapped = wrap(exec, [withHostBreaker({ urlFrom: () => undefined })]);
    const r = await wrapped({}, null, makeCtx());
    expect(r.output).toBe('no-url');
  });

  it('after 5 failures throws CircuitOpenError', async () => {
    const exec: NodeExecutor = async () => { throw new Error('upstream-fail'); };
    const wrapped = wrap(exec, [withHostBreaker({ urlFrom: () => 'https://flaky.example/x' })]);
    for (let i = 0; i < 5; i += 1) {
      await expect(wrapped({}, null, makeCtx())).rejects.toThrow();
    }
    await expect(wrapped({}, null, makeCtx())).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('different hosts are independent', async () => {
    const exec: NodeExecutor = async (cfg) => {
      const c = cfg as { ok: boolean };
      if (!c.ok) throw new Error('e');
      return { output: 'ok', durationMs: 1 };
    };
    const wrapped = wrap(exec, [withHostBreaker({ urlFrom: (c) => String(c.url) })]);
    for (let i = 0; i < 5; i += 1) {
      await expect(wrapped({ url: 'https://bad.com/x', ok: false }, null, makeCtx())).rejects.toThrow();
    }
    const r = await wrapped({ url: 'https://good.com/x', ok: true }, null, makeCtx());
    expect(r.output).toBe('ok');
  });
});

describe('withErrorMapping', () => {
  it('converts generic Error to NodeError on throw', async () => {
    const exec: NodeExecutor = async () => { throw new Error('boom'); };
    const wrapped = wrap(exec, [withErrorMapping()]);
    try {
      await wrapped({}, null, makeCtx());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NodeError);
    }
  });

  it('passes through existing NodeError unchanged', async () => {
    const orig = new ValidationError('bad');
    const exec: NodeExecutor = async () => { throw orig; };
    const wrapped = wrap(exec, [withErrorMapping()]);
    try {
      await wrapped({}, null, makeCtx());
    } catch (e) {
      expect(e).toBe(orig);
    }
  });
});

describe('withAbortGuard', () => {
  it('short-circuits if abortSignal already aborted', async () => {
    let called = false;
    const exec: NodeExecutor = async () => { called = true; return { output: 'x', durationMs: 1 }; };
    const ctrl = new AbortController();
    ctrl.abort();
    const wrapped = wrap(exec, [withAbortGuard()]);
    await expect(wrapped({}, null, makeCtx({ abortSignal: ctrl.signal })))
      .rejects.toBeInstanceOf(AbortedError);
    expect(called).toBe(false);
  });

  it('passes through if signal not aborted', async () => {
    const exec: NodeExecutor = async () => ({ output: 'ok', durationMs: 1 });
    const ctrl = new AbortController();
    const wrapped = wrap(exec, [withAbortGuard()]);
    const r = await wrapped({}, null, makeCtx({ abortSignal: ctrl.signal }));
    expect(r.output).toBe('ok');
  });
});

describe('httpMiddlewarePreset', () => {
  beforeEach(() => { clearBreakerRegistry(); unregisterTracer(); });

  it('composes telemetry + breaker + error-mapping + abort guard', async () => {
    const exec: NodeExecutor = async () => ({ output: { status: 200 }, durationMs: 5 });
    const wrapped = wrap(exec, [
      httpMiddlewarePreset({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        urlFrom: (c) => String((c as { url: string }).url),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        methodFrom: (c) => String((c as { method: string }).method),
      }),
    ]);
    const r = await wrapped({ url: 'https://api.x.com/u', method: 'GET' }, null, makeCtx());
    expect(r.output).toEqual({ status: 200 });
  });

  it('preset still triggers breaker on repeated failures', async () => {
    const exec: NodeExecutor = async () => { throw new Error('5xx'); };
    const wrapped = wrap(exec, [
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
      httpMiddlewarePreset({ urlFrom: (c) => String((c as { url: string }).url) }),
    ]);
    for (let i = 0; i < 5; i += 1) {
      await expect(wrapped({ url: 'https://preset-flaky.com/x' }, null, makeCtx())).rejects.toBeInstanceOf(NodeError);
    }
    // Breaker open by now — fast-fail
    await expect(wrapped({ url: 'https://preset-flaky.com/x' }, null, makeCtx())).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('preset applica idempotency su POST (replay → cached)', async () => {
    let runs = 0;
    const exec: NodeExecutor = async () => { runs += 1; return { output: { id: runs }, durationMs: 1 }; };
    const wrapped = wrap(exec, [
      httpMiddlewarePreset({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        urlFrom: (c) => String((c as { url: string }).url),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        methodFrom: (c) => String((c as { method: string }).method),
      }),
    ]);
    await wrapped({ url: 'https://api.x.com/u', method: 'POST' }, null, makeCtx());
    await wrapped({ url: 'https://api.x.com/u', method: 'POST' }, null, makeCtx());
    expect(runs).toBe(1); // 2° POST hit cache → no re-execute
  });

  it('preset NON applica idempotency su GET (safe-to-retry)', async () => {
    let runs = 0;
    const exec: NodeExecutor = async () => { runs += 1; return { output: { id: runs }, durationMs: 1 }; };
    const wrapped = wrap(exec, [
      httpMiddlewarePreset({
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        urlFrom: (c) => String((c as { url: string }).url),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
        methodFrom: (c) => String((c as { method: string }).method),
      }),
    ]);
    await wrapped({ url: 'https://api.x.com/u', method: 'GET' }, null, makeCtx({ runId: 'r-get' }));
    await wrapped({ url: 'https://api.x.com/u', method: 'GET' }, null, makeCtx({ runId: 'r-get' }));
    expect(runs).toBe(2); // GET safe to retry
  });
});

describe('withIdempotency resilience (fail-open vs fail-closed)', () => {
  const failingStore = {
    acquire: async () => { throw new Error('redis: connection refused'); },
    complete: async () => {},
    release: async () => {},
    size: async () => 0,
  };

  it('fail-open default: store down NON blocca, esegue next() comunque', async () => {
    let runs = 0;
    const exec: NodeExecutor = async () => { runs += 1; return { output: 'ok', durationMs: 1 }; };
    const { withIdempotency } = await import('./middleware.js');
    const wrapped = wrap(exec, [withIdempotency({ store: failingStore })]);
    const r = await wrapped({}, null, makeCtx());
    expect(r.output).toBe('ok');
    expect(runs).toBe(1);
  });

  it('fail-closed: store down PROPAGA l\'errore (no fallback unsafe)', async () => {
    const exec: NodeExecutor = async () => ({ output: 'never', durationMs: 1 });
    const { withIdempotency } = await import('./middleware.js');
    const wrapped = wrap(exec, [withIdempotency({ store: failingStore, resilience: 'fail-closed' })]);
    await expect(wrapped({}, null, makeCtx())).rejects.toThrow(/redis/);
  });

  it('store.complete fail post-exec NON propaga (risultato OK ritornato comunque)', async () => {
    const partialStore = {
      acquire: async () => ({ acquired: true }),
      complete: async () => { throw new Error('redis: connection lost mid-write'); },
      release: async () => {},
      size: async () => 0,
    };
    const exec: NodeExecutor = async () => ({ output: { result: 'success-payload' }, durationMs: 1 });
    const { withIdempotency } = await import('./middleware.js');
    const wrapped = wrap(exec, [withIdempotency({ store: partialStore })]);
    const r = await wrapped({}, null, makeCtx());
    expect(r.output).toEqual({ result: 'success-payload' }); // run completato OK nonostante store fail
  });
});

describe('withConditionalIdempotency', () => {
  it('skip per metodi safe (GET/HEAD/OPTIONS)', async () => {
    let runs = 0;
    const exec: NodeExecutor = async () => { runs += 1; return { output: runs, durationMs: 1 }; };
    const { withConditionalIdempotency } = await import('./middleware.js');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    const wrapped = wrap(exec, [withConditionalIdempotency({ methodFrom: (c) => String((c as { m: string }).m) })]);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      runs = 0;
      await wrapped({ m: method }, null, makeCtx({ runId: `r-${method}` }));
      await wrapped({ m: method }, null, makeCtx({ runId: `r-${method}` }));
      expect(runs).toBe(2);
    }
  });

  it('attiva per POST/PUT/PATCH/DELETE (side-effect methods)', async () => {
    const { withConditionalIdempotency } = await import('./middleware.js');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      let runs = 0;
      const exec: NodeExecutor = async () => { runs += 1; return { output: runs, durationMs: 1 }; };
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
      const wrapped = wrap(exec, [withConditionalIdempotency({ methodFrom: (c) => String((c as { m: string }).m) })]);
      const ctx = makeCtx({ runId: `r-${method}` });
      await wrapped({ m: method }, null, ctx);
      await wrapped({ m: method }, null, ctx);
      expect(runs, `${method} should be locked`).toBe(1);
    }
  });
});

// ───── helpers ─────
function mkMockSpan() {
  return {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
}

