/**
 * error_outbox — repository (per-canale, at-least-once).
 *
 * Primitive PURE su `SqliteCompatProxy` iniettato → testabili su DB in-memory reale
 * (niente mock, vincoli SQL veri). L'orchestrazione (backoff, dead-letter, dispatch)
 * vive nel worker; qui solo CRUD tipizzato.
 *
 * Invarianti (review 2026-06-19):
 *  - enqueue idempotente per (run_id, channel) — INSERT OR IGNORE (#6 dedup).
 *  - claim solo `pending` "dovuti" (next_attempt_at ≤ now), ordine FIFO.
 *  - markDead = capolinea poison (#2), non più ri-claimato.
 *  - error_message cappato (anti-bloat riga + anti-OOM su stack enormi).
 *  - gc rimuove done/dead vecchi (#6 retention, la tabella non cresce all'infinito).
 */

import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ErrorOutboxChannel, ErrorOutboxStatus } from '@/storage/schema.js';

/** Cap del messaggio d'errore persistito (uno stack enorme non gonfia la riga). */
export const MAX_ERROR_MESSAGE = 2000;

export interface ErrorOutboxInsert {
  id: string;
  runId: string;
  channel: ErrorOutboxChannel;
  workflowId: string;
  tenantId: string;
  errorNodeId: string | null;
  errorMessage: string | null;
  errorHash: string | null;
  durationMs: number | null;
  startedAt: string;
  triggerType: string | null;
  triggerInputJson: string | null;
  nextAttemptAt: string;
}

export interface ErrorOutboxRecord {
  id: string;
  runId: string;
  channel: ErrorOutboxChannel;
  workflowId: string;
  tenantId: string;
  errorNodeId: string | null;
  errorMessage: string | null;
  errorHash: string | null;
  durationMs: number | null;
  startedAt: string;
  triggerType: string | null;
  triggerInputJson: string | null;
  status: ErrorOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shape grezza della riga SQLite (snake_case). */
interface RawRow {
  id: string;
  run_id: string;
  channel: string;
  workflow_id: string;
  tenant_id: string;
  error_node_id: string | null;
  error_message: string | null;
  error_hash: string | null;
  duration_ms: number | null;
  started_at: string;
  trigger_type: string | null;
  trigger_input_json: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const nowIso = (): string => new Date().toISOString();

function toRecord(r: RawRow): ErrorOutboxRecord {
  return {
    id: r.id,
    runId: r.run_id,
    channel: r.channel as ErrorOutboxChannel,
    workflowId: r.workflow_id,
    tenantId: r.tenant_id,
    errorNodeId: r.error_node_id,
    errorMessage: r.error_message,
    errorHash: r.error_hash,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    triggerType: r.trigger_type,
    triggerInputJson: r.trigger_input_json,
    status: r.status as ErrorOutboxStatus,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Inserisce UNA riga di dispatch per canale. Idempotente: un secondo enqueue con
 * lo stesso (run_id, channel) è no-op (UNIQUE) → ritorna false. Il messaggio è
 * cappato a MAX_ERROR_MESSAGE.
 */
export function enqueueErrorEvent(sqlite: SqliteCompatProxy, ev: ErrorOutboxInsert): boolean {
  const msg = ev.errorMessage === null ? null : ev.errorMessage.slice(0, MAX_ERROR_MESSAGE);
  const res = sqlite
    .prepare(
      `INSERT OR IGNORE INTO error_outbox
        (id, run_id, channel, workflow_id, tenant_id, error_node_id, error_message,
         error_hash, duration_ms, started_at, trigger_type, trigger_input_json,
         status, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    )
    .run(
      ev.id, ev.runId, ev.channel, ev.workflowId, ev.tenantId, ev.errorNodeId, msg,
      ev.errorHash, ev.durationMs, ev.startedAt, ev.triggerType, ev.triggerInputJson,
      ev.nextAttemptAt,
    );
  return res.changes > 0;
}

/** Pending "dovuti" (next_attempt_at ≤ now), FIFO. Esclude done/dead/futuri. */
export function claimDueErrorEvents(sqlite: SqliteCompatProxy, now: string, limit: number): ErrorOutboxRecord[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM error_outbox
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(now, limit) as RawRow[];
  return rows.map(toRecord);
}

/** Consegnato → 'done' (non più claimato). */
export function markErrorEventDone(sqlite: SqliteCompatProxy, id: string): void {
  sqlite.prepare(`UPDATE error_outbox SET status = 'done', updated_at = ? WHERE id = ?`).run(nowIso(), id);
}

/** Fallimento ritentabile → attempts+1 + prossimo tentativo schedulato (resta pending). */
export function markErrorEventRetry(sqlite: SqliteCompatProxy, id: string, nextAttemptAt: string, lastError: string): void {
  sqlite
    .prepare(`UPDATE error_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(nextAttemptAt, lastError.slice(0, MAX_ERROR_MESSAGE), nowIso(), id);
}

/** Capolinea poison (#2) → 'dead' (non più claimato, non blocca la coda). */
export function markErrorEventDead(sqlite: SqliteCompatProxy, id: string, lastError: string): void {
  sqlite
    .prepare(`UPDATE error_outbox SET status = 'dead', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(lastError.slice(0, MAX_ERROR_MESSAGE), nowIso(), id);
}

/** GC retention (#6): elimina done/dead aggiornati prima di `before`. Ritorna righe rimosse. */
export function gcErrorOutbox(sqlite: SqliteCompatProxy, before: string): number {
  const res = sqlite
    .prepare(`DELETE FROM error_outbox WHERE status IN ('done', 'dead') AND updated_at < ?`)
    .run(before);
  return res.changes;
}
