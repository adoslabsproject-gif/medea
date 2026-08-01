/**
 * AIInteractionsService — capture, query, and export AI Assistant interactions
 * for fine-tuning dataset curation.
 *
 * Lifecycle of a row:
 *   1. INSERT at request time   — outcome='pending', PII-redacted prompt+response
 *   2. UPDATE outcome later     — when user clicks Accept/Reject on a patch
 *   3. UPDATE quality manually  — reviewer scores 0-5, assigns training_split
 *   4. EXPORT for training      — JSONL of {messages:[...]} for axolotl/HF
 *   5. SWEEP after retention    — cron deletes rows past retention_until
 *
 * Per-tenant opt-out is honored: when capture_enabled=false in
 * ai_training_settings, the insert is silently skipped (returns null id).
 * This is the privacy guarantee: a tenant CAN turn off capture and we never
 * touch their data.
 *
 * Why we redact BEFORE insert: the database (and any backup, replica, audit
 * dump) never sees raw PII. Even if an attacker dumps SQLite, all they see
 * is "<EMAIL>" placeholders. The original PII lives ONLY in transit (request
 * memory) and is GC'd as soon as the HTTP handler returns.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { piiRedactor } from './pii-redactor.service.js';
import { logger } from '@/lib/logger.js';
import { AISignalsService } from './ai-signals.service.js';

export type InteractionType = 'editor_chat' | 'run_explain' | 'node_generate' | 'workflow_from_text';
export type Outcome = 'pending' | 'accepted' | 'rejected' | 'edited' | 'ignored' | 'failed';
export type TrainingSplit = 'train' | 'val' | 'test' | 'excluded';

/**
 * Insert payload, grouped for readability.
 *
 * Why grouped: a flat 12-field object is harder to scan and lets you
 * accidentally swap `prompt` with `responseMessage`. Grouping signals intent
 * ("these are about WHO, these are about WHAT was asked, these are about
 * WHAT was answered") and makes the callsite read like prose.
 */
export interface InsertArgs {
  /** Multi-tenant identity for the interaction. */
  context: {
    tenantId: string;
    userId?: string;
    workflowId?: string;
  };
  /** What kind of interaction this is — drives later filtering / dataset slicing. */
  interactionType: InteractionType;
  /** What the user / system gave the model. */
  request: {
    prompt: string;
    workflowSnapshot?: unknown;
    conversationHistory?: { role: string; content: string }[];
  };
  /** What the model returned, with metadata. */
  response: {
    message: string;
    patch?: unknown;
    model: string;
    latencyMs: number;
    tokensIn?: number;
    tokensOut?: number;
  };
}

export interface OutcomeUpdateArgs {
  interactionId: string;
  tenantId: string;
  outcome: Outcome;
  patchApplied?: unknown;
  followupRunId?: string;
  followupRunStatus?: string;
}

export interface ReviewUpdateArgs {
  interactionId: string;
  tenantId: string;
  qualityScore: number;             // 0-5
  reviewerUserId: string;
  reviewerNotes?: string;
  trainingSplit?: TrainingSplit;
}

export interface InteractionRow {
  id: string;
  tenantId: string;
  userId: string | null;
  workflowId: string | null;
  interactionType: InteractionType;
  createdAt: string;
  prompt: string;
  workflowSnapshot: unknown;
  conversationHistory: { role: string; content: string }[];
  responseMessage: string;
  responsePatch: unknown;
  responseModel: string;
  responseLatencyMs: number;
  responseTokensIn: number | null;
  responseTokensOut: number | null;
  outcome: Outcome;
  outcomeAt: string | null;
  outcomePatchApplied: unknown;
  outcomeFollowupRunId: string | null;
  outcomeFollowupRunStatus: string | null;
  qualityScore: number | null;
  reviewerUserId: string | null;
  reviewerNotes: string | null;
  piiRedacted: boolean;
  piiClasses: string[];
  retentionUntil: string;
  trainingSplit: TrainingSplit | null;
}

