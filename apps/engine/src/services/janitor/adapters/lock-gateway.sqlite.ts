/**
 * Adapter — SqliteLockGateway.
 *
 * Lock distribuito named persistito sulla `janitor_locks` (FlowForge
 * system SQLite). Atomicità via `INSERT ... ON CONFLICT DO NOTHING` +
 * filtro server-side `expires_at`.
 *
 * Perché SOLO sul system DB:
 *   • Il lock deve essere unico cross-process per regola — un singolo
 *     punto di verità.
 *   • Anche le rule che girano su DB tenant lockano qui (system) per
 *     coordinazione. Le rule girano in un processo runtime, mai in
 *     processi del tenant.
 *
 * Trade-off:
 *   • Single point of failure: se il file FlowForge è bloccato, il
 *     Janitor è bloccato. Ma il runtime ALL-IN-ONE dipende già dallo
 *     stesso file — non aggiungiamo failure mode nuovi.
 */

import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ILockGateway, LockEntry } from '@/services/janitor/ports/index.js';
import { logger } from '@/lib/logger.js';

interface RawLockRow {
  rule_id: string;
  held_by: string;
  acquired_at: string;
  expires_at: string;
}

export class SqliteLockGateway implements ILockGateway {
  constructor(private readonly sqlite: SqliteCompatProxy) {}

  acquire(key: string, holderId: string, ttlMs: number): boolean {
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    let acquired = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE');
      this.sqlite.prepare(`
        DELETE FROM janitor_locks
        WHERE rule_id = ? AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      `).run(key);
      const res = this.sqlite.prepare(`
        INSERT INTO janitor_locks (rule_id, held_by, acquired_at, expires_at)
        VALUES (
          ?, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
        )
        ON CONFLICT(rule_id) DO NOTHING
      `).run(key, holderId, ttlSeconds);
      acquired = res.changes === 1;
      this.sqlite.exec('COMMIT');
    } catch (err) {
      try { this.sqlite.exec('ROLLBACK'); } catch { /* nested ok */ }
      logger.warn({ err, key, holderId }, 'Janitor lock acquire failed');
      return false;
    }
    return acquired;
  }

  release(key: string, holderId: string): void {
    try {
      this.sqlite.prepare(`
        DELETE FROM janitor_locks WHERE rule_id = ? AND held_by = ?
      `).run(key, holderId);
    } catch (err) {
      logger.warn({ err, key, holderId }, 'Janitor lock release failed (non-fatal)');
    }
  }

  cleanupStale(): number {
    try {
      const res = this.sqlite.prepare(`
        DELETE FROM janitor_locks
        WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      `).run();
      return res.changes;
    } catch (err) {
      logger.warn({ err }, 'Janitor stale lock cleanup failed');
      return 0;
    }
  }

  listActive(): readonly LockEntry[] {
    try {
      const rows = this.sqlite.prepare(`
        SELECT rule_id, held_by, acquired_at, expires_at
        FROM janitor_locks
        WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY acquired_at DESC
      `).all() as RawLockRow[];
      return rows.map((r) => ({
        key: r.rule_id,
        heldBy: r.held_by,
        acquiredAt: r.acquired_at,
        expiresAt: r.expires_at,
      }));
    } catch {
      return [];
    }
  }
}
