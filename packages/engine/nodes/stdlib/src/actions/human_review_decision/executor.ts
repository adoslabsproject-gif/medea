/**
 * `flow_human_review_decision` — executor.
 *
 * Logic
 * ─────
 *   1. Read `confidence` from input[confidenceField] (and optional secondary).
 *      Take the MINIMUM when secondary is present.
 *   2. Read `label` from input[labelField].
 *   3. If `label` is in alwaysReviewLabels → branch "review" + reason "always_review".
 *   4. Else if confidence is null/NaN AND fallbackOnMissing → "review" + reason "missing".
 *   5. Else if confidence < threshold → "review" + reason "low_confidence".
 *   6. Else → "auto" + reason null.
 *
 * Output
 * ──────
 *   {
 *     ...input,                  // pass-through preserved
 *     decision: 'auto' | 'review',
 *     confidence, threshold,
 *     reason: string | null,
 *     reviewedLabel: string | null,
 *   }
 *
 * Pure (no I/O, no side-effects). Audit log is the caller's job — we just
 * surface a structured reason.
 *
 * @module actions/human_review_decision/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { HumanReviewDecisionConfigSchema } from './schema.js';

const VALID_LABEL_RE = /^[a-z0-9_]+$/;

export const humanReviewDecisionExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(HumanReviewDecisionConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const obj = unwrap(input);
  const conf = readConfidence(obj, cfg.confidenceField, cfg.secondaryConfidenceField);
  const label = readLabel(obj, cfg.labelField);
  const alwaysSet = parseAlwaysReview(cfg.alwaysReviewLabels);

  let decision: 'auto' | 'review';
  let reason: string | null = null;

  if (label !== null && alwaysSet.has(label)) {
    decision = 'review';
    reason = 'always_review_label';
  } else if (conf === null) {
    if (cfg.fallbackOnMissing) {
      decision = 'review';
      reason = 'missing_confidence';
    } else {
      decision = 'auto';
    }
  } else if (conf < cfg.confidenceThreshold) {
    decision = 'review';
    reason = 'low_confidence';
  } else {
    decision = 'auto';
  }

  const renderedReason = cfg.reasonTemplate && reason
    ? renderReasonTemplate(cfg.reasonTemplate, { label, confidence: conf, threshold: cfg.confidenceThreshold })
    : reason;

  const output: Record<string, unknown> = {
    ...(obj ?? {}),
    decision,
    confidence: conf,
    threshold: cfg.confidenceThreshold,
    reason: renderedReason,
    reviewedLabel: label,
  };

  const ret: NodeExecutionResult = {
    output,
    branch: decision,
    durationMs: Date.now() - startedAt,
  };
  return ret;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function unwrap(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') return null;
  const root = input as Record<string, unknown>;
  if (root.output !== null && typeof root.output === 'object' &&
      !('decision' in root) /* avoid double-unwrap from a previous review */) {
    return root.output as Record<string, unknown>;
  }
  return root;
}

function readConfidence(
  obj: Record<string, unknown> | null,
  primary: string,
  secondary: string | undefined,
): number | null {
  if (obj === null) return null;
  const a = pickNumber(obj[primary]);
  const b = secondary ? pickNumber(obj[secondary]) : null;
  if (a === null && b === null) return null;
  if (a !== null && b !== null) return Math.min(a, b);
  return a ?? b;
}

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readLabel(obj: Record<string, unknown> | null, field: string): string | null {
  if (obj === null) return null;
  const v = obj[field];
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t.length === 0 || t.length > 80) return null;
  return VALID_LABEL_RE.test(t) ? t : null;
}

function parseAlwaysReview(raw: string): Set<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const piece of raw.split(/[,\s]+/)) {
    const t = piece.trim().toLowerCase();
    if (t.length === 0) continue;
    if (!VALID_LABEL_RE.test(t)) continue;
    out.add(t);
  }
  return out;
}

function renderReasonTemplate(
  tpl: string,
  vars: { label: string | null; confidence: number | null; threshold: number },
): string {
  return tpl.replace(/\{(label|confidence|threshold)\}/g, (_, k) => {
    if (k === 'label') return vars.label ?? '';
    if (k === 'confidence') return vars.confidence === null ? '' : String(vars.confidence);
    if (k === 'threshold') return String(vars.threshold);
    return '';
  });
}