interface RawRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  workflow_id: string | null;
  interaction_type: string;
  created_at: string;
  prompt: string;
  workflow_snapshot_json: string | null;
  conversation_history_json: string | null;
  response_message: string;
  response_patch_json: string | null;
  response_model: string;
  response_latency_ms: number;
  response_tokens_in: number | null;
  response_tokens_out: number | null;
  outcome: string;
  outcome_at: string | null;
  outcome_patch_applied_json: string | null;
  outcome_followup_run_id: string | null;
  outcome_followup_run_status: string | null;
  quality_score: number | null;
  reviewer_user_id: string | null;
  reviewer_notes: string | null;
  pii_redacted: number;
  pii_classes_json: string | null;
  retention_until: string;
  training_split: string | null;
}

function rowToInteraction(r: RawRow): InteractionRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    workflowId: r.workflow_id,
    interactionType: r.interaction_type as InteractionType,
    createdAt: r.created_at,
    prompt: r.prompt,
    workflowSnapshot: r.workflow_snapshot_json ? JSON.parse(r.workflow_snapshot_json) : null,
    conversationHistory: r.conversation_history_json ? JSON.parse(r.conversation_history_json) as { role: string; content: string }[] : [],
    responseMessage: r.response_message,
    responsePatch: r.response_patch_json ? JSON.parse(r.response_patch_json) : null,
    responseModel: r.response_model,
    responseLatencyMs: r.response_latency_ms,
    responseTokensIn: r.response_tokens_in,
    responseTokensOut: r.response_tokens_out,
    outcome: r.outcome as Outcome,
    outcomeAt: r.outcome_at,
    outcomePatchApplied: r.outcome_patch_applied_json ? JSON.parse(r.outcome_patch_applied_json) : null,
    outcomeFollowupRunId: r.outcome_followup_run_id,
    outcomeFollowupRunStatus: r.outcome_followup_run_status,
    qualityScore: r.quality_score,
    reviewerUserId: r.reviewer_user_id,
    reviewerNotes: r.reviewer_notes,
    piiRedacted: r.pii_redacted === 1,
    piiClasses: r.pii_classes_json ? JSON.parse(r.pii_classes_json) as string[] : [],
    retentionUntil: r.retention_until,
    trainingSplit: r.training_split as TrainingSplit | null,
  };
}

export class AIInteractionsService {
  /** Track A: segnale non-personale, sempre attivo (vedi insert()). */
  private readonly signals = new AISignalsService();

  /**
   * Check if Track B (raw-text) capture is enabled for the tenant.
   * ⚖️ DEFAULT OFF (opt-in): nessuna row = nessun consenso esplicito = niente
   * cattura del testo grezzo. Il consenso GDPR non può essere pre-spuntato
   * (CGUE Planet49). Il segnale aggregato NON-personale (Track A) è separato e
   * sempre attivo.
   */
  isCaptureEnabled(tenantId: string): boolean {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT capture_enabled FROM ai_training_settings WHERE tenant_id = ?')
      .get(tenantId) as { capture_enabled: number } | undefined;
    if (!row) return false; // default OFF — opt-in esplicito richiesto
    return row.capture_enabled === 1;
  }

  /**
   * Set capture preferences for a tenant. Quando si ABILITA, registra la prova
   * del consenso (`consent_at` + chi l'ha dato) per l'accountability art.7 GDPR;
   * quando si DISABILITA (revoca), azzera entrambi.
   */
  setCapturePreference(
    tenantId: string,
    captureEnabled: boolean,
    retentionDays = 90,
    consentByUserId?: string | null,
  ): void {
    const { sqlite } = getDatabase();
    const consentAt = captureEnabled ? new Date().toISOString() : null;
    const consentBy = captureEnabled ? (consentByUserId ?? null) : null;
    sqlite
      .prepare(`
        INSERT INTO ai_training_settings (tenant_id, capture_enabled, retention_days, consent_at, consent_by_user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(tenant_id) DO UPDATE SET
          capture_enabled = excluded.capture_enabled,
          retention_days = excluded.retention_days,
          consent_at = excluded.consent_at,
          consent_by_user_id = excluded.consent_by_user_id,
          updated_at = excluded.updated_at
      `)
      .run(tenantId, captureEnabled ? 1 : 0, retentionDays, consentAt, consentBy);
  }

