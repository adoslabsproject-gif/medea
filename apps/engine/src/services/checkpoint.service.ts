/**
 * CheckpointService — snapshot engine state every N nodes so that a
 * process restart can resume long-running workflows from the last
 * checkpoint instead of restarting from scratch.
 *
 * Trade-off: writes to `workflow_checkpoints` add ~1ms per checkpoint.
 * Default cadence is every 5 nodes (env: FLOWFORGE_CHECKPOINT_EVERY_NODES).
 * For ETL workflows (~hundreds of nodes), 5 means at most 5 nodes of work
 * lost per crash — sweet spot between durability and overhead.
 *
 * Retention: only the latest checkpoint per runId is kept; older snapshots
 * are pruned automatically when a new one is saved. Successful runs have
 * their checkpoints deleted at completion.
 */

import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import type { ICheckpointHandler, CheckpointArgs } from '@/engine/ports.js';
import type { QueueItem } from '@/engine/workflow-engine.js';
import type { ExecutionItem } from '@flowforge/core-schema';

export interface CheckpointRow {
  id: number;
  runId: string;
  workflowId: string;
  tenantId: string;
  atNodeId: string;
  outputsById: Record<string, unknown>;
  visited: string[];
  /** Tipo pieno QueueItem: mapMode (GAP 1) e sourceNodeId (GAP 2) round-trippano nel JSON. */
  pendingQueue: QueueItem[];
  /** GAP #2: lineage persistito — nodeId → ExecutionItem[]. {} per righe pre-4.2. */
  itemGraph: Record<string, ExecutionItem[]>;
  stepCount: number;
  createdAt: string;
}

interface DbRow {
  id: number;
  run_id: string;
  workflow_id: string;
  tenant_id: string;
  at_node_id: string;
  outputs_by_id_json: string;
  visited_json: string;
  pending_queue_json: string;
  item_graph_json: string | null;
  step_count: number;
  created_at: string;
}

/**
 * SQLite-backed adapter for the engine's ICheckpointHandler port.
 * Implements the periodic snapshot persistence the engine relies on.
 */
