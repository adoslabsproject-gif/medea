/**
 * Runtime storage entry point.
 *
 * Two backends supported:
 *   - SQLite (default, embedded, zero-ops)
 *   - PostgreSQL (multi-tenant SaaS, HA scenarios)
 *
 * Switch via:
 *   MEDEA_STORAGE = 'sqlite' (default) | 'postgres'
 *   MEDEA_PG_URL  = postgresql://user:pass@host:port/db
 *
 * Both backends expose:
 *   - `db`       : Drizzle ORM handle (typed) for the schema layer
 *   - `store`    : raw-SQL StorageHandle (async, `?` placeholders, both dialects)
 *
 * Service code uses `store.prepare(...)` for ad-hoc queries; the schema layer
 * (workflows, runs, audit_log) uses `db.select().from(...)` via Drizzle.
 */

import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import SqliteDatabase from 'better-sqlite3';
import postgres from 'postgres';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import * as schema from './schema.js';
import { SqliteHandle, PostgresHandle, type StorageHandle } from './handle.js';

/**
 * Typed as the SQLite drizzle handle for callers (workflow.service, audit, run).
 * Under the Postgres backend the underlying instance is PostgresJsDatabase but
 * the consumer-facing API (select/insert/update/delete via Drizzle) is shape-
 * identical, so a single static type covers both at compile time. The runtime
 * dispatches correctly because drizzle's `update().set().where()` chain has
 * the same JS shape on both dialects.
 */
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: DrizzleDb;
  store: StorageHandle;
  /** Back-compat alias for SQLite-only call sites still using `sqlite.exec(...)`. */
  sqlite: SqliteCompatProxy;
  close(): Promise<void>;
}

/**
 * Compat shim — lets existing services that wrote `getDatabase().sqlite.prepare(...)`
 * continue to work while the codebase is gradually migrated to `store.prepare(...)`.
 * Under Postgres backend, the sync facade uses a tiny internal microtask drain.
 */
export interface SqliteCompatProxy {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  // SQLite-only — better-sqlite3 transaction wrapper. Throws under Postgres.
  transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
}

