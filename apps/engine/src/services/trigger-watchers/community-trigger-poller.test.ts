/**
 * Bug-bounty — trigger-watchers/community-trigger-poller.
 *
 * Nel monolite il poller usava `this.runs` + l'import diretto del runner →
 * inFlight/at-most-once/snapshot config testabili solo e2e con vi.mock. Con
 * pollRunner e dispatcher INIETTATI pinniamo qui:
 *   - clamp REALE dell'intervallo [10, 3600]s + priorità config nodo > default
 *     del trigger > fallback 60s;
 *   - dispatch per-evento con triggerType `community:<defId>:<triggerId>`;
 *   - state round-trip: {} al primo poll, poi il cursore del vendor;
 *   - at-most-once: dispatch fallito → lo state è COMUNQUE avanzato;
 *   - no-overlap: poll in volo → tick saltato, mai accodato;
 *   - poll fallito → loggato, inFlight rilasciato, retry al tick dopo;
 *   - config SNAPSHOT alla registrazione (mutare node.config dopo non
 *     influenza i poll successivi);
 *   - context del sandbox: {tenantId, workflowId, nodeId} esatti.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startCommunityTriggerPoller,
  type CommunityTriggerPollerDeps,
} from './community-trigger-poller.js';
import type { runCommunityTriggerPoll } from '../community-trigger-runner.js';
import type { InstalledNode } from '../community-nodes.service.js';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, NodeTrigger, Workflow } from '@medea/engine-core-schema';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeWf(): Workflow {
  return {
    id: 'wf-ct',
    tenantId: 'tenant-a',
    name: 'CT',
    enabled: true,
    schemaVersion: '1.0.0',
    nodes: [],
    edges: [],
    nodeDefs: [],
    createdAt: '2026-06-12',
    updatedAt: '2026-06-12',
  } as unknown as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n-7', defId: 'acme_poll', config } as unknown as CanvasNode;
}

const installed = {
  manifest: {
    id: 'acme_poll',
    vendor: 'acme',
    version: '1.0.0',
    displayName: 'Acme',
    description: 'x',
    license: 'MIT',
  },
  def: {
    id: 'acme_poll',
    type: 'trigger',
    label: 'Acme',
    icon: 'cube',
    color: '#3b82f6',
    description: 'x',
    triggers: [{ id: 'rows', label: 'Rows', mode: 'polling', pollIntervalSec: 25 }],
  },
  executorSource: 'module.exports = async () => ({});',
  installedAt: '2026-06-09',
  verified: true,
  storagePath: '/tmp/acme',
} as unknown as InstalledNode;

const trig = {
  id: 'rows',
  label: 'Rows',
  mode: 'polling',
  pollIntervalSec: 25,
} as unknown as NodeTrigger;

type PollRunner = typeof runCommunityTriggerPoll;
type PollResult = Awaited<ReturnType<PollRunner>>;

function makeDeps(over: Partial<CommunityTriggerPollerDeps> = {}): {
  deps: CommunityTriggerPollerDeps;
  pollRunner: ReturnType<typeof vi.fn>;
  dispatched: TriggerRunInput[];
} {
  const dispatched: TriggerRunInput[] = [];
  const pollRunner = vi.fn(
    async (): Promise<PollResult> =>
      ({ events: [], state: {}, truncated: false }) as unknown as PollResult,
  );
  const deps: CommunityTriggerPollerDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return { runId: 'r-1', status: 'success', errorCount: 0 };
    },
    pollRunner: pollRunner as unknown as PollRunner,
    ...over,
  };
  return { deps, pollRunner, dispatched };
}

const result = (events: unknown[], state: Record<string, unknown>): PollResult =>
  ({ events, state, truncated: false }) as unknown as PollResult;

describe('intervallo di poll (clamp reale [10,3600])', () => {
  it('config nodo ha priorità sul default del trigger', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '15' }),
      installed,
      trig,
      deps,
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(pollRunner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pollRunner).toHaveBeenCalledTimes(1);
    if (job.timer) clearInterval(job.timer);
  });

  it('senza override → usa pollIntervalSec del trigger (25s)', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows' }),
      installed,
      trig,
      deps,
    );
    await vi.advanceTimersByTimeAsync(24_999);
    expect(pollRunner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pollRunner).toHaveBeenCalledTimes(1);
    if (job.timer) clearInterval(job.timer);
  });

  it('config sotto il minimo → clampata a 10s (anti-DoS sul sandbox)', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '1' }),
      installed,
      trig,
      deps,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(pollRunner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pollRunner).toHaveBeenCalledTimes(1);
    if (job.timer) clearInterval(job.timer);
  });
});

describe('poll → dispatch', () => {
  it('un run per evento, triggerType community:<defId>:<triggerId>, context sandbox esatto', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner, dispatched } = makeDeps();
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10' }),
      installed,
      trig,
      deps,
    );
    pollRunner.mockResolvedValueOnce(result([{ id: 1 }, { id: 2 }], { lastId: 2 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatched).toEqual([
      {
        workflowId: 'wf-ct',
        tenantId: 'tenant-a',
        triggerType: 'community:acme_poll:rows',
        triggerInput: { id: 1 },
      },
      {
        workflowId: 'wf-ct',
        tenantId: 'tenant-a',
        triggerType: 'community:acme_poll:rows',
        triggerInput: { id: 2 },
      },
    ]);
    // Context passato al sandbox: tenant, workflow e NODO esatti.
    expect(pollRunner.mock.calls[0]![4]).toEqual({
      tenantId: 'tenant-a',
      workflowId: 'wf-ct',
      nodeId: 'n-7',
    });
    if (job.timer) clearInterval(job.timer);
  });

  it('state round-trip: {} al primo poll, poi il cursore del vendor', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10' }),
      installed,
      trig,
      deps,
    );
    pollRunner.mockResolvedValueOnce(result([], { cursor: 'abc' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollRunner.mock.calls[0]![3]).toEqual({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollRunner.mock.calls[1]![3]).toEqual({ cursor: 'abc' });
    if (job.timer) clearInterval(job.timer);
  });

  it('at-most-once: dispatch fallito → lo state è COMUNQUE avanzato + error loggato', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.useFakeTimers();
    const { pollRunner, deps } = makeDeps({
      dispatchRun: async () => {
        throw new Error('run boom');
      },
    });
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10' }),
      installed,
      trig,
      deps,
    );
    pollRunner.mockResolvedValueOnce(result([{ id: 1 }], { cursor: 9 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-ct', defId: 'acme_poll', triggerId: 'rows' }),
      'community trigger run failed',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollRunner.mock.calls[1]![3]).toEqual({ cursor: 9 }); // niente replay loop
    if (job.timer) clearInterval(job.timer);
  });

  it('config SNAPSHOT: mutare node.config dopo la registrazione NON tocca i poll', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    const node = makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10', apiKey: 'originale' });
    const job = startCommunityTriggerPoller(makeWf(), node, installed, trig, deps);
    (node.config as Record<string, string>).apiKey = 'MUTATA-DOPO';
    await vi.advanceTimersByTimeAsync(10_000);
    expect((pollRunner.mock.calls[0]![2] as Record<string, unknown>).apiKey).toBe('originale');
    if (job.timer) clearInterval(job.timer);
  });
});

describe('resilienza', () => {
  it('no-overlap: poll in volo → tick saltato, mai accodato; al rilascio riparte', async () => {
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    let resolvePoll!: (v: PollResult) => void;
    pollRunner.mockImplementationOnce(
      () =>
        new Promise<PollResult>((r) => {
          resolvePoll = r;
        }),
    );
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10' }),
      installed,
      trig,
      deps,
    );
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 — in volo
    expect(job.inFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); // tick 2 — saltato
    expect(pollRunner).toHaveBeenCalledTimes(1);
    resolvePoll(result([], {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(job.inFlight).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); // tick 3 — riparte
    expect(pollRunner).toHaveBeenCalledTimes(2);
    if (job.timer) clearInterval(job.timer);
  });

  it('pollRunner che lancia → loggato, inFlight rilasciato, state intatto, retry al tick dopo', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.useFakeTimers();
    const { deps, pollRunner } = makeDeps();
    pollRunner.mockRejectedValueOnce(new Error('sandbox boom'));
    const job = startCommunityTriggerPoller(
      makeWf(),
      makeNode({ __ff_trigger: 'rows', pollIntervalSec: '10' }),
      installed,
      trig,
      deps,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-ct', defId: 'acme_poll', triggerId: 'rows' }),
      'community trigger poll failed',
    );
    expect(job.inFlight).toBe(false);
    expect(job.state).toEqual({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollRunner).toHaveBeenCalledTimes(2);
    if (job.timer) clearInterval(job.timer);
  });
});
