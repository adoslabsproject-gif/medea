/**
 * `memory_note` — executor.
 *
 * Storage SQLite per-tenant: tabella `workflow_memory` lazy-creata.
 * Schema:
 *   workflow_id TEXT NOT NULL,
 *   key         TEXT NOT NULL,
 *   value       TEXT NOT NULL,
 *   updated_at  INTEGER NOT NULL,
 *   expires_at  INTEGER,
 *   PRIMARY KEY (workflow_id, key)
 *
 * @module executors/memory
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor, NodeExecutionResult } from '@medea/engine-nodes-stdlib';
import { getDatabase, type SqliteCompatProxy } from '@/storage/db.js';

let _schemaReady = false;
function ensureSchema(sqlite: SqliteCompatProxy): void {
  if (_schemaReady) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_memory (
      workflow_id TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      expires_at  INTEGER,
      PRIMARY KEY (workflow_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_memory_expires
      ON workflow_memory(expires_at) WHERE expires_at IS NOT NULL;
  `);
  _schemaReady = true;
}

function isExpired(row: { expires_at: number | null }): boolean {
  return row.expires_at !== null && row.expires_at <= Date.now();
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Cap dimensione valore (1 MB) — anti-DoS storage: senza, un `append` in loop
 * farebbe crescere la riga SQLite all'infinito riempiendo il disco del tenant. */
const MAX_VALUE_BYTES = 1_000_000;
const OVERSIZE_MSG = `memory_note: valore oltre il cap di ${String(MAX_VALUE_BYTES)} byte (1 MB) — usa uno storage dedicato per dati grandi`;
function tooLarge(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES;
}

interface MemoryRow {
  value: string;
  updated_at: number;
  expires_at: number | null;
}

