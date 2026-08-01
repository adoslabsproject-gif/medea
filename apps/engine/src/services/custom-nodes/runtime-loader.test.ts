/**
 * Test REAL — runtime-loader.ts (in-memory SQLite).
 *
 * Coverage:
 *  - parseCustomDefId: estrae slug da defId valido
 *  - parseCustomDefId: ritorna null se prefisso non `custom_` o slug rotto
 *  - loadCustomNodeForRun: nodo published_priv → entry hit
 *  - loadCustomNodeForRun: nodo draft → null (non runnable)
 *  - loadCustomNodeForRun: nodo archived → null
 *  - loadCustomNodeForRun: nodo sconosciuto → null
 *  - loadCustomNodeForRun: nodo runnable senza compiled_executor → null + warn
 *  - cache: prima call DB, seconda call hit cache (verify via mutazione DB inerme dopo hit)
 *  - isolamento multi-tenant: stesso slug, 2 ws → 2 entry distinte
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => { conn.exec(sql); },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

import { parseCustomDefId, loadCustomNodeForRun } from './runtime-loader.js';
import { invalidateAllCustomNodes } from './cache.js';
import { makePackageIntegrity, INTEGRITY_ENFORCED_FLAG } from '@/lib/custom-node-integrity.js';

const REGISTRY_SECRET = 'integrity-test-secret-32-bytes-xxx!';

/** Inserisce un nodo runnable con record di integrità calcolato sul pacchetto dato. */
function insertNodeWithIntegrity(opts: {
  conn: ReturnType<typeof SqliteDatabase>;
  workspaceId: string;
  slug: string;
  executor: string;
  definition: string;
  schema: string;
  /** Bundle FIRMATO (default 'compiled'). */
  compiled?: string;
  secret?: string;
  /** Sorgenti scritti nel DB (per simulare tamper: diversi da quelli firmati). */
  storedExecutor?: string;
  /** Bundle scritto nel DB (tamper sull'artefatto ESEGUITO). */
  storedCompiled?: string;
}): void {
  const at = new Date().toISOString();
  const compiled = opts.compiled ?? 'compiled';
  const integrity = makePackageIntegrity(
    {
      slug: opts.slug,
      semver: '0.1.0',
      sourceExecutor: opts.executor,
      sourceDefinition: opts.definition,
      sourceSchema: opts.schema,
      compiledExecutor: compiled,
    },
    opts.secret ?? REGISTRY_SECRET,
  );
  opts.conn.prepare(`
    INSERT INTO custom_nodes (
      id, workspace_id, owner_user_id, slug, display_name, status, semver,
      source_executor, source_definition, source_schema, compiled_executor,
      integrity_digest, integrity_signature, integrity_algo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'published_priv', '0.1.0', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `id-${opts.slug}-${opts.workspaceId}`, opts.workspaceId, 'owner', opts.slug, `Display ${opts.slug}`,
    opts.storedExecutor ?? opts.executor, opts.definition, opts.schema,
    opts.storedCompiled ?? compiled,
    integrity.digest, integrity.signature, integrity.algo, at, at,
  );
}

/** Attiva l'enforcement come farebbe il backfill one-time di migrate.ts. */
function setEnforcementFlag(conn: ReturnType<typeof SqliteDatabase>): void {
  conn.prepare(`INSERT INTO system_flags (key, value) VALUES (?, ?)`).run(
    INTEGRITY_ENFORCED_FLAG, new Date().toISOString(),
  );
}

function insertNode(opts: {
  conn: ReturnType<typeof SqliteDatabase>;
  workspaceId: string;
  slug: string;
  status: string;
  compiled?: string | null;
}): void {
  const at = new Date().toISOString();
  opts.conn.prepare(`
    INSERT INTO custom_nodes (
      id, workspace_id, owner_user_id, slug, display_name, status, semver,
      source_executor, source_definition, source_schema, compiled_executor,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `id-${opts.slug}-${opts.workspaceId}`,
    opts.workspaceId,
    'owner',
    opts.slug,
    `Display ${opts.slug}`,
    opts.status,
    '0.1.0',
    'export const executor = () => ({});',
    'export const definition = {};',
    'export const schema = {};',
    opts.compiled ?? null,
    at,
    at,
  );
}

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  invalidateAllCustomNodes();
});

