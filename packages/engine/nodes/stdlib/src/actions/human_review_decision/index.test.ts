/**
 * Test del nodo `flow_human_review_decision`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { NodeExecutionContext } from '../../types.js';
import { humanReviewDecisionNode } from './index.js';

function ctx(): NodeExecutionContext {
  return {
    workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

describe('humanReviewDecisionExecutor', () => {
  it('routes high-confidence to "auto"', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.7 },
      { confidence: 0.9, label: 'fiscale', subject: 'X' },
      ctx(),
    );
    expect(r.branch).toBe('auto');
    const o = r.output as Record<string, unknown>;
    expect(o.decision).toBe('auto');
    expect(o.reason).toBeNull();
    expect(o.subject).toBe('X');  // pass-through
  });

  it('routes low-confidence to "review" with reason=low_confidence', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.8 },
      { confidence: 0.5, label: 'fiscale' },
      ctx(),
    );
    expect(r.branch).toBe('review');
    expect((r.output as Record<string, unknown>).reason).toBe('low_confidence');
  });

  it('forces review on alwaysReviewLabels even with high confidence', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5, alwaysReviewLabels: 'legal_request,fraud' },
      { confidence: 0.95, label: 'fraud' },
      ctx(),
    );
    expect(r.branch).toBe('review');
    expect((r.output as Record<string, unknown>).reason).toBe('always_review_label');
  });

  it('uses the MINIMUM when secondary confidence is configured', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.7, secondaryConfidenceField: 'consistency' },
      { confidence: 0.9, consistency: 0.4, label: 'x' },
      ctx(),
    );
    expect(r.branch).toBe('review');
  });

  it('respects custom confidenceField=score', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5, confidenceField: 'score' },
      { score: 0.6, label: 'x' },
      ctx(),
    );
    expect(r.branch).toBe('auto');
  });

  it('fallback=true → review when confidence missing', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5 },
      { label: 'x' },  // no confidence
      ctx(),
    );
    expect(r.branch).toBe('review');
    expect((r.output as Record<string, unknown>).reason).toBe('missing_confidence');
  });

  it('fallback=false → auto when confidence missing', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5, fallbackOnMissing: false },
      { label: 'x' },
      ctx(),
    );
    expect(r.branch).toBe('auto');
  });

  it('renders reasonTemplate with {label}+{confidence}+{threshold}', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.7, reasonTemplate: 'low_{label}_conf={confidence}_th={threshold}' },
      { confidence: 0.4, label: 'fiscale' },
      ctx(),
    );
    expect((r.output as Record<string, unknown>).reason).toBe('low_fiscale_conf=0.4_th=0.7');
  });

  it('ignores numeric-string confidence parses ("0.9")', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.7 },
      { confidence: '0.9', label: 'x' },
      ctx(),
    );
    expect(r.branch).toBe('auto');
  });

  it('rejects malformed label (regex guard) — treated as null', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5, alwaysReviewLabels: 'fraud', labelField: 'cat' },
      { confidence: 0.9, cat: 'fra ud!' },  // not a clean label
      ctx(),
    );
    expect(r.branch).toBe('auto');
  });

  it('alwaysReviewLabels parses space + comma separated lists', async () => {
    const r = await humanReviewDecisionNode.executor(
      { confidenceThreshold: 0.5, alwaysReviewLabels: '  fraud,legal_request   payment_failed  ' },
      { confidence: 0.99, label: 'legal_request' },
      ctx(),
    );
    expect(r.branch).toBe('review');
  });

  it('output pass-through preserves nested fields', async () => {
    const r = await humanReviewDecisionNode.executor(
      {},
      { confidence: 0.9, label: 'x', payload: { from: 'a', body: 'b' } },
      ctx(),
    );
    expect(((r.output as { payload: Record<string, string> }).payload).from).toBe('a');
  });
});

// ════════════════════════════════════════════════════════════════════
// NodeDef contract — branching enabled (bug 2026-06-05 fan-out)
// ════════════════════════════════════════════════════════════════════
describe('humanReviewDecisionNodeDef contract', () => {
  it('declares branching:true (engine usa chosenBranch per filtrare edge)', () => {
    expect(humanReviewDecisionNode.def.branching).toBe(true);
  });

  it('declares outputs = [auto, review]', () => {
    expect(humanReviewDecisionNode.def.outputs).toEqual(['auto', 'review']);
  });

  it('REGRESSION: executor.branch e` SEMPRE in outputs (no fan-out a porte fantasma)', async () => {
    const outputs = new Set(humanReviewDecisionNode.def.outputs);
    // Run di tutte le combinazioni significative; ogni branch returned deve essere in outputs.
    const cases = [
      { confidence: 0.95, label: 'fiscale' },
      { confidence: 0.3, label: 'fiscale' },
      { confidence: null as unknown as number, label: 'fiscale' },
      { confidence: 0.95, label: 'fraud' },  // forced
    ];
    for (const input of cases) {
      const r = await humanReviewDecisionNode.executor(
        { confidenceThreshold: 0.7, alwaysReviewLabels: 'fraud' },
        input,
        ctx(),
      );
      expect(outputs.has(r.branch!)).toBe(true);
    }
  });
});
