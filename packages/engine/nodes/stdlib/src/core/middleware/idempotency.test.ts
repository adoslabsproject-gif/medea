/**
 * Test 2026-grade — withIdempotency + withConditionalIdempotency middleware.
 *
 * 🚨 BUSINESS-CRITICAL: anti-doppio-side-effect (Stripe charge, bank transfer).
 *    Bug = doppia esecuzione su replay/retry → customer caricato 2x.
 *
 * 🚨 RESILIENCE POLICY:
 *  - fail-open (default): store down → proceed + warn (uptime > safety)
 *  - fail-closed: store down → throw (per write critici)
 *
 * 🚨 TTL run-aware: ctx.runDeadline → lock min(baseTtl, deadline+60s slack)
 *
 * 🚨 RFC 7231: withConditionalIdempotency skip lock per GET/HEAD/OPTIONS
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IdempotencyStore } from '../idempotency.js';
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from '../../types.js';
import { withIdempotency, withConditionalIdempotency, IdempotencyInFlightError } from './idempotency.js';
import { InMemoryIdempotencyStore } from '../idempotency.js';

function makeStore(): IdempotencyStore & {
  acquireMock: ReturnType<typeof vi.fn>;
  completeMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
} {
  const acquireMock = vi.fn().mockResolvedValue({ acquired: true });
  const completeMock = vi.fn().mockResolvedValue(undefined);
  const releaseMock = vi.fn().mockResolvedValue(undefined);
  const sizeMock = vi.fn().mockResolvedValue(0);
  return {
    acquire: acquireMock,
    complete: completeMock,
    release: releaseMock,
    size: sizeMock,
    acquireMock,
    completeMock,
    releaseMock,
  };
}

function makeCtx(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    tenantId: 'tenant-A',
    workflowId: 'wf-1',
    runId: 'run-1',
    nodeId: 'node-1',
    secrets: {},
    logger,
    ...overrides,
  };
}

function makeInner(returnValue: NodeExecutionResult = { output: { ok: true }, durationMs: 100 }): NodeExecutor {
  return vi.fn().mockResolvedValue(returnValue);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 withIdempotency — happy path (no previous lock)', () => {
  it('🚨 acquire OK → next() chiamato + complete persistito', async () => {
    const store = makeStore();
    const inner = makeInner({ output: { saved: true }, durationMs: 200 });
    const wrapped = withIdempotency({ store })(inner);
    const result = await wrapped({}, { msg: 'hi' }, makeCtx());
    expect(result.output).toEqual({ saved: true });
    expect(store.acquireMock).toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
    expect(store.completeMock).toHaveBeenCalledWith(expect.any(String), { saved: true });
    expect(store.releaseMock).not.toHaveBeenCalled();
  });

  it('🚨 key composito tenantId:runId:nodeId (no subKey)', async () => {
    const store = makeStore();
    const inner = makeInner();
    const wrapped = withIdempotency({ store })(inner);
    await wrapped({}, {}, makeCtx({ tenantId: 'T', runId: 'R', nodeId: 'N' }));
    const calledKey = store.acquireMock.mock.calls[0]![0] as string;
    expect(calledKey).toContain('T');
    expect(calledKey).toContain('R');
    expect(calledKey).toContain('N');
  });

  it('🚨 subKey custom → incluso nella key', async () => {
    const store = makeStore();
    const inner = makeInner();
    const wrapped = withIdempotency({
      store,
      subKey: (_cfg, input) => `item-${(input as { id: number }).id}`,
    })(inner);
    await wrapped({}, { id: 42 }, makeCtx());
    const calledKey = store.acquireMock.mock.calls[0]![0] as string;
    expect(calledKey).toContain('item-42');
  });

  it('🚨 subKey return undefined → key base senza subKey', async () => {
    const store = makeStore();
    const inner = makeInner();
    const wrapped = withIdempotency({
      store,
      subKey: () => undefined,
    })(inner);
    await wrapped({}, {}, makeCtx());
    const calledKey = store.acquireMock.mock.calls[0]![0] as string;
    expect(calledKey).not.toContain('undefined');
  });
});

describe('🚨 withIdempotency — cache hit (previous output)', () => {
  it('🚨 acquired=false + previousOutput → cached return + warnings', async () => {
    const store = makeStore();
    store.acquireMock.mockResolvedValueOnce({
      acquired: false,
      previousOutput: { cached: 'data' },
      previousAt: Date.now() - 1000,
    });
    const inner = makeInner();
    const wrapped = withIdempotency({ store })(inner);
    const result = await wrapped({}, {}, makeCtx());
    expect(result.output).toEqual({ cached: 'data' });
    expect(result.warnings).toEqual(['idempotency:cached']);
    expect(result.durationMs).toBe(0); // cached = 0ms
    expect(inner).not.toHaveBeenCalled(); // NON ri-eseguito
    expect(store.completeMock).not.toHaveBeenCalled();
  });

  // ── IN-FLIGHT (#race) — NON eseguire mentre un'altra esecuzione concorrente è viva.
  it('🚨 in-flight poi COMPLETATA dall\'altra → replay, NIENTE next() (no doppio side-effect)', async () => {
    const store = makeStore();
    // 1° acquire: in-flight (lock altrui, no output). 2° poll: completata (previousOutput).
    store.acquireMock
      .mockResolvedValueOnce({ acquired: false, previousOutput: undefined, previousAt: Date.now() })
      .mockResolvedValueOnce({ acquired: false, previousOutput: { stripe_charge_id: 'ch_1' }, previousAt: Date.now() });
    const inner = makeInner({ output: { fresh: true }, durationMs: 50 });
    const wrapped = withIdempotency({ store, inFlightPollMs: 1, inFlightWaitMs: 1000 })(inner);
    const result = await wrapped({}, {}, makeCtx());
    expect(inner).not.toHaveBeenCalled(); // NON eseguito (l'altra aveva fatto il charge)
    expect(result.output).toEqual({ stripe_charge_id: 'ch_1' });
    expect(result.warnings).toContain('idempotency:cached');
  });

  it('🚨 in-flight che NON completa entro l\'attesa → IdempotencyInFlightError, NIENTE next()', async () => {
    const store = makeStore();
    store.acquireMock.mockResolvedValue({ acquired: false, previousOutput: undefined, previousAt: Date.now() });
    const inner = makeInner();
    const wrapped = withIdempotency({ store, inFlightPollMs: 1, inFlightWaitMs: 10 })(inner);
    await expect(wrapped({}, {}, makeCtx())).rejects.toBeInstanceOf(IdempotencyInFlightError);
    expect(inner).not.toHaveBeenCalled(); // mai eseguito mentre l'altra è viva
  });

  it('in-flight poi il lock dell\'altra SCADE → si acquisisce e si esegue (l\'altra è morta)', async () => {
    const store = makeStore();
    store.acquireMock
      .mockResolvedValueOnce({ acquired: false, previousOutput: undefined, previousAt: Date.now() })
      .mockResolvedValueOnce({ acquired: true }); // lock scaduto → lo prendiamo noi
    const inner = makeInner({ output: { fresh: true }, durationMs: 50 });
    const wrapped = withIdempotency({ store, inFlightPollMs: 1, inFlightWaitMs: 1000 })(inner);
    const result = await wrapped({}, {}, makeCtx());
    expect(inner).toHaveBeenCalled();
    expect(result.output).toEqual({ fresh: true });
  });
});

describe('🚨 withIdempotency — CONCORRENZA REALE (InMemoryIdempotencyStore, anti doppio charge)', () => {
  it('🚨 2 esecuzioni PARALLELE stessa (run,node) → handler 1 sola volta, 2ª replay', async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    let releaseFirst!: () => void;
    let firstStartedResolve!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const firstStarted = new Promise<void>((r) => { firstStartedResolve = r; });

    const inner: NodeExecutor = vi.fn(async () => {
      calls += 1;
      const mine = calls;
      if (mine === 1) { firstStartedResolve(); await gate; } // A blocca finché non la sblocco
      return { output: { charge: `ch_${String(mine)}` }, durationMs: 10 };
    });
    const ctx = makeCtx();
    const wrapped = withIdempotency({ store, inFlightPollMs: 2, inFlightWaitMs: 2000 })(inner);

    const pA = wrapped({}, {}, ctx);   // A: acquisisce il lock, handler si blocca sul gate
    await firstStarted;                // garantito: A tiene il lock ed è dentro l'handler
    const pB = wrapped({}, {}, ctx);   // B: vede in-flight (A vivo, non completato) → poll
    releaseFirst();                    // A completa → salva l'output
    const [rA, rB] = await Promise.all([pA, pB]);

    expect(calls).toBe(1);                                 // handler eseguito UNA SOLA VOLTA
    expect(rA.output).toEqual({ charge: 'ch_1' });
    expect(rB.output).toEqual({ charge: 'ch_1' });         // B ha fatto REPLAY, non charge-bis
    expect(rB.warnings).toContain('idempotency:cached');
  });
});

describe('🚨 withIdempotency — RESILIENCE fail-open vs fail-closed', () => {
  it('🚨 default fail-open: store.acquire THROW → log warn + proceed con next()', async () => {
    const store = makeStore();
    store.acquireMock.mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));
    const inner = makeInner({ output: { fallback: true }, durationMs: 1 });
    const ctx = makeCtx();
    const wrapped = withIdempotency({ store })(inner);
    const result = await wrapped({}, {}, ctx);
    expect(result.output).toEqual({ fallback: true });
    expect(inner).toHaveBeenCalled();
    expect((ctx as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('store-down'),
      expect.objectContaining({ err: 'Redis ECONNREFUSED' }),
    );
  });

  it('🚨 fail-closed: store.acquire THROW → propaga errore (NO next call)', async () => {
    const store = makeStore();
    store.acquireMock.mockRejectedValueOnce(new Error('Redis down'));
    const inner = makeInner();
    const wrapped = withIdempotency({ store, resilience: 'fail-closed' })(inner);
    await expect(wrapped({}, {}, makeCtx())).rejects.toThrow('Redis down');
    expect(inner).not.toHaveBeenCalled();
  });

  it('🚨 fail-open: store.complete fail post-exec → log warn ma result OK', async () => {
    const store = makeStore();
    store.completeMock.mockRejectedValueOnce(new Error('Redis went down after acquire'));
    const ctx = makeCtx();
    const wrapped = withIdempotency({ store })(makeInner({ output: { done: true }, durationMs: 5 }));
    const result = await wrapped({}, {}, ctx);
    expect(result.output).toEqual({ done: true }); // result restituito comunque
    expect((ctx as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('complete-failed'),
      expect.any(Object),
    );
  });
});

describe('🚨 withIdempotency — error propagation + release', () => {
  it('🚨 inner THROW → store.release chiamato + error propagato', async () => {
    const store = makeStore();
    const inner = vi.fn().mockRejectedValue(new Error('node execution failed'));
    const wrapped = withIdempotency({ store })(inner);
    await expect(wrapped({}, {}, makeCtx())).rejects.toThrow('node execution failed');
    expect(store.releaseMock).toHaveBeenCalled();
    expect(store.completeMock).not.toHaveBeenCalled();
  });

  it('🚨 inner THROW + release THROW → origin error wins (release swallowed)', async () => {
    const store = makeStore();
    store.releaseMock.mockRejectedValueOnce(new Error('release fail benign'));
    const inner = vi.fn().mockRejectedValue(new Error('origin error'));
    const wrapped = withIdempotency({ store })(inner);
    await expect(wrapped({}, {}, makeCtx())).rejects.toThrow('origin error');
  });
});

describe('🚨 withIdempotency — TTL run-aware', () => {
  it('🚨 no runDeadline → usa baseTtlMs', async () => {
    const store = makeStore();
    const wrapped = withIdempotency({ store, ttlMs: 5000 })(makeInner());
    await wrapped({}, {}, makeCtx());
    expect(store.acquireMock).toHaveBeenCalledWith(expect.any(String), 5000);
  });

  it('🚨 runDeadline future → min(baseTtl, deadline+60s slack)', async () => {
    const store = makeStore();
    const now = Date.now();
    const deadline = now + 10_000; // 10s future
    const ctx = makeCtx({ runDeadline: deadline });
    const wrapped = withIdempotency({ store, ttlMs: 24 * 60 * 60 * 1000 })(makeInner());
    await wrapped({}, {}, ctx);
    const calledTtl = store.acquireMock.mock.calls[0]![1] as number;
    // ttl = min(24h, deadline - now + 60s) ≈ 70s (10s + 60s slack)
    expect(calledTtl).toBeGreaterThan(60_000);
    expect(calledTtl).toBeLessThan(80_000);
  });

  it('🚨 runDeadline past → clamp min 60s', async () => {
    const store = makeStore();
    const ctx = makeCtx({ runDeadline: Date.now() - 100_000 });
    const wrapped = withIdempotency({ store })(makeInner());
    await wrapped({}, {}, ctx);
    const calledTtl = store.acquireMock.mock.calls[0]![1] as number;
    expect(calledTtl).toBeGreaterThanOrEqual(60_000);
  });

  it('🚨 MEDEA_IDEMPOTENCY_TTL_MS env → override default 24h', async () => {
    // Modulo importato → ttl di base e\` "snapshot" all'import. Test che opt.ttlMs override.
    const store = makeStore();
    const wrapped = withIdempotency({ store, ttlMs: 7200_000 })(makeInner());
    await wrapped({}, {}, makeCtx());
    expect(store.acquireMock).toHaveBeenCalledWith(expect.any(String), 7200_000);
  });
});

describe('🚨 withConditionalIdempotency — RFC 7231 safe methods', () => {
  it('🚨 GET → SKIP lock, next() chiamato direttamente', async () => {
    const store = makeStore();
    const inner = makeInner({ output: { data: 'fetched' }, durationMs: 50 });
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method?: string }).method ?? 'GET',
      store,
    })(inner);
    const result = await wrapped({ method: 'GET' }, {}, makeCtx());
    expect(result.output).toEqual({ data: 'fetched' });
    expect(store.acquireMock).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it('🚨 HEAD → SKIP lock', async () => {
    const store = makeStore();
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method: string }).method,
      store,
    })(makeInner());
    await wrapped({ method: 'HEAD' }, {}, makeCtx());
    expect(store.acquireMock).not.toHaveBeenCalled();
  });

  it('🚨 OPTIONS → SKIP lock', async () => {
    const store = makeStore();
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method: string }).method,
      store,
    })(makeInner());
    await wrapped({ method: 'OPTIONS' }, {}, makeCtx());
    expect(store.acquireMock).not.toHaveBeenCalled();
  });

  it('🚨 POST → APPLY lock', async () => {
    const store = makeStore();
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method: string }).method,
      store,
    })(makeInner());
    await wrapped({ method: 'POST' }, {}, makeCtx());
    expect(store.acquireMock).toHaveBeenCalled();
  });

  it('🚨 PUT/PATCH/DELETE → APPLY lock', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const store = makeStore();
      const wrapped = withConditionalIdempotency({
        methodFrom: (cfg) => (cfg as { method: string }).method,
        store,
      })(makeInner());
      await wrapped({ method }, {}, makeCtx());
      expect(store.acquireMock).toHaveBeenCalled();
    }
  });

  it('🚨 method lowercase "get" → SKIP (toUpperCase normalize)', async () => {
    const store = makeStore();
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method: string }).method,
      store,
    })(makeInner());
    await wrapped({ method: 'get' }, {}, makeCtx());
    expect(store.acquireMock).not.toHaveBeenCalled();
  });

  it('🚨 method unknown (es. "TRACE") → APPLY lock (default side-effect-safe)', async () => {
    const store = makeStore();
    const wrapped = withConditionalIdempotency({
      methodFrom: (cfg) => (cfg as { method: string }).method,
      store,
    })(makeInner());
    await wrapped({ method: 'TRACE' }, {}, makeCtx());
    expect(store.acquireMock).toHaveBeenCalled();
  });
});

describe('🚨 SECURITY: doppio-side-effect prevention', () => {
  it('🚨 stesso runId+nodeId su retry → cached output, NO doppia esecuzione', async () => {
    const store = makeStore();
    const inner = makeInner({ output: { stripe_charge_id: 'ch_xxx' }, durationMs: 500 });
    const wrapped = withIdempotency({ store })(inner);

    // 1a call: acquire OK, execute, complete
    const r1 = await wrapped({}, {}, makeCtx({ runId: 'R1', nodeId: 'stripe-charge' }));
    expect(r1.output).toEqual({ stripe_charge_id: 'ch_xxx' });
    expect(inner).toHaveBeenCalledTimes(1);

    // 2a call (retry simulato): mock acquired=false + previous output
    store.acquireMock.mockResolvedValueOnce({
      acquired: false,
      previousOutput: { stripe_charge_id: 'ch_xxx' },
    });
    const r2 = await wrapped({}, {}, makeCtx({ runId: 'R1', nodeId: 'stripe-charge' }));
    expect(r2.output).toEqual({ stripe_charge_id: 'ch_xxx' });
    // inner NON chiamato 2x → Stripe charge solo 1x ✓
    expect(inner).toHaveBeenCalledTimes(1);
    expect(r2.warnings).toContain('idempotency:cached');
  });
});