  getCaptureSettings(tenantId: string): {
    captureEnabled: boolean;
    retentionDays: number;
    consentAt: string | null;
    consentByUserId: string | null;
    /** true se il tenant ha GIÀ scelto (esiste una row) — false = mai deciso.
     *  Serve all'onboarding per mostrare il prompt UNA volta sola. */
    decided: boolean;
  } {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT capture_enabled, retention_days, consent_at, consent_by_user_id FROM ai_training_settings WHERE tenant_id = ?')
      .get(tenantId) as
        | { capture_enabled: number; retention_days: number; consent_at: string | null; consent_by_user_id: string | null }
        | undefined;
    if (!row) return { captureEnabled: false, retentionDays: 90, consentAt: null, consentByUserId: null, decided: false };
    return {
      captureEnabled: row.capture_enabled === 1,
      retentionDays: row.retention_days,
      consentAt: row.consent_at,
      consentByUserId: row.consent_by_user_id,
      decided: true,
    };
  }

  /**
   * Insert a new interaction. Returns the new id on success, or null when
   * capture is disabled for the tenant. PII redaction happens HERE — the
   * caller passes raw values, the database stores redacted values only.
   */
  insert(args: InsertArgs): string | null {
    const { context, interactionType, request, response } = args;
    const id = randomUUID();

    // Track A (NON-personale, SEMPRE attivo): registra il segnale strutturale
    // PRIMA del gate opt-in di Track B, condividendo l'id. Nessun testo/PII qui.
    this.signals.record({
      id,
      tenantId: context.tenantId,
      interactionType,
      model: response.model,
      latencyMs: response.latencyMs,
      tokensIn: response.tokensIn ?? null,
      tokensOut: response.tokensOut ?? null,
    });

    if (!this.isCaptureEnabled(context.tenantId)) {
      return null; // Track B opt-out: niente testo grezzo (il segnale c'è già)
    }

    const { sqlite } = getDatabase();
    const { retentionDays } = this.getCaptureSettings(context.tenantId);

    // Redact PII from every text/JSON field — runs PIIRedactor over each
    // string before we even hold it in memory long enough to insert.
    const promptR = piiRedactor.redactText(request.prompt);
    const responseR = piiRedactor.redactText(response.message);
    const workflowR = request.workflowSnapshot
      ? piiRedactor.redactJson(request.workflowSnapshot)
      : { redacted: null, classes: [] };
    const historyR = request.conversationHistory
      ? piiRedactor.redactJson(request.conversationHistory)
      : { redacted: null, classes: [] };
    const patchR = response.patch
      ? piiRedactor.redactJson(response.patch)
      : { redacted: null, classes: [] };

    const allClasses = new Set<string>([
      ...promptR.classes,
      ...responseR.classes,
      ...workflowR.classes,
      ...historyR.classes,
      ...patchR.classes,
    ]);

    const retentionUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      sqlite
        .prepare(`
          INSERT INTO ai_interactions (
            id, tenant_id, user_id, workflow_id, interaction_type,
            prompt, workflow_snapshot_json, conversation_history_json,
            response_message, response_patch_json, response_model,
            response_latency_ms, response_tokens_in, response_tokens_out,
            pii_redacted, pii_classes_json, retention_until
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          context.tenantId,
          context.userId ?? null,
          context.workflowId ?? null,
          interactionType,
          promptR.redacted,
          workflowR.redacted !== null ? JSON.stringify(workflowR.redacted) : null,
          historyR.redacted !== null ? JSON.stringify(historyR.redacted) : null,
          responseR.redacted,
          patchR.redacted !== null ? JSON.stringify(patchR.redacted) : null,
          response.model,
          response.latencyMs,
          response.tokensIn ?? null,
          response.tokensOut ?? null,
          1,
          JSON.stringify([...allClasses]),
          retentionUntil,
        );
      return id;
    } catch (err) {
      // We MUST NOT fail the AI request if capture insert fails — log and continue.
      logger.error({ err, tenantId: context.tenantId, interactionType }, 'ai_interactions insert failed');
      return null;
    }
  }

  /** Update outcome (called when user accepts/rejects/edits a proposal). */
  updateOutcome(args: OutcomeUpdateArgs): boolean {
    const { sqlite } = getDatabase();
    const patchR = args.patchApplied ? piiRedactor.redactJson(args.patchApplied) : { redacted: null };
    const res = sqlite
      .prepare(`
        UPDATE ai_interactions
        SET outcome = ?,
            outcome_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            outcome_patch_applied_json = ?,
            outcome_followup_run_id = ?,
            outcome_followup_run_status = ?
        WHERE id = ? AND tenant_id = ?
      `)
      .run(
        args.outcome,
        patchR.redacted !== null ? JSON.stringify(patchR.redacted) : null,
        args.followupRunId ?? null,
        args.followupRunStatus ?? null,
        args.interactionId,
        args.tenantId,
      );
    // Track A: rifletti l'esito anche nel segnale non-personale (always-on).
    this.signals.updateOutcome(args.interactionId, args.tenantId, args.outcome);
    return res.changes > 0;
  }

  /** Manual review update — sets quality score + training split. */
  updateReview(args: ReviewUpdateArgs): boolean {
    if (args.qualityScore < 0 || args.qualityScore > 5) {
      throw new Error('qualityScore must be 0-5');
    }
    const { sqlite } = getDatabase();
    const res = sqlite
      .prepare(`
        UPDATE ai_interactions
        SET quality_score = ?,
            reviewer_user_id = ?,
            reviewer_notes = ?,
            training_split = ?
        WHERE id = ? AND tenant_id = ?
      `)
      .run(
        args.qualityScore,
        args.reviewerUserId,
        args.reviewerNotes ?? null,
        args.trainingSplit ?? null,
        args.interactionId,
        args.tenantId,
      );
    // Track A: rifletti il quality score nel segnale aggregato.
    this.signals.updateQuality(args.interactionId, args.tenantId, args.qualityScore);
    return res.changes > 0;
  }

  /** Fetch a single row by id (tenant-scoped). */
  get(interactionId: string, tenantId: string): InteractionRow | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM ai_interactions WHERE id = ? AND tenant_id = ?')
      .get(interactionId, tenantId) as RawRow | undefined;
    return row ? rowToInteraction(row) : null;
  }

  /** Tenant-scoped list with filters. */
  list(args: {
    tenantId: string;
    interactionType?: InteractionType;
    outcome?: Outcome;
    trainingSplit?: TrainingSplit;
    minQuality?: number;
    limit?: number;
    offset?: number;
  }): { rows: InteractionRow[]; total: number } {
    const { sqlite } = getDatabase();
    const where: string[] = ['tenant_id = ?'];
    const params: unknown[] = [args.tenantId];
    if (args.interactionType) { where.push('interaction_type = ?'); params.push(args.interactionType); }
    if (args.outcome) { where.push('outcome = ?'); params.push(args.outcome); }
    if (args.trainingSplit) { where.push('training_split = ?'); params.push(args.trainingSplit); }
    if (args.minQuality !== undefined) { where.push('quality_score >= ?'); params.push(args.minQuality); }
    const whereSql = where.join(' AND ');

    const total = (sqlite
      .prepare(`SELECT COUNT(*) AS c FROM ai_interactions WHERE ${whereSql}`)
      .get(...params) as { c: number }).c;

    const rows = sqlite
      .prepare(`SELECT * FROM ai_interactions WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, args.limit ?? 50, args.offset ?? 0) as RawRow[];
    return { rows: rows.map(rowToInteraction), total };
  }

