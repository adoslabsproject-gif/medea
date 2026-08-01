/**
 * Storage abstraction — unifies better-sqlite3 and postgres-js behind a
 * minimal async interface.
 *
 * The codebase has raw SQL across 18 files. Both backends are async at the
 * interface level (sqlite is sync internally but wrapped for uniformity).
 * Drizzle ORM keeps its own typed handle for the schema layer (workflows,
 * runs, audit_log).
 *
 * Backend selection: FLOWFORGE_STORAGE = 'sqlite' (default) | 'postgres'
 * Postgres URL: FLOWFORGE_PG_URL
 */

import type { Database as BetterSqlite3Connection } from 'better-sqlite3';
import type { Sql } from 'postgres';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface AsyncStatement<TRow = unknown> {
  /** Execute write — returns rows affected. */
  run(...params: unknown[]): Promise<RunResult>;
  /** Read one row (or undefined). */
  get(...params: unknown[]): Promise<TRow | undefined>;
  /** Read many rows. */
  all(...params: unknown[]): Promise<TRow[]>;
}

export interface StorageHandle {
  readonly kind: 'sqlite' | 'postgres';
  /** Execute DDL or multi-statement SQL. Idempotent (CREATE TABLE IF NOT EXISTS, etc.). */
  exec(sql: string): Promise<void>;
  /** Prepare a parametrized statement. Use `?` as placeholders — translated to `$N` for Postgres. */
  prepare<TRow = unknown>(sql: string): AsyncStatement<TRow>;
  close(): Promise<void>;
}

// ─── SQLite backend ──────────────────────────────────────────────────────────

export class SqliteHandle implements StorageHandle {
  readonly kind = 'sqlite' as const;
  constructor(private readonly conn: BetterSqlite3Connection) {}

  exec(sql: string): Promise<void> {
    this.conn.exec(sql);
    return Promise.resolve();
  }

  prepare<TRow = unknown>(sql: string): AsyncStatement<TRow> {
    const stmt = this.conn.prepare(sql);
    return {
      run: (...params) => {
        const r = stmt.run(...params);
        return Promise.resolve({ changes: r.changes, lastInsertRowid: r.lastInsertRowid });
      },
      get: (...params) => Promise.resolve(stmt.get(...params) as TRow | undefined),
      all: (...params) => Promise.resolve(stmt.all(...params) as TRow[]),
    };
  }

  close(): Promise<void> {
    this.conn.close();
    return Promise.resolve();
  }
}

// ─── Postgres backend ────────────────────────────────────────────────────────

/** Convert `?` placeholders to `$1, $2, ...` for Postgres. Skips quoted strings. */
export function rewritePlaceholders(sql: string): string {
  let i = 0;
  let out = '';
  let inString: string | null = null;
  for (const ch of sql) {
    if (inString) {
      out += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      i += 1;
      out += `$${i.toString()}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Translate SQLite-specific DDL to Postgres-compatible syntax.
 *   INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
 *   BLOB → BYTEA
 *   DATETIME → TIMESTAMPTZ
 *   PRAGMA ... → -- pragma stripped
 */
export function translateDdl(sql: string): string {
  return sql
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/giu, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bBLOB\b/giu, 'BYTEA')
    .replace(/\bDATETIME\b/giu, 'TIMESTAMPTZ')
    .replace(/PRAGMA\s+[^;]+;/giu, '-- pragma stripped;');
}

export class PostgresHandle implements StorageHandle {
  readonly kind = 'postgres' as const;
  constructor(private readonly sql: Sql) {}

  async exec(sqlText: string): Promise<void> {
    const translated = translateDdl(sqlText);
    // Multi-statement: split on `;` not inside strings, drop empty
    const stmts = splitStatements(translated);
    for (const stmt of stmts) {
      const trimmed = stmt.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      await this.sql.unsafe(trimmed);
    }
  }

  prepare<TRow = unknown>(sqlText: string): AsyncStatement<TRow> {
    const rewritten = rewritePlaceholders(sqlText);
    const sql = this.sql;
    return {
      async run(...params): Promise<RunResult> {
        const result = await sql.unsafe(rewritten, params as unknown as never[]);
        const arr = Array.isArray(result) ? (result as unknown[]) : [];
        const meta = result as unknown as { count?: number };
        return { changes: meta.count ?? arr.length, lastInsertRowid: 0 };
      },
      async get(...params) {
        const result = await sql.unsafe(rewritten, params as unknown as never[]);
        return ((result as unknown[])[0] ?? undefined) as TRow | undefined;
      },
      async all(...params) {
        const result = await sql.unsafe(rewritten, params as unknown as never[]);
        return result as unknown as TRow[];
      },
    };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString: string | null = null;
  for (const ch of sql) {
    if (inString) {
      buf += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === ';') {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}
