/**
 * Test fanout dispatcher — re-risoluzione config corrente, anti-self, rate-limit drop,
 * avvio handler, durabilità (throw→retry). Bug-bounty: il drop da rate-limit NON deve
 * mai diventare retry-storm; l'anti-self NON deve mai avviare il workflow sorgente.
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import {
  makeFanoutDispatcher,
  type FanoutDispatcherDeps,
  type FanoutStartParams,
} from './fanout.dispatcher.js';
import type { ErrorOutboxRecord } from '../repository.js';

function rec(over: Partial<ErrorOutboxRecord> = {}): ErrorOutboxRecord {
  return {
    id: 'o1',
    runId: 'r1',
    channel: 'fanout',
    workflowId: 'wf-src',
    tenantId: 't-1',
    errorNodeId: 'node-3',
    errorMessage: 'boom',
    errorHash: 'h',
    durationMs: 5,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: '{"a":1}',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: '2026-06-19T10:00:00.000Z',
    lastError: null,
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T10:00:00.000Z',
    ...over,
  };
}

function deps(over: Partial<FanoutDispatcherDeps> = {}): FanoutDispatcherDeps {
  return {
    resolveErrorWorkflowId: async () => 'wf-handler',
    checkRateLimit: () => true,
    startErrorHandler: vi.fn((_p: FanoutStartParams) => Promise.resolve()),
    ...over,
  };
}

describe('fanout dispatcher', () => {
  it("avvia l'error-handler con il payload re-risolto (config corrente)", async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const d = makeFanoutDispatcher(deps({ startErrorHandler }));
    await expect(d(rec())).resolves.toBeUndefined();
    expect(startErrorHandler).toHaveBeenCalledTimes(1);
    expect(startErrorHandler.mock.calls[0]![0]).toMatchObject({
      errorWorkflowId: 'wf-handler',
      sourceWorkflowId: 'wf-src',
      tenantId: 't-1',
      runId: 'r1',
      failedNodeId: 'node-3',
      error: 'boom',
      triggerInputJson: '{"a":1}',
    });
  });

  it('nessun handler configurato (resolve → null) → no-op, nessun avvio (done)', async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const d = makeFanoutDispatcher(
      deps({ resolveErrorWorkflowId: async () => null, startErrorHandler }),
    );
    await d(rec());
    expect(startErrorHandler).not.toHaveBeenCalled();
  });

  it('🚨 anti-self: errWfId === workflow sorgente → NON avvia (no auto-loop)', async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const d = makeFanoutDispatcher(
      deps({ resolveErrorWorkflowId: async () => 'wf-src', startErrorHandler }),
    );
    await d(rec({ workflowId: 'wf-src' }));
    expect(startErrorHandler).not.toHaveBeenCalled();
  });

  it('🚨 rate-limit superato → DROP (done), NESSUN avvio e NESSUN throw (no retry-storm)', async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const onRateLimited = vi.fn();
    const d = makeFanoutDispatcher(
      deps({ checkRateLimit: () => false, startErrorHandler, onRateLimited }),
    );
    await expect(d(rec())).resolves.toBeUndefined(); // resolve → l'evento si chiude 'done'
    expect(startErrorHandler).not.toHaveBeenCalled();
    expect(onRateLimited).toHaveBeenCalledWith('wf-src', 'wf-handler');
  });

  it('startErrorHandler throwa → il dispatcher throwa (→ retry/dead nel worker)', async () => {
    const d = makeFanoutDispatcher(
      deps({ startErrorHandler: vi.fn(() => Promise.reject(new Error('start failed'))) }),
    );
    await expect(d(rec())).rejects.toThrow(/start failed/);
  });
});
