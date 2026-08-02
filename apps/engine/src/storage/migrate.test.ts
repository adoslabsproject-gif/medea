/**
 * Tests for `runMigrations` — base schema + evolutive ALTER TABLE.
 *
 * Strategia "characterization test" (golden master semantico): a fresh
 * SQLite DB, dopo `runMigrations()`:
 *   - Tutte le tabelle base esistono (PRAGMA table_list)
 *   - Colonne evolutive (ensureColumn) sono presenti (PRAGMA table_info)
 *   - Re-run idempotente (no throw, schema identico)
 *   - Indexes critici sono creati
 *
 * NON test schema completo SQL per SQL (verbose). Verifica i contract chiave
 * che il refactor deve mantenere immutato.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';

// Mock @/config to return a writable tmp dir (no real /var/data dependency)
const tmpDbPath = (): string =>
  join(tmpdir(), `migrate-test-${randomBytes(8).toString('hex')}.sqlite`);

let _dbPath = '';

vi.mock('@/config.js', () => ({
  loadConfig: () => ({
    MEDEA_STORAGE: 'sqlite',
    MEDEA_DB_PATH: _dbPath,
    MEDEA_DATA_DIR: tmpdir(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  }),
}));

// Stub the logger so noise doesn't pollute test output
vi.mock('@/lib/logger.js');

const createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  createdPaths.length = 0;
  // reset singleton cache nel modulo db (chiamato per side-effect)
  vi.resetModules();
});

function tableExists(db: SqliteDatabase.Database, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return row !== undefined;
}

function columnExists(db: SqliteDatabase.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

describe('runMigrations', () => {
  it('creates base schema tables on fresh DB', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    // Tabelle core attese dal SCHEMA_SQL
    expect(tableExists(direct, 'users')).toBe(true);
    expect(tableExists(direct, 'workflows')).toBe(true);
    expect(tableExists(direct, 'runs')).toBe(true);
    expect(tableExists(direct, 'paused_workflows')).toBe(true);
    expect(tableExists(direct, 'workers')).toBe(true);
    direct.close();
  });

  it('creates workflow_locks table with the expected columns (#7 multi-user lock)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    expect(tableExists(direct, 'workflow_locks')).toBe(true);
    for (const col of ['workflow_id', 'user_id', 'user_name', 'acquired_at', 'heartbeat_at']) {
      expect(columnExists(direct, 'workflow_locks', col)).toBe(true);
    }
    direct.close();
  });

  it('creates workflow_comments table with the expected columns (#7 Tier 3)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    expect(tableExists(direct, 'workflow_comments')).toBe(true);
    for (const col of [
      'id',
      'workflow_id',
      'node_id',
      'user_id',
      'user_name',
      'body',
      'mentions_json',
      'resolved',
      'created_at',
    ]) {
      expect(columnExists(direct, 'workflow_comments', col)).toBe(true);
    }
    direct.close();
  });

  it('creates notifications table with the expected columns (#7 Tier 3 push @mention)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    expect(tableExists(direct, 'notifications')).toBe(true);
    for (const col of [
      'id',
      'user_id',
      'type',
      'workflow_id',
      'node_id',
      'actor_name',
      'preview',
      'read',
      'created_at',
    ]) {
      expect(columnExists(direct, 'notifications', col)).toBe(true);
    }
    const indexes = direct.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
      name: string;
    }[];
    expect(indexes.map((i) => i.name)).toContain('notifications_user_idx');
    direct.close();
  });

  it('adds evolutive columns via ensureColumn', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    // users — colonne evolutive aggiunte da ensureColumn()
    expect(columnExists(direct, 'users', 'oauth_provider')).toBe(true);
    expect(columnExists(direct, 'users', 'oauth_subject')).toBe(true);
    expect(columnExists(direct, 'users', 'is_system')).toBe(true);
    // paused_workflows — BPMN-style message correlation
    expect(columnExists(direct, 'paused_workflows', 'match_key')).toBe(true);
    expect(columnExists(direct, 'paused_workflows', 'match_value')).toBe(true);
    // workers — control intents
    expect(columnExists(direct, 'workers', 'requested_action')).toBe(true);
    expect(columnExists(direct, 'workers', 'concurrency')).toBe(true);
    // workflows — draft/autosave separation
    expect(columnExists(direct, 'workflows', 'draft_json')).toBe(true);
    expect(columnExists(direct, 'workflows', 'draft_updated_at')).toBe(true);
    direct.close();
  });

  it('is idempotent — re-run does not throw and leaves schema identical', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();
    const direct1 = new SqliteDatabase(_dbPath);
    const tables1 = direct1
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all();
    direct1.close();

    // Second invocation — must NOT throw
    expect(() => {
      runMigrations();
    }).not.toThrow();

    const direct2 = new SqliteDatabase(_dbPath);
    const tables2 = direct2
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all();
    expect(tables2).toEqual(tables1);
    direct2.close();
  });

  it('creates critical indexes for query performance', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    const indexes = direct.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
      name: string;
    }[];
    const names = indexes.map((i) => i.name);
    // Spot-check critical indexes (presi dal SCHEMA_SQL split)
    expect(names).toContain('workers_heartbeat_idx');
    expect(names).toContain('workers_status_idx');
    direct.close();
  });
});

/**
 * F2 (2026-06-10): le tabelle SSO/folders/share NON devono più nascere da
 * `CREATE TABLE` inline nei route handler (schema drift, DDL a request-time).
 * Sono ora in SCHEMA_SQL → create da runMigrations al boot.
 *
 * Questo blocco è il drift-guard: verifica contro un DB REALE che ognuna esista
 * con le colonne+indici esatti che gli handler interrogano. Se qualcuno
 * ri-introduce uno schema inline divergente, o sbaglia una colonna in
 * SCHEMA_SQL, questi test rompono. NON sono green-smoke: ogni colonna asserita
 * è effettivamente letta/scritta dal rispettivo handler.
 */
