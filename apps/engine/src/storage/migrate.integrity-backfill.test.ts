/**
 * Bug-bounty test — backfillCustomNodeIntegrity (one-time, anti strip-attack).
 *
 * La proprietà di sicurezza CENTRALE è il punto 2: il backfill firma i nodi
 * legacy UNA SOLA VOLTA per database (flag in system_flags). Un backfill che
 * ri-firmasse a ogni boot le righe senza integrità si fiderebbe di QUALUNQUE
 * contenuto trovi — un attaccante che azzera integrity_* e manomette i
 * sorgenti otterrebbe una firma legittima al riavvio, annullando la difesa.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from './migrate.schema.js';
import { backfillCustomNodeIntegrity } from './migrate.js';
import {
  verifyPackageIntegrity,
  INTEGRITY_ENFORCED_FLAG,
  INTEGRITY_ALGO,
} from '@/lib/custom-node-integrity.js';

vi.mock('@/lib/logger.js');

const SECRET = 'backfill-test-registry-secret-32b!!';

/** Adatta better-sqlite3 all'interfaccia SqliteDb strutturale di migrate.ts. */
function asSqliteDb(c: SqliteDatabase.Database): Parameters<typeof backfillCustomNodeIntegrity>[0] {
  return {
    exec: (sql: string) => {
      c.exec(sql);
    },
    prepare: (sql: string) => {
      const stmt = c.prepare(sql);
      return {
        all: (...p: unknown[]) => stmt.all(...p),
        run: (...p: unknown[]) => stmt.run(...p),
      };
    },
  };
}

let conn: SqliteDatabase.Database;
let savedReg: string | undefined;
let savedTok: string | undefined;

beforeEach(() => {
  conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  savedReg = process.env.MEDEA_REGISTRY_SECRET;
  savedTok = process.env.MEDEA_INTERNAL_TOKEN;
  process.env.MEDEA_REGISTRY_SECRET = SECRET;
});

afterEach(() => {
  conn.close();
  if (savedReg !== undefined) process.env.MEDEA_REGISTRY_SECRET = savedReg;
  else delete process.env.MEDEA_REGISTRY_SECRET;
  if (savedTok !== undefined) process.env.MEDEA_INTERNAL_TOKEN = savedTok;
  else delete process.env.MEDEA_INTERNAL_TOKEN;
});

function insertLegacyNode(
  id: string,
  opts: { compiled?: string | null; executor?: string } = {},
): void {
  const at = new Date().toISOString();
  conn
    .prepare(
      `
    INSERT INTO custom_nodes (
      id, workspace_id, owner_user_id, slug, display_name, status, semver,
      source_executor, source_definition, source_schema, compiled_executor,
      created_at, updated_at
    ) VALUES (?, 'ws-A', 'owner', ?, ?, 'published_priv', '0.1.0', ?, 'def', 'schema', ?, ?, ?)
  `,
    )
    .run(
      id,
      `slug-${id}`,
      `Node ${id}`,
      opts.executor ?? 'exec',
      opts.compiled === undefined ? 'bundle' : opts.compiled,
      at,
      at,
    );
}

function readIntegrity(id: string): {
  digest: string | null;
  signature: string | null;
  algo: string | null;
} {
  return conn
    .prepare(
      'SELECT integrity_digest AS digest, integrity_signature AS signature, integrity_algo AS algo FROM custom_nodes WHERE id = ?',
    )
    .get(id) as { digest: string | null; signature: string | null; algo: string | null };
}

function flagSet(): boolean {
  return (
    conn.prepare('SELECT value FROM system_flags WHERE key = ?').get(INTEGRITY_ENFORCED_FLAG) !==
    undefined
  );
}

describe('🚨 backfillCustomNodeIntegrity', () => {
  it('firma i nodi compilati legacy con record VERIFICABILE + setta il flag', () => {
    insertLegacyNode('n1');
    backfillCustomNodeIntegrity(asSqliteDb(conn));

    const rec = readIntegrity('n1');
    expect(rec.algo).toBe(INTEGRITY_ALGO);
    expect(rec.digest).toMatch(/^[0-9a-f]{64}$/);
    // CONTRACT backfill↔loader: il record deve verificare col pacchetto reale
    // (stesso shape che il runtime-loader ricostruisce al cold-load).
    const verdict = verifyPackageIntegrity(
      {
        slug: 'slug-n1',
        semver: '0.1.0',
        sourceExecutor: 'exec',
        sourceDefinition: 'def',
        sourceSchema: 'schema',
        compiledExecutor: 'bundle',
      },
      { algo: rec.algo as never, digest: rec.digest!, signature: rec.signature! },
      SECRET,
    );
    expect(verdict).toEqual({ valid: true });
    expect(flagSet()).toBe(true);
  });

  it('🚨 ONE-TIME: col flag già settato NON ri-firma (strip-attack non ottiene una firma al reboot)', () => {
    insertLegacyNode('n1');
    backfillCustomNodeIntegrity(asSqliteDb(conn));
    // Strip-attack post-enforcement: l'attaccante azzera integrity_* e
    // manomette l'executor, poi aspetta un riavvio sperando nella ri-firma.
    conn
      .prepare(
        "UPDATE custom_nodes SET integrity_digest = NULL, integrity_signature = NULL, integrity_algo = NULL, source_executor = 'EVIL' WHERE id = 'n1'",
      )
      .run();
    backfillCustomNodeIntegrity(asSqliteDb(conn)); // il "riavvio"
    const rec = readIntegrity('n1');
    expect(rec.digest).toBeNull(); // NON ri-firmato → il loader lo bloccherà
    expect(rec.signature).toBeNull();
  });

  it('righe già firmate → digest INVARIATO (nessuna ri-firma)', () => {
    insertLegacyNode('n1');
    backfillCustomNodeIntegrity(asSqliteDb(conn));
    const before = readIntegrity('n1');
    // Reset del flag per simulare un ipotetico secondo backfill su DB già firmato.
    conn.prepare('DELETE FROM system_flags WHERE key = ?').run(INTEGRITY_ENFORCED_FLAG);
    backfillCustomNodeIntegrity(asSqliteDb(conn));
    expect(readIntegrity('n1')).toEqual(before);
  });

  it('nodi senza compiled_executor (draft mai compilati) → restano NULL, flag comunque settato', () => {
    insertLegacyNode('draft1', { compiled: null });
    backfillCustomNodeIntegrity(asSqliteDb(conn));
    expect(readIntegrity('draft1').digest).toBeNull(); // firmerà persistCompileResult al compile
    expect(flagSet()).toBe(true);
  });

  it('senza secret → nessuna firma e NESSUN flag (back-compat dev/test)', () => {
    delete process.env.MEDEA_REGISTRY_SECRET;
    delete process.env.MEDEA_INTERNAL_TOKEN;
    insertLegacyNode('n1');
    backfillCustomNodeIntegrity(asSqliteDb(conn));
    expect(readIntegrity('n1').digest).toBeNull();
    expect(flagSet()).toBe(false); // senza flag il loader resta lenient (pre-backfill)
  });
});
