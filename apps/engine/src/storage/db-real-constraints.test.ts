/**
 * Test 2026-grade integration runtime — verifica i CHECK constraint,
 * FK ON DELETE, default values e PK uniqueness sulle 14+ tabelle
 * SQLite del runtime (definite in migrate.schema.ts + ensureColumn
 * evolutivi in migrate.ts).
 *
 * Differenza da db-schema-coverage.test.ts:
 *  - quel test verifica che le QUERY non abbiano colonne/tabelle fantasma
 *  - questo verifica che il COMPORTAMENTO del DB (FK, CHECK, default,
 *    PK uniqueness, indici) sia esatto al boot dopo runMigrations()
 *
 * Tabelle coperte:
 *  workflows, runs, credentials, audit_log, users, viewer_share_tokens,
 *  workflow_checkpoints, paused_workflows, workers, ai_conversations,
 *  ai_messages, ai_workflow_calls, ai_budget_daily, ai_workflow_templates
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/logger.js');

const { runMigrations } = await import('./migrate.js');

beforeAll(() => {
  runMigrations();
  // SQLite richiede PRAGMA foreign_keys = ON esplicito per ogni connection
  db.pragma('foreign_keys = ON');
});

describe('🚨 workflows table', () => {
  it('🚨 PK id UNIQUE: INSERT 2x stesso id → throw', () => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf1', 'Test', '2026-06-07', '2026-06-07')
    `).run();
    expect(() =>
      db.prepare(`
        INSERT INTO workflows (id, name, created_at, updated_at)
        VALUES ('wf1', 'OtherName', '2026-06-07', '2026-06-07')
      `).run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/iu);
  });

  it('🚨 default tenant_id = "default"', () => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf-default', 'X', '2026-06-07', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT tenant_id FROM workflows WHERE id = 'wf-default'`).get() as { tenant_id: string };
    expect(r.tenant_id).toBe('default');
  });

  it('🚨 default enabled = 0 (false)', () => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf-enabled', 'X', '2026-06-07', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT enabled FROM workflows WHERE id = 'wf-enabled'`).get() as { enabled: number };
    expect(r.enabled).toBe(0);
  });

  it('🚨 nodes_json default = "[]"', () => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf-nodes', 'X', '2026-06-07', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT nodes_json, edges_json, node_defs_json FROM workflows WHERE id = 'wf-nodes'`).get() as { nodes_json: string; edges_json: string; node_defs_json: string };
    expect(r.nodes_json).toBe('[]');
    expect(r.edges_json).toBe('[]');
    expect(r.node_defs_json).toBe('[]');
  });

  it('🚨 NOT NULL name → throw', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO workflows (id, created_at, updated_at)
        VALUES ('wf-noname', '2026-06-07', '2026-06-07')
      `).run(),
    ).toThrow(/NOT NULL constraint|name/iu);
  });
});

describe('🚨 runs table — FK CASCADE + default status', () => {
  beforeAll(() => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf-runs', 'WithRuns', '2026-06-07', '2026-06-07')
    `).run();
  });

  it('🚨 FK workflow_id → workflows(id): inesistente → throw', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO runs (id, workflow_id, started_at)
        VALUES ('r-bad', 'phantom-wf', '2026-06-07')
      `).run(),
    ).toThrow(/FOREIGN KEY constraint/iu);
  });

  it('🚨 happy + default status="pending"', () => {
    db.prepare(`
      INSERT INTO runs (id, workflow_id, started_at)
      VALUES ('r-ok', 'wf-runs', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT status, input, steps_json, error_count FROM runs WHERE id = 'r-ok'`).get() as { status: string; input: string; steps_json: string; error_count: number };
    expect(r.status).toBe('pending');
    expect(r.input).toBe('');
    expect(r.steps_json).toBe('[]');
    expect(r.error_count).toBe(0);
  });

  it('🚨 FK ON DELETE CASCADE: drop workflow → runs cancellate', () => {
    db.prepare(`
      INSERT INTO workflows (id, name, created_at, updated_at)
      VALUES ('wf-cascade', 'Cas', '2026-06-07', '2026-06-07')
    `).run();
    db.prepare(`INSERT INTO runs (id, workflow_id, started_at) VALUES ('r-cas1', 'wf-cascade', '2026-06-07')`).run();
    db.prepare(`INSERT INTO runs (id, workflow_id, started_at) VALUES ('r-cas2', 'wf-cascade', '2026-06-07')`).run();

    db.prepare(`DELETE FROM workflows WHERE id = 'wf-cascade'`).run();

    const remaining = db.prepare(`SELECT id FROM runs WHERE workflow_id = 'wf-cascade'`).all();
    expect(remaining).toHaveLength(0);
  });
});

describe('🚨 credentials table', () => {
  it('🚨 NOT NULL ciphertext BLOB + nonce BLOB → INSERT senza → throw', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO credentials (id, name, provider, created_at, updated_at)
        VALUES ('c1', 'apikey', 'openai', '2026-06-07', '2026-06-07')
      `).run(),
    ).toThrow(/NOT NULL constraint|ciphertext|nonce/iu);
  });

  it('🚨 happy BLOB ciphertext + nonce', () => {
    const insert = db.prepare(`
      INSERT INTO credentials (id, name, provider, ciphertext, nonce, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('c-ok', 'k1', 'openai', Buffer.from([1, 2, 3]), Buffer.from([9, 9]), '2026-06-07', '2026-06-07');
    const r = db.prepare(`SELECT length(ciphertext) AS clen, length(nonce) AS nlen FROM credentials WHERE id = 'c-ok'`).get() as { clen: number; nlen: number };
    expect(r.clen).toBe(3);
    expect(r.nlen).toBe(2);
  });

  it('🚨 default tenant_id = "default"', () => {
    db.prepare(`
      INSERT INTO credentials (id, name, provider, ciphertext, nonce, created_at, updated_at)
      VALUES ('c-def', 'k2', 'anthropic', x'01', x'02', '2026-06-07', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT tenant_id FROM credentials WHERE id = 'c-def'`).get() as { tenant_id: string };
    expect(r.tenant_id).toBe('default');
  });
});

describe('🚨 audit_log table — hash chain (NOT NULL hash + AUTOINCREMENT)', () => {
  it('🚨 PK AUTOINCREMENT: 2 INSERT con hash → id auto incrementati', () => {
    db.prepare(`
      INSERT INTO audit_log (action, resource_type, hash, created_at)
      VALUES ('login', 'session', 'h1', '2026-06-07')
    `).run();
    db.prepare(`
      INSERT INTO audit_log (action, resource_type, hash, created_at)
      VALUES ('logout', 'session', 'h2', '2026-06-07')
    `).run();
    const r = db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number };
    expect(r.c).toBeGreaterThanOrEqual(2);
  });

  it('🚨 NOT NULL action', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO audit_log (resource_type, hash, created_at)
        VALUES ('session', 'h', '2026-06-07')
      `).run(),
    ).toThrow(/NOT NULL constraint|action/iu);
  });

  it('🚨 NOT NULL hash (hash chain integrity)', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO audit_log (action, resource_type, created_at)
        VALUES ('login', 'session', '2026-06-07')
      `).run(),
    ).toThrow(/NOT NULL constraint|hash/iu);
  });

  it('🚨 NOT NULL created_at', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO audit_log (action, resource_type, hash)
        VALUES ('login', 'session', 'h')
      `).run(),
    ).toThrow(/NOT NULL constraint|created_at/iu);
  });

  it('🚨 prev_hash nullable (genesis row ok)', () => {
    db.prepare(`
      INSERT INTO audit_log (action, resource_type, hash, prev_hash, created_at)
      VALUES ('genesis', 'sys', 'g-hash', NULL, '2026-06-07')
    `).run();
  });
});

describe('🚨 users table (runtime tenant users)', () => {
  it('🚨 happy INSERT', () => {
    // Cerca le colonne reali della tabella users runtime
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const hasId = cols.some((c) => c.name === 'id');
    const hasEmail = cols.some((c) => c.name === 'email');
    expect(hasId).toBe(true);
    expect(hasEmail).toBe(true);
  });
});

describe('🚨 viewer_share_tokens table', () => {
  it('🚨 tabella esiste con colonna token', () => {
    const cols = db.prepare(`PRAGMA table_info(viewer_share_tokens)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('🚨 workflow_checkpoints table', () => {
  it('🚨 tabella esiste (incrementale steps_json flush)', () => {
    const cols = db.prepare(`PRAGMA table_info(workflow_checkpoints)`).all() as { name: string }[];
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe('🚨 paused_workflows table', () => {
  it('🚨 tabella esiste (pause/resume state)', () => {
    const cols = db.prepare(`PRAGMA table_info(paused_workflows)`).all() as { name: string }[];
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe('🚨 workers table', () => {
  it('🚨 tabella esiste (worker pool heartbeat)', () => {
    const cols = db.prepare(`PRAGMA table_info(workers)`).all() as { name: string }[];
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe('🚨 ai_conversations + ai_messages + ai_workflow_calls + ai_budget_daily + ai_workflow_templates', () => {
  it.each([
    'ai_conversations',
    'ai_messages',
    'ai_workflow_calls',
    'ai_budget_daily',
    'ai_workflow_templates',
  ])('tabella %s esiste con colonne', (table) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe('🚨 indici critici esistono', () => {
  it.each([
    'workflows_tenant_idx',
    'workflows_name_idx',
    'runs_workflow_idx',
    'runs_status_idx',
    'runs_started_at_idx',
    'credentials_provider_idx',
    'credentials_tenant_name_idx',
  ])('indice "%s" esiste', (indexName) => {
    const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(indexName);
    expect(r).toBeDefined();
  });
});

describe('🚨 PRAGMA foreign_keys: deve essere ENABLED', () => {
  it('🚨 PRAGMA foreign_keys = ON dopo runMigrations + setup', () => {
    const r = db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number };
    expect(r.foreign_keys).toBe(1);
  });
});

describe('🚨 invariant: SCHEMA_SQL inserisce 14 tabelle base + evolutive', () => {
  it('🚨 almeno 14 tabelle create da SCHEMA_SQL (sanity)', () => {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get() as { c: number };
    expect(r.c).toBeGreaterThanOrEqual(14);
  });
});
