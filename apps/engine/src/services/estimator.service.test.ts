/**
 * Test 2026-grade — EstimatorService (static analysis pre-run forecast).
 *
 * 🚨 BUSINESS-CRITICAL: pre-run modal mostra al cliente costo + durata stimati
 * + rate-limit warnings. Wrong forecast → cliente sorpreso da fattura LLM o
 * batched gas usage.
 *
 * Coverage:
 *  - workflow vuoto → totals=0
 *  - loop + body cost aggregation (perIterationCost × N)
 *  - itemsExpression: evaluated (Array) vs fallback (non-array/throw)
 *  - strategy suggestion: bulk (body has bulk endpoint), queue (10k+),
 *    batch (200+), auto branch, declared kept
 *  - rate limit warning (req/min > limit)
 *  - empty itemsExpression → warning
 *  - non-loop nodes (single execution) summed in totals
 *  - inLoopBody dedup (no double-count body nodes)
 *  - totalCost round 4-decimal
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  evaluateExpression: vi.fn(),
  ALL_NODE_MODULES: [
    {
      def: {
        id: 'logic_loop', label: 'Loop',
      },
    },
    {
      def: {
        id: 'action_http', label: 'HTTP',
        cost: { costPerCall: 0.001, typicalLatencyMs: 200, rateLimit: { reqPerMin: 60 } },
      },
    },
    {
      def: {
        id: 'action_llm', label: 'LLM',
        cost: { costPerCall: 0.05, typicalLatencyMs: 1000, rateLimit: { reqPerMin: 30 } },
      },
    },
    {
      def: {
        id: 'action_db_bulk', label: 'DB Bulk',
        cost: { costPerCall: 0.0001, typicalLatencyMs: 50 },
        bulk: { supports: true },
      },
    },
    {
      def: {
        id: 'action_simple', label: 'Simple',
        cost: { costPerCall: 0.0001, typicalLatencyMs: 10 },
      },
    },
  ],
}));

vi.mock('@/engine/workflow-engine.js', () => ({
  ALL_NODE_MODULES: m.ALL_NODE_MODULES,
}));

vi.mock('@/engine/interpreter.js', () => ({
  evaluateExpression: (...a: unknown[]) => m.evaluateExpression(...a),
}));

vi.mock('@/lib/logger.js');

import { EstimatorService, type EstimateInput } from './estimator.service.js';

const svc = new EstimatorService();

function makeInput(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    workflow: {
      id: 'wf-1',
      nodes: [],
      edges: [],
    } as unknown as EstimateInput['workflow'],
    ...over,
  };
}

beforeEach(() => {
  m.evaluateExpression.mockReset();
});

describe('empty / minimal workflow', () => {
  it('workflow vuoto → totals=0', () => {
    const r = svc.estimate(makeInput());
    expect(r.workflowId).toBe('wf-1');
    expect(r.loops).toEqual([]);
    expect(r.totalEstimatedCostUsd).toBe(0);
    expect(r.totalEstimatedDurationMs).toBe(0);
    expect(r.totalNodeExecutions).toBe(0);
  });

  it('single non-loop node (action_http) → run 1× cost', () => {
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'n1', defId: 'action_http', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.totalEstimatedCostUsd).toBe(0.001);
    expect(r.totalEstimatedDurationMs).toBe(200);
    expect(r.totalNodeExecutions).toBe(1);
  });

  it('non-loop node con defId sconosciuto → skipped', () => {
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'n1', defId: 'unknown_node', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.totalNodeExecutions).toBe(0);
  });
});

describe('🚨 loop analysis — iterationCount source', () => {
  it('🚨 itemsExpression evaluates to Array → count=length, source=evaluated', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3, 4, 5]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: { itemsExpression: 'input.items' } }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
      sampleInput: { items: [1, 2, 3, 4, 5] },
    }));
    expect(r.loops[0]?.iterationCount).toBe(5);
    expect(r.loops[0]?.iterationCountSource).toBe('evaluated');
  });

  it('🚨 itemsExpression returns non-array → fallback', () => {
    m.evaluateExpression.mockReturnValue({ not: 'array' });
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.iterationCount).toBe(100); // default fallback
    expect(r.loops[0]?.iterationCountSource).toBe('fallback');
  });

  it('🚨 itemsExpression throws → fallback (no crash)', () => {
    m.evaluateExpression.mockImplementation(() => { throw new Error('cannot eval'); });
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.iterationCountSource).toBe('fallback');
  });

  it('🚨 custom defaultIterationCount → applicato come fallback', () => {
    m.evaluateExpression.mockReturnValue('not-array');
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
      defaultIterationCount: 500,
    }));
    expect(r.loops[0]?.iterationCount).toBe(500);
  });
});

describe('🚨 strategy suggestion', () => {
  it('🚨 body has bulk endpoint → suggest "bulk"', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'naive' } },
          { id: 'body1', defId: 'action_db_bulk', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('bulk');
    expect(r.loops[0]?.suggestionReason).toContain('bulk endpoint');
  });

  it('🚨 10k+ iterations + naive → suggest "queue"', () => {
    m.evaluateExpression.mockReturnValue(new Array(10_000).fill(0));
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'naive' } },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('queue');
    expect(r.loops[0]?.suggestionReason).toContain('10k+');
  });

  it('🚨 200+ iterations + naive → suggest "batch"', () => {
    m.evaluateExpression.mockReturnValue(new Array(300).fill(0));
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'naive' } },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('batch');
  });

  it('declared strategy non-naive → kept (no auto-suggest)', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'queue' } },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('queue');
    expect(r.loops[0]?.suggestionReason).toBe('keeping declared strategy');
  });

  it('🚨 declared="auto" + bulk body → bulk (PRIMA if matcha sempre, anche con auto)', () => {
    m.evaluateExpression.mockReturnValue([1]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'auto' } },
          { id: 'body1', defId: 'action_db_bulk', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('bulk');
    // Il primo branch (hasBulkCapable && declared !== 'bulk') matcha sempre quando
    // c'e\` bulk capability, anche con declared='auto'. Reason = "bulk endpoint".
    expect(r.loops[0]?.suggestionReason).toContain('bulk endpoint');
  });

  it('🚨 declared="auto" + 10k iter no-bulk → auto → queue', () => {
    m.evaluateExpression.mockReturnValue(new Array(10_000).fill(0));
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'auto' } },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('queue');
  });

  it('🚨 declared="auto" + small dataset → auto → naive', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'auto' } },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.suggestedStrategy).toBe('naive');
  });
});

describe('🚨 warnings', () => {
  it('🚨 itemsExpression evaluates to empty array → warning', () => {
    m.evaluateExpression.mockReturnValue([]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.warnings.some((w) => w.includes('empty array'))).toBe(true);
  });

  it('🚨 fallback iterationCount → warning "estimate"', () => {
    m.evaluateExpression.mockReturnValue('not-array');
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [{ id: 'loop1', defId: 'logic_loop', config: {} }],
        edges: [],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.warnings.some((w) => w.includes('estimate'))).toBe(true);
  });

  it('🚨 rate-limit warning quando expected > limit', () => {
    // 1000 iter su LLM (rateLimit 30/min, latency 1000ms) → 1000 req in 16 min = 62/min > 30
    m.evaluateExpression.mockReturnValue(new Array(1000).fill(0));
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: { strategy: 'naive' } },
          { id: 'body1', defId: 'action_llm', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops[0]?.warnings.some((w) => w.includes('Rate limit risk'))).toBe(true);
  });
});

describe('🚨 totals aggregation', () => {
  it('🚨 loop body cost × N + non-loop cost summed', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3, 4, 5]); // 5 iter
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'before', defId: 'action_simple', config: {} },     // 0.0001 × 1
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_http', config: {} },        // 0.001 × 5 = 0.005
          { id: 'after', defId: 'action_simple', config: {} },      // 0.0001 × 1
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    // 0.0001 + 0.005 + 0.0001 = 0.0052
    expect(r.totalEstimatedCostUsd).toBeCloseTo(0.0052, 4);
  });

  it('🚨 totals round a 4 decimali', () => {
    m.evaluateExpression.mockReturnValue([1]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_llm', config: {} }, // 0.05
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    // 0.05 → toFixed(4)-like round
    expect(Number.isFinite(r.totalEstimatedCostUsd)).toBe(true);
    expect((r.totalEstimatedCostUsd * 10_000) % 1).toBe(0); // multiple of 0.0001
  });

  it('🚨 totalNodeExecutions = N × bodyNodeCount + 1 (loop)', () => {
    m.evaluateExpression.mockReturnValue([1, 2, 3]); // 3 iter
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_http', config: {} },
          { id: 'body2', defId: 'action_simple', config: {} },
        ],
        edges: [
          { from: 'loop1', to: 'body1', fromPort: 'body' },
          { from: 'body1', to: 'body2' },
        ],
      } as unknown as EstimateInput['workflow'],
    }));
    // 2 body × 3 iter = 6, + 0 non-loop (loop itself excluded) = 6
    expect(r.loops[0]?.totalNodeExecutions).toBe(6);
    expect(r.totalNodeExecutions).toBe(6);
  });

  it('🚨 body nodes NON double-counted come non-loop', () => {
    m.evaluateExpression.mockReturnValue([1, 2]); // 2 iter
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_http', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    // body1 contato solo nel loop, non come single-exec
    expect(r.totalNodeExecutions).toBe(2); // 1 body × 2 iter
    expect(r.totalEstimatedCostUsd).toBeCloseTo(0.002, 4); // 0.001 × 2
  });
});

describe('multi-loop workflow', () => {
  it('🚨 2 loop indipendenti → 2 LoopEstimate', () => {
    m.evaluateExpression
      .mockReturnValueOnce([1, 2])
      .mockReturnValueOnce([3, 4, 5]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_simple', config: {} },
          { id: 'loop2', defId: 'logic_loop', config: {} },
          { id: 'body2', defId: 'action_simple', config: {} },
        ],
        edges: [
          { from: 'loop1', to: 'body1', fromPort: 'body' },
          { from: 'loop2', to: 'body2', fromPort: 'body' },
        ],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r.loops).toHaveLength(2);
    expect(r.loops[0]?.iterationCount).toBe(2);
    expect(r.loops[1]?.iterationCount).toBe(3);
  });
});

describe('output shape', () => {
  it('WorkflowEstimate include tutti i campi richiesti', () => {
    m.evaluateExpression.mockReturnValue([1]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    expect(r).toMatchObject({
      workflowId: 'wf-1',
      loops: expect.any(Array),
      totalEstimatedCostUsd: expect.any(Number),
      totalEstimatedDurationMs: expect.any(Number),
      totalNodeExecutions: expect.any(Number),
      rateLimitWarnings: expect.any(Array),
    });
  });

  it('LoopEstimate include suggestedStrategy + reason + warnings', () => {
    m.evaluateExpression.mockReturnValue([1]);
    const r = svc.estimate(makeInput({
      workflow: {
        id: 'wf-1',
        nodes: [
          { id: 'loop1', defId: 'logic_loop', config: {} },
          { id: 'body1', defId: 'action_simple', config: {} },
        ],
        edges: [{ from: 'loop1', to: 'body1', fromPort: 'body' }],
      } as unknown as EstimateInput['workflow'],
    }));
    const loop = r.loops[0];
    expect(loop).toMatchObject({
      loopId: 'loop1',
      iterationCount: expect.any(Number),
      iterationCountSource: expect.any(String),
      bodyNodeCount: expect.any(Number),
      totalNodeExecutions: expect.any(Number),
      estimatedCostUsd: expect.any(Number),
      estimatedDurationMs: expect.any(Number),
      declaredStrategy: expect.any(String),
      suggestedStrategy: expect.any(String),
      suggestionReason: expect.any(String),
      warnings: expect.any(Array),
    });
  });
});
