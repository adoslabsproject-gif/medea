/**
 * PausedWorkflowsService — the heart of FlowForge's "async frames".
 *
 * Responsibilities:
 *   1. Pause: persist run state when the engine hits a logic_wait_signal.
 *   2. Resume by signal: when POST /signals/:name fires, find the matching
 *      paused row(s), restore state, and re-enter the engine.
 *   3. Timeout janitor: every 60s scan for paused rows past their
 *      timeout_at; resume them with the configured default payload.
 *
 * Persistence model: a single row in `paused_workflows` per suspension.
 * State is serialized as JSON. Row is deleted only after the workflow
 * has resumed AND committed its final run state (so a crash mid-resume
 * doesn't lose the suspension).
 */

import { coerceString } from '@/lib/coerce.js';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import type { IPauseHandler, PauseArgs } from '@/engine/ports.js';
import type { QueueItem } from '@/engine/workflow-engine.js';
import type { ExecutionItem } from '@medea/engine-core-schema';

export interface PausedRow {
  id: string;
  runId: string;
  workflowId: string;
  tenantId: string;
  signalName: string;
  atNodeId: string;
  outputsById: Record<string, unknown>;
  visited: string[];
  /** Tipo pieno QueueItem: mapMode (GAP 1) e sourceNodeId (GAP 2) round-trippano nel JSON. */
  pendingQueue: QueueItem[];
  /** GAP #2: lineage persistito — nodeId → ExecutionItem[]. {} per righe pre-4.2. */
  itemGraph: Record<string, ExecutionItem[]>;
  status: 'waiting' | 'resumed' | 'timeout' | 'cancelled';
  timeoutAt: string | null;
  /** Payload to forward to downstream nodes when the workflow resumes. */
  defaultPayload: unknown;
  /** Correlation key (BPMN message correlation). null when not used. */
  matchKey: string | null;
  /** Correlation value evaluated at pause time. null when not used. */
  matchValue: string | null;
  createdAt: string;
}

interface DbRow {
  id: string;
  run_id: string;
  workflow_id: string;
  tenant_id: string;
  signal_name: string;
  at_node_id: string;
  outputs_by_id_json: string;
  visited_json: string;
  pending_queue_json: string;
  item_graph_json: string | null;
  resume_payload_json: string | null;
  status: string;
  timeout_at: string | null;
  match_key: string | null;
  match_value: string | null;
  created_at: string;
  resumed_at: string | null;
}

/**
 * SQLite-backed adapter for the engine's IPauseHandler port. Implements
 * the `pause` method that the engine calls on logic_wait_signal nodes.
 * The rest of the class (list/cancel/sweepTimeouts/resumeBySignal) is
 * the management API used by the SignalService and the admin UI.
 */