describe('F2 — SSO/folders/share schema migrated out of route handlers', () => {
  // tabella → colonne che gli handler leggono/scrivono (contract reale)
  const EXPECTED: Record<string, string[]> = {
    oauth_providers: [
      'id',
      'tenant_id',
      'provider',
      'issuer',
      'client_id',
      'client_secret',
      'redirect_uri',
      'scopes',
      'created_at',
    ],
    oauth_state: ['state', 'tenant_id', 'provider', 'code_verifier', 'created_at', 'expires_at'],
    saml_providers: [
      'id',
      'tenant_id',
      'provider',
      'entry_point',
      'issuer',
      'cert',
      'callback_url',
      'created_at',
    ],
    sso_jti_used: ['jti', 'expires_at'],
    workflow_folders: ['id', 'tenant_id', 'parent_id', 'name', 'created_at', 'updated_at'],
    workflow_shares: [
      'token',
      'workflow_id',
      'tenant_id',
      'created_at',
      'expires_at',
      'created_by',
      'view_count',
    ],
  };

  it('crea TUTTE le 6 tabelle con le colonne esatte che gli handler usano', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    for (const [table, cols] of Object.entries(EXPECTED)) {
      expect(tableExists(direct, table), `tabella mancante: ${table}`).toBe(true);
      for (const col of cols) {
        expect(columnExists(direct, table, col), `colonna mancante: ${table}.${col}`).toBe(true);
      }
    }
    direct.close();
  });

  it('crea gli indici di supporto (cleanup TTL + lookup)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    const names = (
      direct.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as {
        name: string;
      }[]
    ).map((i) => i.name);
    expect(names).toContain('oauth_state_expires_idx');
    expect(names).toContain('idx_sso_jti_expires');
    expect(names).toContain('workflow_folders_tenant_idx');
    expect(names).toContain('workflow_shares_workflow_idx');
    direct.close();
  });

  it('vincoli UNIQUE attivi: (tenant_id, provider) su oauth_providers e saml_providers', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    // oauth_providers: secondo insert stesso (tenant, provider) → throw UNIQUE
    const ins = direct.prepare(
      `INSERT INTO oauth_providers (id, tenant_id, provider, issuer, client_id, client_secret, redirect_uri, scopes, created_at)
       VALUES (?, 't1', 'okta', 'iss', 'cid', 'sec', 'uri', 'openid', 'now')`,
    );
    ins.run('a');
    expect(() => ins.run('b')).toThrow(/UNIQUE/i);

    const insS = direct.prepare(
      `INSERT INTO saml_providers (id, tenant_id, provider, entry_point, issuer, cert, callback_url, created_at)
       VALUES (?, 't1', 'okta', 'ep', 'iss', 'cert', 'cb', 'now')`,
    );
    insS.run('a');
    expect(() => insS.run('b')).toThrow(/UNIQUE/i);
    direct.close();
  });

  it('sso_jti_used PRIMARY KEY su jti blocca i replay (secondo insert stesso jti → throw)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const direct = new SqliteDatabase(_dbPath);
    const ins = direct.prepare(`INSERT INTO sso_jti_used (jti, expires_at) VALUES (?, ?)`);
    ins.run('jti-xyz', Date.now() + 60_000);
    // Questo è ESATTAMENTE il meccanismo anti-replay di sso.ts isReplay().
    expect(() => ins.run('jti-xyz', Date.now() + 60_000)).toThrow(/UNIQUE|constraint/i);
    direct.close();
  });

  it('idempotente: le 6 tabelle sopravvivono a un secondo runMigrations', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations();
    expect(() => {
      runMigrations();
    }).not.toThrow();

    const direct = new SqliteDatabase(_dbPath);
    for (const table of Object.keys(EXPECTED)) {
      expect(tableExists(direct, table), `tabella persa dopo re-run: ${table}`).toBe(true);
    }
    direct.close();
  });
});