function ensureDataDir(dbPath: string): void {
  const dir = dirname(resolve(dbPath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    logger.info({ dir }, 'Created data directory');
  }
}

function makeSqliteCompat(conn: ReturnType<typeof SqliteDatabase>): SqliteCompatProxy {
  return {
    prepare: (sql: string) => {
      const stmt = conn.prepare(sql);
      return {
        run: (...params) => stmt.run(...params),
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
      };
    },
    exec: (sql: string) => {
      conn.exec(sql);
    },
    transaction: <T extends unknown[], R>(fn: (...args: T) => R) =>
      conn.transaction(fn) as unknown as (...args: T) => R,
  };
}

function createSqliteHandle(): DatabaseHandle {
  const config = loadConfig();
  ensureDataDir(config.MEDEA_DB_PATH);

  const conn = new SqliteDatabase(config.MEDEA_DB_PATH);
  // ── Durability + concurrency primitives ────────────────────────────
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  // WAL + synchronous=NORMAL: i commit non chiamano fsync sul DB principale,
  // SOLO sul WAL. Safe perche\` un crash perde solo il batch in WAL non
  // ancora checkpointed. Vs synchronous=FULL: 3-5x piu\` veloce su write
  // intensive (workflow steps = high write rate).
  conn.pragma('synchronous = NORMAL');
  // 30s anziche\` 5s — sotto 50 tenant in burst c'e\` contention reale sul
  // WAL writer lock. better-sqlite3 espone busy_timeout ma il default 0
  // significa errori SQLITE_BUSY immediati invece di retry.
  conn.pragma('busy_timeout = 30000');

  // ── Performance tuning per 50+ tenant simultanei (2026-06-06) ──────
  //
  // cache_size in pagine NEGATIVE = kibibyte. -65536 = 64 MiB.
  // Default era -2000 (2 MiB) — adeguato per 5 workflow attivi, ridicolo
  // per 200+ (tabelle runs/steps con 100k+ row, search btree hit ratio
  // crollava al primo workflow esteso). 64 MiB tiene calde tutte le pagine
  // calde di un tenant medio (workflows + recent runs + audit_log corrente).
  conn.pragma('cache_size = -65536');

  // mmap_size = 256 MiB. Sostituisce read() syscall con accesso memoria
  // diretta sulle pagine cold (utile per stat workflow + analytics dashboard
  // che leggono full table scan su runs). Zero overhead se la pagina e\` gia\`
  // in OS page cache. Vale per ogni connection ma il VFS dedup le mappings.
  conn.pragma('mmap_size = 268435456');

  // temp_store = MEMORY. Tutti i temp di GROUP BY / ORDER BY / subquery
  // restano in RAM invece di scrivere in /tmp. Critico per query analytics
  // del dashboard (runs aggregati per giorno × 30gg).
  conn.pragma('temp_store = MEMORY');

  // wal_autocheckpoint = 10000 pagine (~40 MB con page_size default 4kb).
  // Default 1000 (4 MB) era troppo aggressivo: ogni 1000 commit il writer
  // bloccava per checkpoint. 10k riduce contesa, WAL file resta sotto 40MB
  // (comodo per backup snapshot). Trade-off: in caso di crash si recovery
  // un po\` piu\` lento — accettabile per SaaS multi-tenant.
  conn.pragma('wal_autocheckpoint = 10000');

  const db = drizzleSqlite(conn, { schema });

  // In-place migration for columns added after first deploy.
  const existingCols = new Set(
    (conn.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map((r) => r.name),
  );
  const addColumn = (name: string, type: string): void => {
    if (existingCols.has(name)) return;
    try {
      conn.exec(`ALTER TABLE workflows ADD COLUMN ${name} ${type};`);
      logger.info({ column: name }, 'Migrated workflows table with new column');
    } catch (err) {
      logger.warn({ err, column: name }, 'workflows ALTER TABLE failed');
    }
  };
  if (existingCols.size > 0) {
    addColumn('folder_id', 'TEXT');
    addColumn('on_error_json', 'TEXT');
    addColumn('concurrency_limit', 'INTEGER');
    // 2026-06-07 (incident senza1dio disk-full): flag per workflow webhook
    // proxy ad alta frequenza. Quando 1, ogni run è ephemeral.
    addColumn('ephemeral_runs', 'INTEGER NOT NULL DEFAULT 0');
    // 2026-06-07 sera (tier-aware logging): tri-state run verbosity.
    // NULL = back-compat (legge ephemeral_runs).
    // 'silent'  → no INSERT runs
    // 'summary' → INSERT row con steps trimmed (no input/output binari)
    // 'full'    → comportamento attuale completo
    addColumn('run_verbosity', 'TEXT');
  }

  logger.info({ path: config.MEDEA_DB_PATH, backend: 'sqlite' }, 'Storage connected');

  return {
    db,
    store: new SqliteHandle(conn),
    sqlite: makeSqliteCompat(conn),
    close: () => {
      conn.close();
      return Promise.resolve();
    },
  };
}

function createPostgresHandle(): DatabaseHandle {
  const url = process.env.MEDEA_PG_URL;
  if (!url) {
    throw new Error('MEDEA_STORAGE=postgres but MEDEA_PG_URL is not set');
  }
  const sql = postgres(url, {
    max: 10,
    onnotice: () => {
      /* suppress NOTICE */
    },
  });
  const db = drizzlePg(sql, { schema }) as unknown as DrizzleDb;
  const handle = new PostgresHandle(sql);

  // Postgres has no synchronous facade — the sqlite compat proxy will throw
  // if a legacy call site is reached. Use async `store.*` instead.
  const compat: SqliteCompatProxy = {
    prepare: () => {
      throw new Error(
        'Synchronous sqlite proxy not available under Postgres backend. Migrate the call site to `await store.prepare(...).run/get/all(...)`.',
      );
    },
    exec: () => {
      throw new Error(
        'Synchronous sqlite.exec() not available under Postgres backend. Use `await store.exec(...)`.',
      );
    },
    transaction: () => {
      throw new Error(
        'SQLite transaction() not available under Postgres backend. Use `db.transaction(async (tx) => ...)` via Drizzle instead.',
      );
    },
  };

  logger.info({ url: url.replace(/:[^:]+@/u, ':***@'), backend: 'postgres' }, 'Storage connected');

  return {
    db,
    store: handle,
    sqlite: compat,
    close: () => handle.close(),
  };
}

export function createDatabase(): DatabaseHandle {
  const backend = (process.env.MEDEA_STORAGE ?? 'sqlite').toLowerCase();
  if (backend === 'postgres' || backend === 'pg') {
    return createPostgresHandle();
  }
  return createSqliteHandle();
}

let cached: DatabaseHandle | null = null;

export function getDatabase(): DatabaseHandle {
  cached ??= createDatabase();
  return cached;
}

export async function closeDatabase(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = null;
  }
}
