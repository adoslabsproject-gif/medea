/**
 * Engine #2 — pausa-su-quota: uno step LLM che esaurisce la quota (no BYOK)
 * SOSPENDE il run (anziché fallire) per riprenderlo al rinnovo. Il nodo viene
 * de-visitato + ri-accodato così al resume si RI-ESEGUE.
 *
 * Copre il path REALE: l'executor lancia LlmQuotaExceededError → withErrorMapping
 * la wrappa in NodeError(cause=originale) → executeNode → asQuotaPauseError la
 * riconosce via .cause → suspendOnQuota.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/community-nodes.service.js', () => ({ getInstalledByDefId: () => undefined }));

import { WorkflowEngine } from './workflow-engine.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import type { Workflow } from '@medea/engine-core-schema';
import type { IPauseHandler, PauseArgs } from '@/engine/ports.js';

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    schemaVersion: '1.0.0',
    id: 'wf-test',
    name: 'Test',
    enabled: true,
    nodes: [],
    edges: [],
    nodeDefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

/** Nodo che lancia LlmQuotaExceededError (forma reale: name + periodEndIso). */
function quotaNode(periodEndIso: string | null): unknown {
  const err = Object.assign(new Error('Quota token esaurita'), {
    name: 'LlmQuotaExceededError',
    periodEndIso,
    kind: 'token',
  });
  return {
    def: {
      id: 'quotanode',
      label: 'LLM',
      kind: 'action' as const,
      category: 'ai',
      inputs: [],
      outputs: [],
      configSchema: {} as never,
    },
    executor: vi.fn().mockRejectedValue(err),
  };
}

/** Nodo che lancia un errore NON-quota (per il caso di controllo). */
function boomNode(): unknown {
  return {
    def: {
      id: 'quotanode',
      label: 'X',
      kind: 'action' as const,
      category: 'ai',
      inputs: [],
      outputs: [],
      configSchema: {} as never,
    },
    executor: vi.fn().mockRejectedValue(new Error('boom generico')),
  };
}

function capture(): { handler: IPauseHandler; calls: PauseArgs[] } {
  const calls: PauseArgs[] = [];
  return {
    handler: {
      pause: (a: PauseArgs) => {
        calls.push(a);
        return 'paused-id-1';
      },
    },
    calls,
  };
}

function wf(): Workflow {
  return makeWorkflow({
    nodes: [
      { id: 'trig', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'qn', defId: 'quotanode', x: 100, y: 0, config: {} },
      { id: 'after', defId: 'logic_delay', x: 200, y: 0, config: { durationMs: '1' } },
    ],
    edges: [
      { from: 'trig', to: 'qn' },
      { from: 'qn', to: 'after' },
    ],
  });
}

describe('WorkflowEngine — pausa-su-quota (#2)', () => {
  it('quota esaurita (no BYOK) → run SOSPESO, nodo de-visitato + ri-accodato', async () => {
    const { handler, calls } = capture();
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [quotaNode('2026-07-15') as never],
      pauseHandler: handler,
    });
    const r = await engine.run({ workflow: wf(), triggerInput: {} });

    expect(r.status).toBe('paused');
    expect(r.pausedId).toBe('paused-id-1');
    expect(r.pausedOnSignal).toBe('quota:renewed:default');
    expect(calls).toHaveLength(1);

    const p = calls[0]!;
    expect(p.signalName).toBe('quota:renewed:default');
    expect(p.atNodeId).toBe('qn');
    expect(p.timeoutSeconds).toBeGreaterThan(0);
    // Il nodo LLM è RI-ACCODATO (resume lo ri-esegue) e NON in visited.
    expect([...p.visited]).not.toContain('qn');
    expect(p.pendingQueue.some((q) => q.nodeId === 'qn')).toBe(true);
  });

  it('il downstream NON viene eseguito (run sospeso prima) + step "paused" sul nodo LLM', async () => {
    const { handler } = capture();
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [quotaNode('2026-07-15') as never],
      pauseHandler: handler,
    });
    const r = await engine.run({ workflow: wf(), triggerInput: {} });
    expect(r.steps.some((s) => s.nodeId === 'after')).toBe(false);
    const qnStep = r.steps.find((s) => s.nodeId === 'qn');
    expect(qnStep?.status).toBe('paused'); // NON 'error'
  });

  it('CONTROLLO: errore NON-quota → run in ERRORE (nessuna pausa)', async () => {
    const { handler, calls } = capture();
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [boomNode() as never],
      pauseHandler: handler,
    });
    const r = await engine.run({ workflow: wf(), triggerInput: {} });
    expect(r.status).not.toBe('paused');
    expect(calls).toHaveLength(0); // pauseHandler MAI chiamato
    expect(r.steps.find((s) => s.nodeId === 'qn')?.status).toBe('error');
  });

  it('periodEndIso null → pausa con timeout di fallback (>0, ≤24h)', async () => {
    const { handler, calls } = capture();
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [quotaNode(null) as never],
      pauseHandler: handler,
    });
    const r = await engine.run({ workflow: wf(), triggerInput: {} });
    expect(r.status).toBe('paused');
    expect(calls[0]!.timeoutSeconds).toBe(24 * 60 * 60);
  });
});