export const memoryNoteExecutor: NodeExecutor = (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const op = coerceString(cfg.operation ?? 'get');
  if (!['get', 'set', 'append', 'delete', 'list'].includes(op)) {
    return Promise.reject(
      new Error(`memory_note: operation "${op}" non valida (get/set/append/delete/list)`),
    );
  }
  const key = coerceString(cfg.key ?? '').trim();
  const workflowId = context.workflowId;
  if (op !== 'list' && !key) {
    return Promise.reject(
      new Error('memory_note: "key" e\\` obbligatoria per get/set/append/delete'),
    );
  }

  const { sqlite } = getDatabase();
  ensureSchema(sqlite);

  const now = Date.now();
  const ttlRaw = Number(cfg.ttlSeconds ?? 0);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : 0;
  const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;

  switch (op) {
    case 'get': {
      const row = sqlite
        .prepare(
          'SELECT value, updated_at, expires_at FROM workflow_memory WHERE workflow_id = ? AND key = ?',
        )
        .get(workflowId, key) as MemoryRow | undefined;
      if (!row || isExpired(row)) {
        if (row && isExpired(row)) {
          sqlite
            .prepare('DELETE FROM workflow_memory WHERE workflow_id = ? AND key = ?')
            .run(workflowId, key);
        }
        // default-value fallback: se la key non esiste e l'utente ha fornito un
        // default, lo ritorniamo (exists resta false, usedDefault=true per distinguere).
        const hasDefault =
          cfg.default !== undefined && cfg.default !== null && coerceString(cfg.default) !== '';
        return Promise.resolve({
          output: {
            exists: false,
            value: hasDefault ? coerceString(cfg.default) : null,
            usedDefault: hasDefault,
            operation: 'get',
          },
          durationMs: Date.now() - start,
        });
      }
      return Promise.resolve({
        output: {
          exists: true,
          value: row.value,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at,
          usedDefault: false,
          operation: 'get',
        },
        durationMs: Date.now() - start,
      });
    }

    case 'set': {
      if (cfg.value === undefined || cfg.value === null) {
        return Promise.reject(new Error('memory_note: "value" obbligatorio per set'));
      }
      const v = serialize(cfg.value);
      if (tooLarge(v)) return Promise.reject(new Error(OVERSIZE_MSG));
      // oldValue (audit): il valore precedente NON-scaduto, null se nuovo/scaduto.
      const prev = sqlite
        .prepare('SELECT value, expires_at FROM workflow_memory WHERE workflow_id = ? AND key = ?')
        .get(workflowId, key) as { value: string; expires_at: number | null } | undefined;
      const oldValue = prev && !isExpired({ expires_at: prev.expires_at }) ? prev.value : null;
      sqlite
        .prepare(
          `INSERT INTO workflow_memory (workflow_id, key, value, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workflow_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        )
        .run(workflowId, key, v, now, expiresAt);
      return Promise.resolve({
        output: {
          exists: true,
          value: v,
          oldValue,
          changed: oldValue !== v,
          updatedAt: now,
          expiresAt,
          operation: 'set',
        },
        durationMs: Date.now() - start,
      });
    }

    case 'append': {
      if (cfg.value === undefined || cfg.value === null) {
        return Promise.reject(new Error('memory_note: "value" obbligatorio per append'));
      }
      const sep = coerceString(cfg.appendSeparator ?? '\n');
      const newVal = serialize(cfg.value);
      const existing = sqlite
        .prepare('SELECT value, expires_at FROM workflow_memory WHERE workflow_id = ? AND key = ?')
        .get(workflowId, key) as { value: string; expires_at: number | null } | undefined;
      let combined: string;
      if (existing && !isExpired({ expires_at: existing.expires_at })) {
        combined = existing.value + sep + newVal;
      } else {
        combined = newVal;
      }
      if (tooLarge(combined)) return Promise.reject(new Error(OVERSIZE_MSG)); // anti-DoS: append non illimitato
      sqlite
        .prepare(
          `INSERT INTO workflow_memory (workflow_id, key, value, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workflow_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        )
        .run(workflowId, key, combined, now, expiresAt);
      return Promise.resolve({
        output: { exists: true, value: combined, updatedAt: now, operation: 'append' },
        durationMs: Date.now() - start,
      });
    }

    case 'delete': {
      const info = sqlite
        .prepare('DELETE FROM workflow_memory WHERE workflow_id = ? AND key = ?')
        .run(workflowId, key) as { changes: number };
      return Promise.resolve({
        output: { exists: info.changes > 0, operation: 'delete', value: null },
        durationMs: Date.now() - start,
      });
    }

    case 'list': {
      // Cleanup scaduti prima del list (best-effort)
      sqlite
        .prepare(
          'DELETE FROM workflow_memory WHERE workflow_id = ? AND expires_at IS NOT NULL AND expires_at <= ?',
        )
        .run(workflowId, now);
      // pattern glob opzionale (es. "cursor:*"): convertito in SQL LIKE con escape
      // dei metacaratteri SQL (% _ \) PRIMA di tradurre il glob `*`→`%` e `?`→`_`.
      const pattern = coerceString(cfg.pattern ?? '').trim();
      let rows: { key: string; updated_at: number }[];
      if (pattern !== '') {
        const like = pattern
          .replace(/[\\%_]/g, (c) => `\\${c}`)
          .replace(/\*/g, '%')
          .replace(/\?/g, '_');
        rows = sqlite
          .prepare(
            "SELECT key, updated_at FROM workflow_memory WHERE workflow_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC",
          )
          .all(workflowId, like) as { key: string; updated_at: number }[];
      } else {
        rows = sqlite
          .prepare(
            'SELECT key, updated_at FROM workflow_memory WHERE workflow_id = ? ORDER BY updated_at DESC',
          )
          .all(workflowId) as { key: string; updated_at: number }[];
      }
      return Promise.resolve({
        output: {
          keys: rows.map((r) => r.key),
          count: rows.length,
          pattern: pattern || null,
          operation: 'list',
        },
        durationMs: Date.now() - start,
      });
    }
  }

  // unreachable (validated above)
  return Promise.resolve({
    output: {},
    durationMs: Date.now() - start,
  } satisfies NodeExecutionResult);
};

export const __test__ = {
  resetSchema: (): void => {
    _schemaReady = false;
  },
};