  /**
   * Export as training-set JSONL. Each line is one object compatible with
   * the HuggingFace chat-template format:
   *   { "messages": [{role,content},...] }
   *
   * Filters: only rows with outcome ∈ {accepted, edited} AND quality_score
   * non-null AND training_split ∈ {train, val, test}.
   *
   * This makes "export" safe by default — pre-review junk doesn't leak into
   * the training corpus.
   */
  exportJsonl(args: {
    tenantId: string;
    trainingSplit?: TrainingSplit;
    minQuality?: number;
  }): string {
    const minQuality = args.minQuality ?? 3;
    const where = ['tenant_id = ?', 'training_split IS NOT NULL', 'quality_score >= ?', "outcome IN ('accepted', 'edited')"];
    const params: unknown[] = [args.tenantId, minQuality];
    if (args.trainingSplit) {
      where.push('training_split = ?');
      params.push(args.trainingSplit);
    }
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(`SELECT * FROM ai_interactions WHERE ${where.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params) as RawRow[];

    const lines: string[] = [];
    for (const raw of rows) {
      const r = rowToInteraction(raw);
      // Reconstruct as multi-turn chat: history + final user turn + assistant turn
      const messages: { role: string; content: string }[] = [];
      for (const h of r.conversationHistory) {
        messages.push({ role: h.role, content: h.content });
      }
      messages.push({ role: 'user', content: r.prompt });
      // If a patch was applied or accepted, include it in assistant turn as
      // canonical fine-tuning target.
      const assistantContent = r.responsePatch
        ? JSON.stringify({ message: r.responseMessage, patch: r.responsePatch })
        : r.responseMessage;
      messages.push({ role: 'assistant', content: assistantContent });
      lines.push(JSON.stringify({ messages, metadata: { id: r.id, model: r.responseModel, quality: r.qualityScore } }));
    }
    return lines.join('\n');
  }

  /** Daily retention sweep — delete rows past retention_until. */
  sweep(): { deleted: number } {
    const { sqlite } = getDatabase();
    const res = sqlite
      .prepare("DELETE FROM ai_interactions WHERE retention_until < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      .run();
    if (res.changes > 0) {
      logger.info({ deleted: res.changes }, 'ai_interactions sweep');
    }
    return { deleted: res.changes };
  }

  /** Stats per tenant — for the Settings → AI Training Dataset panel. */
  stats(tenantId: string): {
    total: number;
    byOutcome: Record<string, number>;
    byInteractionType: Record<string, number>;
    bySplit: Record<string, number>;
    piiDetections: number;
  } {
    const { sqlite } = getDatabase();
    const total = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ?')
      .get(tenantId) as { c: number }).c;

    const byOutcomeRows = sqlite
      .prepare('SELECT outcome, COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ? GROUP BY outcome')
      .all(tenantId) as { outcome: string; c: number }[];
    const byOutcome: Record<string, number> = {};
    for (const r of byOutcomeRows) byOutcome[r.outcome] = r.c;

    const byTypeRows = sqlite
      .prepare('SELECT interaction_type, COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ? GROUP BY interaction_type')
      .all(tenantId) as { interaction_type: string; c: number }[];
    const byInteractionType: Record<string, number> = {};
    for (const r of byTypeRows) byInteractionType[r.interaction_type] = r.c;

    const bySplitRows = sqlite
      .prepare("SELECT COALESCE(training_split, 'unassigned') AS s, COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ? GROUP BY training_split")
      .all(tenantId) as { s: string; c: number }[];
    const bySplit: Record<string, number> = {};
    for (const r of bySplitRows) bySplit[r.s] = r.c;

    const piiDetections = (sqlite
      .prepare("SELECT COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ? AND pii_classes_json != '[]'")
      .get(tenantId) as { c: number }).c;

    return { total, byOutcome, byInteractionType, bySplit, piiDetections };
  }
}