export class PausedWorkflowsService implements IPauseHandler {
  /**
   * Pause a workflow run. Returns the paused row id (useful for cancellation
   * via UI: "abort the workflow waiting for signal X").
   *
   * Satisfies the IPauseHandler.pause contract — invoked by the engine.
   */
  pause(input: PauseArgs): string {
    const { sqlite } = getDatabase();
    const id = nanoid();
    const now = new Date().toISOString();
    const timeoutAt =
      input.timeoutSeconds > 0
        ? new Date(Date.now() + input.timeoutSeconds * 1000).toISOString()
        : null;

    sqlite
      .prepare(
        `
      INSERT INTO paused_workflows (
        id, run_id, workflow_id, tenant_id, signal_name, at_node_id,
        outputs_by_id_json, visited_json, pending_queue_json, item_graph_json,
        resume_payload_json, status, timeout_at, match_key, match_value, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.runId,
        input.workflowId,
        input.tenantId,
        input.signalName,
        input.atNodeId,
        JSON.stringify(Object.fromEntries(input.outputsById)),
        JSON.stringify([...input.visited]),
        JSON.stringify(input.pendingQueue),
        JSON.stringify(Object.fromEntries(input.itemGraph)),
        JSON.stringify(input.defaultPayload ?? {}),
        timeoutAt,
        input.matchKey ?? null,
        input.matchValue ?? null,
        now,
      );

    logger.info(
      {
        id,
        runId: input.runId,
        signal: input.signalName,
        matchKey: input.matchKey,
        matchValue: input.matchValue,
        timeoutAt,
      },
      'Workflow paused',
    );
    return id;
  }

  /**
   * Resume by signal — BPMN-style message correlation.
   *
   * Rules:
   *   1. SCOPE — only `waiting` rows of the given tenant & signalName.
   *   2. MATCH — if a row has a `match_key` saved (set at pause time
   *      from the wait_signal node's config), the signal body MUST
   *      contain that key AND its value MUST equal the row's
   *      `match_value`. Otherwise the row is skipped.
   *      Rows with no `match_key` always resume on the signal.
   *   3. COMMIT — atomic: each matched row is flipped from `waiting`
   *      to `resumed` with the signal payload recorded for replay.
   *
   * Comparison is string-based (TEXT column). Numeric signals from JSON
   * are coerced to string for the equality check — sufficient for the
   * 99% case of opaque ids ("abc-123", 42, "user_42").
   */
  resumeBySignal(tenantId: string, signalName: string, payload: unknown): PausedRow[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        `
      SELECT * FROM paused_workflows
      WHERE tenant_id = ? AND signal_name = ? AND status = 'waiting'
      ORDER BY created_at ASC
    `,
      )
      .all(tenantId, signalName) as DbRow[];

    const payloadIsObject =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload);
    const matched: DbRow[] = [];
    for (const row of rows) {
      if (row.match_key === null || row.match_value === null) {
        // No correlation set — every signal of this name resumes the row.
        matched.push(row);
        continue;
      }
      if (!payloadIsObject) continue; // need an object body to read match_key from
      const sigVal = (payload as Record<string, unknown>)[row.match_key];
      if (sigVal === undefined || sigVal === null) continue;
      if (coerceString(sigVal) !== row.match_value) continue;
      matched.push(row);
    }

    // AUDIT FIX WE-7 (2026-06-09 HIGH): UPDATE ... RETURNING per ottenere SOLO
    // i rows effettivamente claimati. Pre-fix: l'AND status='waiting' nel WHERE
    // proteggeva la mutazione MA il push() veniva sempre eseguito → 2 POST
    // /signals/X paralleli entrambi facevano runs.resumeFromPause(row) per lo
    // stesso runId = duplicate execution + side-effect duplicato.
    //
    // Post-fix: RETURNING ritorna le rows aggiornate da QUESTA transazione.
    // L'altra transazione che ha perso la race vede 0 rows → push() skipped.
    const now = new Date().toISOString();
    const result: PausedRow[] = [];
    for (const row of matched) {
      const claimed = sqlite
        .prepare(
          `
        UPDATE paused_workflows
        SET status = 'resumed', resume_payload_json = ?, resumed_at = ?
        WHERE id = ? AND status = 'waiting'
        RETURNING id
      `,
        )
        .all(JSON.stringify(payload ?? {}), now, row.id) as { id: string }[];
      if (claimed.length === 0) {
        // Un'altra signal-tx ha già claimato questo paused_workflows.id.
        // Skip silenzioso — no duplicate runs.resumeFromPause.
        continue;
      }
      result.push(this.mapRow(row, payload));
    }
    if (result.length > 0) {
      logger.info(
        { signal: signalName, candidates: rows.length, matched: result.length },
        'Signal resumed paused workflows',
      );
    }
    return result;
  }

  /**
   * Janitor sweep: resume all paused rows whose timeout has elapsed.
   * Called by SchedulerService every 60 seconds.
   */
  sweepTimeouts(): PausedRow[] {
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    const rows = sqlite
      .prepare(
        `
      SELECT * FROM paused_workflows
      WHERE status = 'waiting' AND timeout_at IS NOT NULL AND timeout_at < ?
    `,
      )
      .all(now) as DbRow[];

    // AUDIT FIX WE-7 (2026-06-09 HIGH): UPDATE ... RETURNING per atomic claim.
    // Pre-fix: SELECT + UPDATE WHERE id=? senza filtro status. Due janitor
    // multi-instance (rolling deploy) sweepavano gli stessi rows, entrambi
    // facevano UPDATE (uno reale, l'altro no-op su row già 'timeout') ma
    // entrambi push in out[] → duplicate runs.resumeFromPause.
    const out: PausedRow[] = [];
    for (const row of rows) {
      const defaultPayload: unknown = JSON.parse(row.resume_payload_json ?? '{}');
      const claimed = sqlite
        .prepare(
          `
        UPDATE paused_workflows
        SET status = 'timeout', resumed_at = ?
        WHERE id = ? AND status = 'waiting'
        RETURNING id
      `,
        )
        .all(now, row.id) as { id: string }[];
      if (claimed.length === 0) continue; // racer wins, skip
      out.push(this.mapRow(row, defaultPayload));
    }
    if (out.length > 0) {
      logger.info({ count: out.length }, 'Janitor swept timed-out paused workflows');
    }
    return out;
  }

  listByTenant(tenantId: string, status?: PausedRow['status']): PausedRow[] {
    const { sqlite } = getDatabase();
    const rows = status
      ? (sqlite
          .prepare(
            `
          SELECT * FROM paused_workflows WHERE tenant_id = ? AND status = ?
          ORDER BY created_at DESC LIMIT 200
        `,
          )
          .all(tenantId, status) as DbRow[])
      : (sqlite
          .prepare(
            `
          SELECT * FROM paused_workflows WHERE tenant_id = ?
          ORDER BY created_at DESC LIMIT 200
        `,
          )
          .all(tenantId) as DbRow[]);
    return rows.map((r) => this.mapRow(r));
  }

  cancel(id: string, tenantId: string): boolean {
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    const res = sqlite
      .prepare(
        `
      UPDATE paused_workflows
      SET status = 'cancelled', resumed_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'waiting'
    `,
      )
      .run(now, id, tenantId);
    return res.changes > 0;
  }

  private mapRow(row: DbRow, override?: unknown): PausedRow {
    return {
      id: row.id,
      runId: row.run_id,
      workflowId: row.workflow_id,
      tenantId: row.tenant_id,
      signalName: row.signal_name,
      atNodeId: row.at_node_id,
      outputsById: JSON.parse(row.outputs_by_id_json) as Record<string, unknown>,
      visited: JSON.parse(row.visited_json) as string[],
      pendingQueue: JSON.parse(row.pending_queue_json) as QueueItem[],
      // Righe pre-4.2: colonna NULL → grafo vuoto (lineage assente, mai sbagliato).
      itemGraph:
        row.item_graph_json !== null && row.item_graph_json !== undefined
          ? (JSON.parse(row.item_graph_json) as Record<string, ExecutionItem[]>)
          : {},
      status: row.status as PausedRow['status'],
      timeoutAt: row.timeout_at,
      defaultPayload:
        override ?? (row.resume_payload_json !== null ? JSON.parse(row.resume_payload_json) : null),
      matchKey: row.match_key,
      matchValue: row.match_value,
      createdAt: row.created_at,
    };
  }
}
