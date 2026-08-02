/**
 * WorkflowLockService — Tier 1 multi-user (#7). Lock pessimistico di editing
 * persistito su SQLite, sopra la logica pura `workflow-lock.logic`.
 *
 * Meglio di n8n (che NON ha lock → "ultimo che salva vince" + conflitti silenti):
 * qui un solo utente edita, gli altri vedono read-only + chi sta editando, e il
 * lock scade su perdita di heartbeat → nessun lock orfano.
 */
import { getDatabase } from '@/storage/db.js';
import {
  evaluateLockAcquire,
  isLockAlive,
  type LockState,
  type LockDecision,
} from './workflow-lock.logic.js';

export interface LockStatus {
  locked: boolean;
  /** True se il lock attivo è del richiedente. */
  mine: boolean;
  by?: { userId: string; userName: string };
}

interface LockRow {
  user_id: string;
  user_name: string;
  heartbeat_at: number;
}

export class WorkflowLockService {
  private read(workflowId: string): LockState | null {
    const row = getDatabase()
      .sqlite.prepare(
        'SELECT user_id, user_name, heartbeat_at FROM workflow_locks WHERE workflow_id = ?',
      )
      .get(workflowId) as LockRow | undefined;
    if (!row) return null;
    return { userId: row.user_id, userName: row.user_name, heartbeatAt: row.heartbeat_at };
  }

  /** Tenta di acquisire/rinnovare il lock. Persiste solo se la decisione è ok. */
  acquire(
    workflowId: string,
    userId: string,
    userName: string,
    now: number = Date.now(),
  ): LockDecision {
    const decision = evaluateLockAcquire(this.read(workflowId), userId, now);
    if (decision.ok) {
      getDatabase()
        .sqlite.prepare(
          `
        INSERT INTO workflow_locks (workflow_id, user_id, user_name, acquired_at, heartbeat_at)
        VALUES (@wf, @uid, @uname, @now, @now)
        ON CONFLICT(workflow_id) DO UPDATE SET
          user_id = excluded.user_id,
          user_name = excluded.user_name,
          acquired_at = CASE WHEN workflow_locks.user_id = excluded.user_id
                             THEN workflow_locks.acquired_at ELSE excluded.acquired_at END,
          heartbeat_at = excluded.heartbeat_at
      `,
        )
        .run({ wf: workflowId, uid: userId, uname: userName, now });
    }
    return decision;
  }

  /** Rinnova il lock SOLO se è del richiedente. Ritorna false se il lock è di altri. */
  heartbeat(workflowId: string, userId: string, now: number = Date.now()): boolean {
    const res = getDatabase()
      .sqlite.prepare(
        'UPDATE workflow_locks SET heartbeat_at = ? WHERE workflow_id = ? AND user_id = ?',
      )
      .run(now, workflowId, userId);
    return res.changes > 0;
  }

  /** Rilascia il lock SOLO se è del richiedente (no rilascio del lock altrui). */
  release(workflowId: string, userId: string): void {
    getDatabase()
      .sqlite.prepare('DELETE FROM workflow_locks WHERE workflow_id = ? AND user_id = ?')
      .run(workflowId, userId);
  }

  /** Stato del lock dal punto di vista del richiedente (i lock scaduti = liberi). */
  status(workflowId: string, userId: string, now: number = Date.now()): LockStatus {
    const current = this.read(workflowId);
    if (!isLockAlive(current, now) || !current) return { locked: false, mine: false };
    return {
      locked: true,
      mine: current.userId === userId,
      by: { userId: current.userId, userName: current.userName },
    };
  }
}
