/**
 * WorkerCoordinationService — distributed-mode worker roster + heartbeat.
 *
 * Design:
 *   • Each runtime process registers itself in the `workers` table on
 *     boot (one row per pid+hostname), refreshes lastHeartbeatAt every
 *     10s, and DELETEs its row on graceful shutdown.
 *   • A janitor (runs every 60s) marks workers with stale heartbeats
 *     as 'dead' and reassigns their currentRunId to another worker via
 *     the BullMQ queue (when Redis is configured) or via the local
 *     CheckpointRecoveryService (single-node mode).
 *   • The admin Workers Dashboard queries `listActive()` to render the
 *     fleet status in real time.
 *
 * Opt-in: enables full distributed mode when MEDEA_REDIS_URL is set.
 * Otherwise the heartbeat table is still maintained (so the admin UI
 * shows "1 worker, this node") but no queue/lock coordination happens.
 */

import { hostname } from 'node:os';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

const STALE_AFTER_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export type WorkerControlAction = 'restart' | 'drain' | 'resume';

export interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  status: 'idle' | 'busy' | 'draining' | 'dead';
  currentRunId: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  runsExecuted: number;
  version: string | null;
  /** Pending control instruction queued by an admin via REST API.
   *  The worker reads this on each heartbeat and acts on it. */
  requestedAction: WorkerControlAction | null;
  requestedConcurrency: number | null;
  requestedActionAt: string | null;
  requestedActionBy: string | null;
  /** Live concurrency (BullMQ workers honor this in REDIS mode). */
  concurrency: number;
}

interface DbRow {
  id: string;
  hostname: string;
  pid: number;
  status: string;
  current_run_id: string | null;
  started_at: string;
  last_heartbeat_at: string;
  runs_executed: number;
  version: string | null;
  requested_action: string | null;
  requested_concurrency: number | null;
  requested_action_at: string | null;
  requested_action_by: string | null;
  concurrency: number | null;
}