afterEach(() => {
  invalidateAllCustomNodes();
  const conn = dbConnections.pop();
  conn?.close();
});

describe('parseCustomDefId', () => {
  it('estrae slug da defId valido', () => {
    expect(parseCustomDefId('custom_foo_bar')).toBe('foo_bar');
    expect(parseCustomDefId('custom_a1-b2')).toBe('a1-b2');
  });

  it('ritorna null se prefisso non è custom_', () => {
    expect(parseCustomDefId('action_http')).toBeNull();
    expect(parseCustomDefId('community_x')).toBeNull();
    expect(parseCustomDefId('')).toBeNull();
  });

  it('ritorna null se slug non valido', () => {
    expect(parseCustomDefId('custom_')).toBeNull();
    expect(parseCustomDefId('custom_-bad')).toBeNull();
    expect(parseCustomDefId('custom_Foo')).toBeNull(); // uppercase
    expect(parseCustomDefId('custom_foo bar')).toBeNull(); // space
  });
});

describe('loadCustomNodeForRun', () => {
  it('nodo published_priv + compiled → entry', () => {
    insertNode({
      conn: dbConnections[0]!,
      workspaceId: 'ws-A',
      slug: 'foo',
      status: 'published_priv',
      compiled: '(function(){})()',
    });
    const e = loadCustomNodeForRun('custom_foo', 'ws-A');
    expect(e).not.toBeNull();
    expect(e!.semver).toBe('0.1.0');
    expect(e!.status).toBe('published_priv');
  });

  it('nodo draft → null', () => {
    insertNode({
      conn: dbConnections[0]!,
      workspaceId: 'ws-A',
      slug: 'foo',
      status: 'draft',
      compiled: '(function(){})()',
    });
    expect(loadCustomNodeForRun('custom_foo', 'ws-A')).toBeNull();
  });

  it('nodo archived → null', () => {
    insertNode({
      conn: dbConnections[0]!,
      workspaceId: 'ws-A',
      slug: 'foo',
      status: 'archived',
      compiled: '(function(){})()',
    });
    expect(loadCustomNodeForRun('custom_foo', 'ws-A')).toBeNull();
  });

  it('nodo published ma senza compiled_executor → null', () => {
    insertNode({
      conn: dbConnections[0]!,
      workspaceId: 'ws-A',
      slug: 'foo',
      status: 'published_priv',
      compiled: null,
    });
    expect(loadCustomNodeForRun('custom_foo', 'ws-A')).toBeNull();
  });

  it('nodo sconosciuto → null', () => {
    expect(loadCustomNodeForRun('custom_missing', 'ws-A')).toBeNull();
  });

  it('defId con prefisso sbagliato → null', () => {
    expect(loadCustomNodeForRun('not_custom_foo', 'ws-A')).toBeNull();
  });

  it('isolamento multi-tenant: stesso slug, 2 ws', () => {
    insertNode({ conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'foo', status: 'published_priv', compiled: 'a' });
    insertNode({ conn: dbConnections[0]!, workspaceId: 'ws-B', slug: 'foo', status: 'published_priv', compiled: 'b' });
    expect(loadCustomNodeForRun('custom_foo', 'ws-A')!.compiledExecutor).toBe('a');
    expect(loadCustomNodeForRun('custom_foo', 'ws-B')!.compiledExecutor).toBe('b');
  });

  it('cache: seconda call legge dalla cache (DELETE inerme dopo hit)', () => {
    insertNode({ conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'foo', status: 'published_priv', compiled: 'x' });
    const first = loadCustomNodeForRun('custom_foo', 'ws-A');
    expect(first).not.toBeNull();
    // Cancello dal DB → la cache hit deve continuare a ritornare il valore
    dbConnections[0]!.prepare(`DELETE FROM custom_nodes WHERE slug = ?`).run('foo');
    const second = loadCustomNodeForRun('custom_foo', 'ws-A');
    expect(second).not.toBeNull();
    expect(second!.compiledExecutor).toBe('x');
  });
});