describe('🔒 assertSqlIdent — hardening ensureColumn (audit MEDIUM)', () => {
  it('accetta identificatori validi', async () => {
    const { assertSqlIdent } = await import('./migrate.js');
    for (const ok of ['users', 'attachments_json', '_x', 'T1', 'col_2_v3']) {
      expect(() => assertSqlIdent('column', ok)).not.toThrow();
    }
  });
  it('rifiuta injection/identificatori non validi', async () => {
    const { assertSqlIdent } = await import('./migrate.js');
    for (const bad of [
      'users; DROP TABLE x',
      'a b',
      'a-b',
      '1col',
      'a)',
      '"x"',
      'a,b',
      '',
      'a--',
    ]) {
      expect(() => assertSqlIdent('column', bad)).toThrow(/identificatore SQL valido/);
    }
  });
});

describe('runMigrations — ai_conversations.surface CHECK widening (cross-surface)', () => {
  const OLD_AI_CONV = `
    CREATE TABLE ai_conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, workflow_id TEXT,
      surface TEXT NOT NULL CHECK (surface IN ('editor_chat', 'wizard_scaffold', 'help_chat')),
      title TEXT, message_count INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      summary TEXT, summary_at TEXT, summary_message_count INTEGER NOT NULL DEFAULT 0,
      provider_pin TEXT, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL, deleted_at TEXT
    )`;

  it('rebuilda un DB col CHECK VECCHIO (3 surface) → 5 surface, preservando i dati', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    // Pre-esistente col CHECK vecchio + una riga.
    const pre = new SqliteDatabase(_dbPath);
    pre.exec(OLD_AI_CONV);
    pre
      .prepare(
        `INSERT INTO ai_conversations (id, user_id, workspace_id, surface, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('c-old', 'u-1', 'ws-1', 'editor_chat', '2026-06-13T00:00:00Z', '2026-06-13T00:00:00Z');
    // sanity: il CHECK vecchio RIFIUTA node_editor
    expect(() =>
      pre
        .prepare(
          `INSERT INTO ai_conversations (id, user_id, surface, created_at, last_message_at) VALUES ('x','u','node_editor','t','t')`,
        )
        .run(),
    ).toThrow();
    pre.close();

    const { runMigrations } = await import('./migrate.js');
    runMigrations();

    const db = new SqliteDatabase(_dbPath);
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_conversations'`)
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("'node_editor'");
    expect(sql).toContain("'db_studio'");
    // dato preservato
    expect(
      (
        db.prepare(`SELECT user_id FROM ai_conversations WHERE id='c-old'`).get() as {
          user_id: string;
        }
      ).user_id,
    ).toBe('u-1');
    // ora node_editor è accettato
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_conversations (id, user_id, workspace_id, surface, created_at, last_message_at) VALUES ('c-node','u-1','ws-1','node_editor','t','t')`,
        )
        .run(),
    ).not.toThrow();
    // CHECK ancora enforced: surface inventata → throw
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_conversations (id, user_id, surface, created_at, last_message_at) VALUES ('c-bad','u','bogus','t','t')`,
        )
        .run(),
    ).toThrow();
    // indice ricreato
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='ai_conv_surface_idx'`)
      .get();
    expect(idx).toBeDefined();
    db.close();
  });

  it('idempotente: su DB già a 5 surface NON rebuilda due volte (riga resta)', async () => {
    _dbPath = tmpDbPath();
    createdPaths.push(_dbPath);
    const { runMigrations } = await import('./migrate.js');
    runMigrations(); // fresh → 5 surface
    const db1 = new SqliteDatabase(_dbPath);
    db1
      .prepare(
        `INSERT INTO ai_conversations (id, user_id, workspace_id, surface, created_at, last_message_at) VALUES ('c1','u','ws','node_editor','t','t')`,
      )
      .run();
    db1.close();
    vi.resetModules();
    const { runMigrations: again } = await import('./migrate.js');
    again(); // re-run idempotente
    const db2 = new SqliteDatabase(_dbPath);
    expect(
      (db2.prepare(`SELECT COUNT(*) n FROM ai_conversations WHERE id='c1'`).get() as { n: number })
        .n,
    ).toBe(1);
    db2.close();
  });
});
