/**
 * Test 2026-grade — storage/db.ts (DB connection + PRAGMA + dispatch backend).
 *
 * 🚨 INFRA-CRITICAL: bug qui = boot fail su tutti i tenant container.
 *    Coverage 2026: PRAGMA settings tuning (WAL/FK/busy/cache/mmap/checkpoint),
 *    SQLite-vs-Postgres dispatch, getDatabase singleton cache, closeDatabase
 *    reset, Postgres URL missing fail-fast, compat proxy fail-loud sotto PG.
 *
 * 🚨 ALTER TABLE in-place migration: workflows table ricevuta da prima
 *    versione deve essere aggiornata con folder_id/on_error_json/concurrency
 *    /ephemeral_runs/run_verbosity senza data loss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SqliteDatabase from 'better-sqlite3';

const ORIG_ENV = { ...process.env };
let TMP_DIR: string;
let TMP_DB: string;

vi.mock('@/lib/logger.js');

const configMock = vi.hoisted(() => ({ MEDEA_DB_PATH: '', MEDEA_DATA_DIR: '' }));
vi.mock('@/config.js', () => ({
  loadConfig: () => configMock,
}));

beforeEach(() => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'ff-db-test-'));
  TMP_DB = join(TMP_DIR, 'flowforge.sqlite');
  configMock.MEDEA_DB_PATH = TMP_DB;
  configMock.MEDEA_DATA_DIR = TMP_DIR;
  delete process.env.MEDEA_STORAGE;
  delete process.env.MEDEA_PG_URL;
});

afterEach(async () => {
  // Reset module cache + chiude db cache
  vi.resetModules();
  process.env = { ...ORIG_ENV };
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('🚨 createDatabase — backend dispatch', () => {
  it('🚨 default (no env) → SQLite backend', async () => {
    const { createDatabase } = await import('./db.js');
    const handle = createDatabase();
    expect(handle.db).toBeDefined();
    expect(handle.store).toBeDefined();
    expect(handle.sqlite).toBeDefined();
    // SQLite compat proxy DEVE supportare prepare/exec/transaction
    expect(() => handle.sqlite.exec('CREATE TABLE _probe (id INTEGER)')).not.toThrow();
    await handle.close();
  });

  it('🚨 MEDEA_STORAGE=sqlite → SQLite', async () => {
    process.env.MEDEA_STORAGE = 'sqlite';
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    expect(h.db).toBeDefined();
    await h.close();
  });

  it('🚨 SECURITY: MEDEA_STORAGE=postgres SENZA URL → throw fail-fast', async () => {
    process.env.MEDEA_STORAGE = 'postgres';
    delete process.env.MEDEA_PG_URL;
    const { createDatabase } = await import('./db.js');
    expect(() => createDatabase()).toThrow(/MEDEA_PG_URL/);
  });

  it('🚨 MEDEA_STORAGE=pg (alias) → routes to Postgres branch (URL check still applies)', async () => {
    process.env.MEDEA_STORAGE = 'pg';
    delete process.env.MEDEA_PG_URL;
    const { createDatabase } = await import('./db.js');
    expect(() => createDatabase()).toThrow(/MEDEA_PG_URL/);
  });

  it('🚨 case-insensitive: MEDEA_STORAGE=POSTGRES → routes a PG', async () => {
    process.env.MEDEA_STORAGE = 'POSTGRES';
    delete process.env.MEDEA_PG_URL;
    const { createDatabase } = await import('./db.js');
    expect(() => createDatabase()).toThrow(/MEDEA_PG_URL/);
  });

  it('🚨 case-insensitive: MEDEA_STORAGE="SQLITE" → SQLite', async () => {
    process.env.MEDEA_STORAGE = 'SQLITE';
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    expect(h.db).toBeDefined();
    await h.close();
  });

  it('🚨 valore sconosciuto → fallback SQLite (default)', async () => {
    process.env.MEDEA_STORAGE = 'mysql'; // non supportato
    const { createDatabase } = await import('./db.js');
    // No throw: fallback al ramo SQLite
    const h = createDatabase();
    expect(h.db).toBeDefined();
    await h.close();
  });
});

describe('🚨 SQLite PRAGMA tuning (2026-06-06 perf optimization)', () => {
  it('🚨 WAL mode attivo (journal_mode = wal)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const mode = h.sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode.toLowerCase()).toBe('wal');
    await h.close();
  });

  it('🚨 foreign_keys ON (FK constraint enforced)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const fk = h.sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    await h.close();
  });

  it('🚨 busy_timeout >= 30000 ms (contention tenant burst)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const bt = h.sqlite.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(bt.timeout).toBeGreaterThanOrEqual(30000);
    await h.close();
  });

  it('🚨 cache_size = -65536 (64MB tenant medio)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const cs = h.sqlite.prepare('PRAGMA cache_size').get() as { cache_size: number };
    expect(cs.cache_size).toBe(-65536);
    await h.close();
  });

  it('🚨 mmap_size = 256 MB (read syscall replaced)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const mm = h.sqlite.prepare('PRAGMA mmap_size').get() as { mmap_size: number };
    expect(mm.mmap_size).toBe(268435456);
    await h.close();
  });

  it('🚨 temp_store = MEMORY (no /tmp writes per GROUP BY)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const ts = h.sqlite.prepare('PRAGMA temp_store').get() as { temp_store: number };
    // 2 = MEMORY enum value in SQLite
    expect(ts.temp_store).toBe(2);
    await h.close();
  });

  it('🚨 wal_autocheckpoint = 10000 pages (~40MB cap)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const wac = h.sqlite.prepare('PRAGMA wal_autocheckpoint').get() as {
      wal_autocheckpoint: number;
    };
    expect(wac.wal_autocheckpoint).toBe(10000);
    await h.close();
  });

  it('🚨 synchronous = NORMAL (1) (no fsync on commit, WAL safe)', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const sync = h.sqlite.prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(sync.synchronous).toBe(1); // NORMAL
    await h.close();
  });
});

describe('🚨 ALTER TABLE in-place migration (back-compat)', () => {
  it('🚨 workflows con vecchio schema → addColumn migra senza data loss', async () => {
    // Setup: pre-popolo DB con schema minimo workflows (senza folder_id et al)
    const conn = new SqliteDatabase(TMP_DB);
    conn.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    conn
      .prepare(`INSERT INTO workflows (id, name, tenant_id, graph_json) VALUES (?, ?, ?, ?)`)
      .run('wf-1', 'Test WF', 't1', '{}');
    conn.close();

    // Ora apro via createDatabase → trigger ALTER TABLE addColumn
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    const cols = h.sqlite.prepare(`PRAGMA table_info(workflows)`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    // 🚨 Tutte e 5 le colonne aggiunte 2026-06-07 devono essere presenti
    expect(colNames).toContain('folder_id');
    expect(colNames).toContain('on_error_json');
    expect(colNames).toContain('concurrency_limit');
    expect(colNames).toContain('ephemeral_runs');
    expect(colNames).toContain('run_verbosity');

    // 🚨 SAFETY: dato preesistente intatto
    const row = h.sqlite.prepare(`SELECT id, name FROM workflows WHERE id = ?`).get('wf-1') as {
      id: string;
      name: string;
    };
    expect(row.id).toBe('wf-1');
    expect(row.name).toBe('Test WF');
    await h.close();
  });

  it("🚨 workflows VUOTO (mai inizializzato) → NO ALTER, schema verra' creato da Drizzle migrate", async () => {
    // Senza tabella workflows pre-esistente, addColumn skip (existingCols.size === 0)
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    // Verifica che nessun ALTER abbia fallito e che possiamo creare la tabella ex-novo
    expect(() =>
      h.sqlite.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        graph_json TEXT NOT NULL
      );
    `),
    ).not.toThrow();
    await h.close();
  });

  it('🚨 IDEMPOTENZA: createDatabase 2x non duplica colonne', async () => {
    // Pre-popolo + apro 2 volte
    const conn = new SqliteDatabase(TMP_DB);
    conn.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, name TEXT, tenant_id TEXT, graph_json TEXT
      );
    `);
    conn.close();
    const { createDatabase } = await import('./db.js');
    const h1 = createDatabase();
    await h1.close();
    const h2 = createDatabase();
    const cols = h2.sqlite.prepare(`PRAGMA table_info(workflows)`).all() as { name: string }[];
    const folderIdCount = cols.filter((c) => c.name === 'folder_id').length;
    expect(folderIdCount).toBe(1); // no duplicate
    await h2.close();
  });
});

describe('🚨 SQLite compat proxy (back-compat layer)', () => {
  it('🚨 prepare/get/all/run ritornano sync', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    h.sqlite.exec(`CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)`);
    const stmt = h.sqlite.prepare(`INSERT INTO probe (id, v) VALUES (?, ?)`);
    const r = stmt.run(1, 'x');
    expect(r.changes).toBe(1);
    expect(typeof r.lastInsertRowid).toMatch(/number|bigint/);
    const get = h.sqlite.prepare(`SELECT v FROM probe WHERE id = ?`).get(1) as { v: string };
    expect(get.v).toBe('x');
    const all = h.sqlite.prepare(`SELECT v FROM probe`).all() as { v: string }[];
    expect(all).toHaveLength(1);
    await h.close();
  });

  it('🚨 transaction() wrappa funzione, esegue atomicamente', async () => {
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    h.sqlite.exec(`CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, v TEXT)`);
    const insert = h.sqlite.prepare(`INSERT INTO tx_probe VALUES (?, ?)`);
    const tx = h.sqlite.transaction((items: [number, string][]) => {
      for (const [id, v] of items) insert.run(id, v);
    });
    tx([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    const count = (h.sqlite.prepare(`SELECT COUNT(*) AS c FROM tx_probe`).get() as { c: number }).c;
    expect(count).toBe(3);
    await h.close();
  });
});

describe('🚨 getDatabase — singleton + closeDatabase', () => {
  it('🚨 chiamato 2 volte → stesso handle (cached singleton)', async () => {
    const { getDatabase } = await import('./db.js');
    const h1 = getDatabase();
    const h2 = getDatabase();
    expect(h1).toBe(h2);
    await h1.close();
  });

  it('🚨 closeDatabase poi getDatabase → ricostruisce nuovo handle', async () => {
    const { getDatabase, closeDatabase } = await import('./db.js');
    const h1 = getDatabase();
    await closeDatabase();
    const h2 = getDatabase();
    expect(h1).not.toBe(h2);
    await h2.close();
  });

  it('🚨 closeDatabase senza prior getDatabase → no-op safe', async () => {
    const { closeDatabase } = await import('./db.js');
    await expect(closeDatabase()).resolves.not.toThrow();
  });
});

describe('🚨 ensureDataDir — directory creation', () => {
  it('🚨 path con dir mancante → createDirectory ricorsivo', async () => {
    const nestedDb = join(TMP_DIR, 'nested', 'deep', 'flowforge.sqlite');
    configMock.MEDEA_DB_PATH = nestedDb;
    const { createDatabase } = await import('./db.js');
    const h = createDatabase();
    // Verifica che il file db sia stato creato (dir parent creata)
    expect(h.db).toBeDefined();
    await h.close();
  });
});