describe('🚨 loadCustomNodeForRun — verifica integrità registry (cold-load)', () => {
  beforeEach(() => { process.env.FLOWFORGE_REGISTRY_SECRET = REGISTRY_SECRET; });
  afterEach(() => { delete process.env.FLOWFORGE_REGISTRY_SECRET; });

  it('integrità valida → nodo caricato', () => {
    insertNodeWithIntegrity({
      conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'sec',
      executor: 'export const executor = async () => ({ ok: true });',
      definition: 'export const definition = { defId: "custom_sec" };',
      schema: 'export const schema = {};',
    });
    expect(loadCustomNodeForRun('custom_sec', 'ws-A')).not.toBeNull();
  });

  it('🚨 source_executor MANOMESSO dopo il publish → null (esecuzione bloccata)', () => {
    // Il record di integrità è firmato sull'executor originale, ma nel DB c'è
    // un executor diverso (riga alterata). Il cold-load DEVE rifiutarlo.
    insertNodeWithIntegrity({
      conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'tampered',
      executor: 'export const executor = async () => ({ ok: true });',
      definition: 'export const definition = { defId: "custom_tampered" };',
      schema: 'export const schema = {};',
      storedExecutor: 'export const executor = async () => { /* EXFILTRATE */ };',
    });
    expect(loadCustomNodeForRun('custom_tampered', 'ws-A')).toBeNull();
  });

  it('🚨 firma di un secret diverso → null (record forgiato)', () => {
    insertNodeWithIntegrity({
      conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'forged',
      executor: 'export const executor = async () => ({});',
      definition: 'export const definition = {};',
      schema: 'export const schema = {};',
      secret: 'un-secret-completamente-diverso-32xx',
    });
    expect(loadCustomNodeForRun('custom_forged', 'ws-A')).toBeNull();
  });

  it('🚨 compiled_executor MANOMESSO (l\'artefatto che il sandbox ESEGUE) → null', () => {
    // Era IL bypass: la firma copriva solo i source_* mentre il sandbox esegue
    // compiled_executor — un tamper sul bundle passava la verifica. Ora il
    // bundle è NELLA firma: alterarlo = digest_mismatch = blocco.
    insertNodeWithIntegrity({
      conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'bndl',
      executor: 'export const executor = async () => ({ ok: true });',
      definition: 'export const definition = { defId: "custom_bndl" };',
      schema: 'export const schema = {};',
      compiled: '(function(){ return { ok: true }; })()',
      storedCompiled: '(function(){ /* EXFILTRATE — bundle sostituito */ })()',
    });
    expect(loadCustomNodeForRun('custom_bndl', 'ws-A')).toBeNull();
  });

  it('🚨 STRIP-ATTACK: integrity_* azzerate con enforcement attivo → null', () => {
    // L'attaccante del threat model (UPDATE sulla riga) non manomette il
    // record: lo CANCELLA per ricadere nel percorso legacy fail-open. Col
    // flag di enforcement (settato dal backfill one-time) il loader blocca.
    setEnforcementFlag(dbConnections[0]!);
    insertNode({ conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'stripped', status: 'published_priv', compiled: 'x' });
    expect(loadCustomNodeForRun('custom_stripped', 'ws-A')).toBeNull();
  });

  it('nodo legacy senza integrità PRE-backfill (flag assente) → caricato (back-compat)', () => {
    insertNode({ conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'legacy', status: 'published_priv', compiled: 'x' });
    expect(loadCustomNodeForRun('custom_legacy', 'ws-A')).not.toBeNull();
  });

  it('🚨 record presente ma secret SPARITO dall\'env → null (fail-closed, no crash)', () => {
    insertNodeWithIntegrity({
      conn: dbConnections[0]!, workspaceId: 'ws-A', slug: 'nosecret',
      executor: 'export const executor = async () => ({});',
      definition: 'export const definition = {};',
      schema: 'export const schema = {};',
    });
    const savedInternal = process.env.FLOWFORGE_INTERNAL_TOKEN;
    delete process.env.FLOWFORGE_REGISTRY_SECRET;
    delete process.env.FLOWFORGE_INTERNAL_TOKEN;
    try {
      expect(loadCustomNodeForRun('custom_nosecret', 'ws-A')).toBeNull();
    } finally {
      process.env.FLOWFORGE_REGISTRY_SECRET = REGISTRY_SECRET;
      if (savedInternal !== undefined) process.env.FLOWFORGE_INTERNAL_TOKEN = savedInternal;
    }
  });
});