export class CheckpointService implements ICheckpointHandler {
  /** Satisfies ICheckpointHandler.save — invoked by the engine every N nodes. */
  save(input: CheckpointArgs): void {
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    // INSERT then DELETE older rows for this run — keep only the latest.
    sqlite.prepare(`
      INSERT INTO workflow_checkpoints (
        run_id, workflow_id, tenant_id, at_node_id,
        outputs_by_id_json, visited_json, pending_queue_json,
        item_graph_json, step_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.workflowId,
      input.tenantId,
      input.atNodeId,
      JSON.stringify(Object.fromEntries(input.outputsById)),
      JSON.stringify([...input.visited]),
      JSON.stringify(input.pendingQueue),
      JSON.stringify(Object.fromEntries(input.itemGraph)),
      input.stepCount,
      now,
    );
    sqlite.prepare(`
      DELETE FROM workflow_checkpoints
      WHERE run_id = ? AND id NOT IN (
        SELECT id FROM workflow_checkpoints WHERE run_id = ? ORDER BY id DESC LIMIT 1
      )
    `).run(input.runId, input.runId);
  }

  /** Latest checkpoint for a run, or null. Used by the recovery service. */
  latest(runId: string): CheckpointRow | null {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`
      SELECT * FROM workflow_checkpoints WHERE run_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(runId) as DbRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Purge all checkpoints for a successful run (called from RunService). */
  purge(runId: string): void {
    const { sqlite } = getDatabase();
    sqlite.prepare(`DELETE FROM workflow_checkpoints WHERE run_id = ?`).run(runId);
  }

  /**
   * Find runs that were 'running' but have no checkpoint within the last
   * N seconds and no ended_at — these are crashed mid-flight. Returns
   * the most-recent checkpoint per such run for the recovery worker.
   *
   * AUDIT FIX WE-3 (2026-06-09 CRITICAL): atomic claim.
   *
   * Pre-fix: SELECT puro senza UPDATE. Race condition reali:
   *   • Rolling deploy / binary distro lanciato 2 volte sullo stesso DB
   *     SQLite → 2 process leggono gli stessi orphan → 2 resume → side-effect
   *     duplicato (double payment, double email, double DB insert).
   *   • Anche in container-per-tenant single-process, un crash recovery loop
   *     non-idempotente può ri-leggere lo stesso run prima che il resume
   *     abbia tempo di marcare lo status come finalizzato.
   *
   * Fix: 2-step transazione SQLite (read-modify-write atomic). PREMA UPDATE
   * status='running' → 'recovering' con RETURNING ids, POI SELECT checkpoint
   * solo per gli id claimati. Un secondo invocazione vedrà status='recovering'
   * (non più 'running') e ritornerà 0 row → no double resume.
   */
  findOrphanedRuns(staleAfterSeconds = 120): CheckpointRow[] {
    const { sqlite } = getDatabase();
    const threshold = new Date(Date.now() - staleAfterSeconds * 1000).toISOString();

    // CLAIM atomic dentro una transazione SQLite (better-sqlite3 garantisce
    // serializability del file write-lock per la durata della tx).
    const claimAndFetch = sqlite.transaction((): CheckpointRow[] => {
      // Step 1: identifica i candidate (runs.id eligible). Necessario un
      // SELECT preliminare perché UPDATE ... RETURNING richiede il filtro
      // sul JOIN con workflow_checkpoints — SQLite UPDATE non supporta JOIN.
      const candidateRuns = sqlite.prepare(`
        SELECT DISTINCT r.id AS run_id FROM runs r
        INNER JOIN (
          SELECT run_id, MAX(id) AS max_id, MAX(created_at) AS max_created
          FROM workflow_checkpoints GROUP BY run_id
        ) cp ON cp.run_id = r.id
        WHERE r.status = 'running' AND r.ended_at IS NULL AND cp.max_created < ?
      `).all(threshold) as { run_id: string }[];

      if (candidateRuns.length === 0) return [];

      // Step 2: UPDATE atomic status running → recovering SOLO per i runs ancora
      // in stato 'running' (WHERE status='running'). RETURNING ritorna SOLO le
      // righe effettivamente claimate da QUESTA transazione. Un'altra process
      // che è arrivata prima vedrà 0 rows. Garantisce "at-most-once resume".
      const placeholders = candidateRuns.map(() => '?').join(',');
      const claimedIds = sqlite.prepare(`
        UPDATE runs SET status = 'recovering', updated_at = ?
        WHERE id IN (${placeholders}) AND status = 'running' AND ended_at IS NULL
        RETURNING id
      `).all(
        new Date().toISOString(),
        ...candidateRuns.map((r) => r.run_id),
      ) as { id: string }[];

      if (claimedIds.length === 0) return [];

      // Step 3: fetch the latest checkpoint per ognuno dei runs claimati.
      const claimedPh = claimedIds.map(() => '?').join(',');
      const rows = sqlite.prepare(`
        SELECT c.* FROM workflow_checkpoints c
        INNER JOIN (
          SELECT run_id, MAX(id) AS max_id FROM workflow_checkpoints GROUP BY run_id
        ) latest ON c.id = latest.max_id
        WHERE c.run_id IN (${claimedPh})
      `).all(...claimedIds.map((r) => r.id)) as DbRow[];

      return rows.map((r) => this.mapRow(r));
    });

    return claimAndFetch();
  }

  private mapRow(row: DbRow): CheckpointRow {
    return {
      id: row.id,
      runId: row.run_id,
      workflowId: row.workflow_id,
      tenantId: row.tenant_id,
      atNodeId: row.at_node_id,
      outputsById: JSON.parse(row.outputs_by_id_json) as Record<string, unknown>,
      visited: JSON.parse(row.visited_json) as string[],
      pendingQueue: JSON.parse(row.pending_queue_json) as QueueItem[],
      // Righe pre-4.2: colonna NULL → grafo vuoto (lineage assente, mai sbagliato).
      itemGraph: row.item_graph_json !== null
        ? JSON.parse(row.item_graph_json) as Record<string, ExecutionItem[]>
        : {},
      stepCount: row.step_count,
      createdAt: row.created_at,
    };
  }
}

/**
 * Recovery service — at boot, scans for crashed runs (status='running',
 * no ended_at) with checkpoints and resumes them. Runs once per process
 * start; subsequent re-runs are guarded by Redis locks (distributed mode).
 */
export class CheckpointRecoveryService {
  constructor(
    private readonly checkpoints: CheckpointService,
    private readonly resumeRun: (runId: string) => Promise<void>,
  ) {}

  async recover(): Promise<number> {
    const orphans = this.checkpoints.findOrphanedRuns();
    if (orphans.length === 0) return 0;
    logger.info({ count: orphans.length }, 'Recovering orphaned runs from checkpoints');
    for (const cp of orphans) {
      try {
        await this.resumeRun(cp.runId);
      } catch (err) {
        logger.error({ err, runId: cp.runId }, 'Checkpoint recovery failed for run');
      }
    }
    return orphans.length;
  }
}