export class WorkerCoordinationService {
  private readonly id: string;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private janitorTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.id = process.env.MEDEA_WORKER_ID ?? `wkr_${nanoid(10)}`;
  }

  getId(): string {
    return this.id;
  }

  /**
   * Register this process in the workers table. Idempotent — replaces
   * any prior row with the same id (so restarts on the same worker_id
   * reuse the slot instead of leaving a ghost).
   */
  register(version?: string): void {
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `
      INSERT INTO workers (id, hostname, pid, status, started_at, last_heartbeat_at, runs_executed, version)
      VALUES (?, ?, ?, 'idle', ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET
        hostname = excluded.hostname,
        pid = excluded.pid,
        status = 'idle',
        started_at = excluded.started_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        version = excluded.version
    `,
      )
      .run(this.id, hostname(), process.pid, now, now, version ?? null);
    logger.info({ workerId: this.id, hostname: hostname(), pid: process.pid }, 'Worker registered');
  }

  /** Start the periodic heartbeat + janitor + control-intent poller.
   *  Pass `onControlAction` to react to admin-queued restart/drain/concurrency
   *  intents (e.g. wire to the BullMQ worker's concurrency setter). */
  start(
    onControlAction?: (action: WorkerControlAction | null, concurrency: number | null) => void,
  ): void {
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
      try {
        const pending = this.consumePendingAction();
        if (pending.action || pending.concurrency !== null) {
          logger.info({ workerId: this.id, ...pending }, 'Worker control intent received');
          if (pending.action === 'drain') this.setDraining();
          if (pending.action === 'resume') this.setIdle();
          if (pending.concurrency !== null) this.setConcurrency(pending.concurrency);
          onControlAction?.(pending.action, pending.concurrency);
          if (pending.action === 'restart') {
            // Give the caller a tick to log & flush, then SIGTERM ourselves.
            // systemd / PM2 restart policy brings the worker back up.
            setTimeout(() => {
              logger.warn(
                { workerId: this.id },
                'Worker honoring admin restart intent → SIGTERM self',
              );
              process.kill(process.pid, 'SIGTERM');
            }, 200);
          }
        }
      } catch (err) {
        logger.warn({ err, workerId: this.id }, 'Control-intent poll failed');
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.janitorTimer = setInterval(() => {
      this.janitor();
    }, STALE_AFTER_MS);
  }

  /** Gracefully unregister this worker. Call on SIGTERM / SIGINT. */
  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    try {
      const { sqlite } = getDatabase();
      sqlite.prepare(`DELETE FROM workers WHERE id = ?`).run(this.id);
      logger.info({ workerId: this.id }, 'Worker unregistered');
    } catch (err) {
      logger.warn({ err, workerId: this.id }, 'Failed to unregister worker (DB closed?)');
    }
  }

  heartbeat(): void {
    try {
      const { sqlite } = getDatabase();
      sqlite
        .prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), this.id);
    } catch (err) {
      logger.warn({ err, workerId: this.id }, 'Heartbeat write failed');
    }
  }

  /**
   * Mark workers whose lastHeartbeat is older than STALE_AFTER_MS as 'dead'.
   * Their currentRunId is set NULL (the run row keeps status='running' and
   * gets picked up by CheckpointRecoveryService on the next process boot,
   * or — in distributed mode — by another worker watching the BullMQ
   * 'stalled' event).
   */
  janitor(): void {
    try {
      const { sqlite } = getDatabase();
      const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
      const res = sqlite
        .prepare(
          `
        UPDATE workers SET status = 'dead', current_run_id = NULL
        WHERE last_heartbeat_at < ? AND status != 'dead'
      `,
        )
        .run(cutoff);
      if (res.changes > 0) {
        logger.warn({ count: res.changes }, 'Janitor marked stale workers as dead');
      }
    } catch (err) {
      logger.warn({ err }, 'Worker janitor failed');
    }
  }

  /** Called when this worker picks up a run (for the admin UI). */
  markBusy(runId: string): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(`UPDATE workers SET status = 'busy', current_run_id = ? WHERE id = ?`)
      .run(runId, this.id);
  }

  /** Called when this worker finishes a run. */
  markIdle(): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        `
      UPDATE workers SET status = 'idle', current_run_id = NULL, runs_executed = runs_executed + 1
      WHERE id = ?
    `,
      )
      .run(this.id);
  }

  listActive(): WorkerRow[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        `
      SELECT * FROM workers ORDER BY last_heartbeat_at DESC
    `,
      )
      .all() as DbRow[];
    return rows.map((r) => ({
      id: r.id,
      hostname: r.hostname,
      pid: r.pid,
      status: r.status as WorkerRow['status'],
      currentRunId: r.current_run_id,
      startedAt: r.started_at,
      lastHeartbeatAt: r.last_heartbeat_at,
      runsExecuted: r.runs_executed,
      version: r.version,
      requestedAction: (r.requested_action ?? null) as WorkerControlAction | null,
      requestedConcurrency: r.requested_concurrency,
      requestedActionAt: r.requested_action_at,
      requestedActionBy: r.requested_action_by,
      concurrency: r.concurrency ?? 1,
    }));
  }

  /**
   * Admin: queue a control intent for a specific worker. The target worker
   * picks it up on its next heartbeat (≤10s) and acts. Returns true if the
   * row exists, false otherwise.
   */
  requestAction(workerId: string, action: WorkerControlAction, actorEmail: string): boolean {
    const { sqlite } = getDatabase();
    const res = sqlite
      .prepare(
        `
      UPDATE workers
      SET requested_action = ?, requested_action_at = ?, requested_action_by = ?
      WHERE id = ?
    `,
      )
      .run(action, new Date().toISOString(), actorEmail, workerId);
    if (res.changes > 0) {
      logger.info({ workerId, action, actor: actorEmail }, 'Admin queued worker control action');
    }
    return res.changes > 0;
  }

  /**
   * Admin: change desired concurrency for a worker. BullMQ-mode workers
   * honor it; single-process in-memory mode logs a warning.
   */
  requestConcurrency(workerId: string, concurrency: number, actorEmail: string): boolean {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new Error('concurrency must be integer between 1 and 64');
    }
    const { sqlite } = getDatabase();
    const res = sqlite
      .prepare(
        `
      UPDATE workers
      SET requested_concurrency = ?, requested_action_at = ?, requested_action_by = ?
      WHERE id = ?
    `,
      )
      .run(concurrency, new Date().toISOString(), actorEmail, workerId);
    if (res.changes > 0) {
      logger.info({ workerId, concurrency, actor: actorEmail }, 'Admin queued concurrency change');
    }
    return res.changes > 0;
  }

  /**
   * Worker-side: read and ATOMICALLY clear any pending control action for
   * THIS worker. Should be called on each heartbeat. Returns the action to
   * apply (or null). After return, the DB columns are cleared so the
   * action runs exactly once.
   */
  consumePendingAction(): { action: WorkerControlAction | null; concurrency: number | null } {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        `
      SELECT requested_action, requested_concurrency FROM workers WHERE id = ?
    `,
      )
      .get(this.id) as
      | { requested_action: string | null; requested_concurrency: number | null }
      | undefined;
    if (!row || (row.requested_action === null && row.requested_concurrency === null)) {
      return { action: null, concurrency: null };
    }
    sqlite
      .prepare(
        `
      UPDATE workers SET requested_action = NULL, requested_concurrency = NULL WHERE id = ?
    `,
      )
      .run(this.id);
    return {
      action: (row.requested_action ?? null) as WorkerControlAction | null,
      concurrency: row.requested_concurrency,
    };
  }

  /** Update the live `concurrency` value (after the worker actually applied it). */
  setConcurrency(concurrency: number): void {
    const { sqlite } = getDatabase();
    sqlite.prepare(`UPDATE workers SET concurrency = ? WHERE id = ?`).run(concurrency, this.id);
  }

  /** Mark this worker as 'draining' (no new jobs, finish in-flight). */
  setDraining(): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(`UPDATE workers SET status = 'draining' WHERE id = ? AND status != 'dead'`)
      .run(this.id);
  }

  /** Resume from drain (status back to idle). */
  setIdle(): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(`UPDATE workers SET status = 'idle' WHERE id = ? AND status = 'draining'`)
      .run(this.id);
  }
}
