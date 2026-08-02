/**
 * Bug-bounty test — resignCustomNodesWithStableSecret (one-time, rotazione del
 * registry secret SENZA aprire un buco).
 *
 * Incidente owner 2026-06-12 (Streammy): il registry secret derivava da
 * MEDEA_INTERNAL_TOKEN, rigenerato a ogni recreate del container → tutte le
 * firme dei custom node diventavano `signature_mismatch` → il loader bloccava
 * nodi legittimi ("Unknown node def"). Fix in due parti: (1) secret reso STABILE
 * (registry-secret.ts, da SSO_SECRET); (2) QUESTA ri-firma one-time al boot.
 *
 * La proprietà di sicurezza CENTRALE: ri-firmiamo SOLO i nodi i cui SORGENTI
 * sono ancora integri rispetto al digest dichiarato (rotazione legittima). Un
 * nodo con sorgenti manomessi (digest che non torna) NON deve MAI ottenere una
 * firma valida col nuovo secret — altrimenti la rotazione diventerebbe un grimaldello
 * per certificare codice malevolo. Più: one-time per-DB (flag), così la finestra
 * non si riapre a ogni reboot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from './migrate.schema.js';
import { resignCustomNodesWithStableSecret } from './migrate.js';
import {
  makePackageIntegrity,
  verifyPackageIntegrity,
  type CustomNodePackage,
} from '@/lib/custom-node-integrity.js';

vi.mock('@/lib/logger.js');

const RESIGNED_FLAG = 'custom_nodes_resigned_stable_secret_v1';
// Simula i due secret dell'incidente: quello effimero (vecchio token) e quello
// stabile (derivato da SSO_SECRET). La ri-firma deve traghettare dal primo al secondo.
const OLD_SECRET = 'ephemeral-internal-token-OLD-32byte!!';
const NEW_SECRET = 'stable-sso-derived-registry-NEW-32by!';

function asSqliteDb(
  c: SqliteDatabase.Database,
): Parameters<typeof resignCustomNodesWithStableSecret>[0] {
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
  // Il secret CORRENTE (stabile) lo forziamo via override esplicito: registrySecret()
  // ritorna MEDEA_REGISTRY_SECRET se presente.
  process.env.MEDEA_REGISTRY_SECRET = NEW_SECRET;
});

afterEach(() => {
  conn.close();
  if (savedReg !== undefined) process.env.MEDEA_REGISTRY_SECRET = savedReg;
  else delete process.env.MEDEA_REGISTRY_SECRET;
  if (savedTok !== undefined) process.env.MEDEA_INTERNAL_TOKEN = savedTok;
  else delete process.env.MEDEA_INTERNAL_TOKEN;
});

/** Pacchetto reale ricostruito dai campi del nodo (stesso shape del loader). */
function pkgOf(
  id: string,
  executor = 'exec',
  def = 'def',
  schema = 'schema',
  compiled = 'bundle',
): CustomNodePackage {
  return {
    slug: `slug-${id}`,
    semver: '0.1.0',
    sourceExecutor: executor,
    sourceDefinition: def,
    sourceSchema: schema,
    compiledExecutor: compiled,
  };
}

/** Inserisce un nodo runnable e lo FIRMA con `secret` (simula firma pregressa). */
function insertSignedNode(
  id: string,
  secret: string,
  opts: { executor?: string; compiled?: string | null } = {},
): void {
  const at = new Date().toISOString();
  const executor = opts.executor ?? 'exec';
  const compiled = opts.compiled === undefined ? 'bundle' : opts.compiled;
  let digest: string | null = null;
  let signature: string | null = null;
  let algo: string | null = null;
  if (compiled !== null) {
    const integ = makePackageIntegrity(pkgOf(id, executor, 'def', 'schema', compiled), secret);
    digest = integ.digest;
    signature = integ.signature;
    algo = integ.algo;
  }
  conn
    .prepare(
      `
    INSERT INTO custom_nodes (
      id, workspace_id, owner_user_id, slug, display_name, status, semver,
      source_executor, source_definition, source_schema, compiled_executor,
      integrity_digest, integrity_signature, integrity_algo,
      created_at, updated_at
    ) VALUES (?, 'ws-A', 'owner', ?, ?, 'published_priv', '0.1.0', ?, 'def', 'schema', ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(id, `slug-${id}`, `Node ${id}`, executor, compiled, digest, signature, algo, at, at);
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

/**
 * Replica esatta del verdetto che il runtime-loader calcola al cold-load:
 * ricostruisce il pacchetto dalle colonne REALI della riga (come fa il loader),
 * non da valori di comodo — così il test riflette il comportamento di produzione.
 */
function loaderVerdict(id: string, secret: string): ReturnType<typeof verifyPackageIntegrity> {
  const row = conn
    .prepare(
      `SELECT slug, semver, source_executor, source_definition, source_schema, compiled_executor,
            integrity_digest, integrity_signature, integrity_algo FROM custom_nodes WHERE id = ?`,
    )
    .get(id) as {
    slug: string;
    semver: string;
    source_executor: string;
    source_definition: string;
    source_schema: string;
    compiled_executor: string | null;
    integrity_digest: string | null;
    integrity_signature: string | null;
    integrity_algo: string | null;
  };
  return verifyPackageIntegrity(
    {
      slug: row.slug,
      semver: row.semver,
      sourceExecutor: row.source_executor,
      sourceDefinition: row.source_definition,
      sourceSchema: row.source_schema,
      compiledExecutor: row.compiled_executor ?? '',
    },
    {
      algo: row.integrity_algo as never,
      digest: row.integrity_digest ?? '',
      signature: row.integrity_signature ?? '',
    },
    secret,
  );
}

function flagSet(): boolean {
  return (
    conn.prepare('SELECT value FROM system_flags WHERE key = ?').get(RESIGNED_FLAG) !== undefined
  );
}

describe('🚨 resignCustomNodesWithStableSecret — rotazione sicura del registry secret', () => {
  it('REPLAY INCIDENTE: nodo firmato col vecchio token → loader BLOCCA prima, ACCETTA dopo la ri-firma', () => {
    insertSignedNode('streammy', OLD_SECRET);

    // Pre-fix: il loader (secret stabile NUOVO) vede una firma fatta col vecchio
    // token → signature_mismatch → blocco. Esattamente il bug Streammy.
    expect(loaderVerdict('streammy', NEW_SECRET)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });

    resignCustomNodesWithStableSecret(asSqliteDb(conn));

    // Post-fix: ri-firmato col secret stabile → il loader lo accetta.
    expect(loaderVerdict('streammy', NEW_SECRET)).toEqual({ valid: true });
    expect(flagSet()).toBe(true);
  });

  it('digest INVARIATO dopo la ri-firma (cambia SOLO la firma) — i sorgenti non sono toccati', () => {
    insertSignedNode('n1', OLD_SECRET);
    const before = readIntegrity('n1');
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    const after = readIntegrity('n1');
    expect(after.digest).toBe(before.digest); // stesso contenuto → stesso digest
    expect(after.signature).not.toBe(before.signature); // firma nuova (secret nuovo)
    expect(after.algo).toBe(before.algo);
  });

  it('🚨🚨 SECURITY: nodo con SORGENTI MANOMESSI (digest non torna) → NON ri-firmato, loader continua a bloccare', () => {
    // Firma col vecchio secret, poi un attaccante manomette l'executor lasciando
    // il digest pregresso. Il digest NON corrisponde più ai sorgenti reali.
    insertSignedNode('evil', OLD_SECRET);
    conn
      .prepare("UPDATE custom_nodes SET source_executor = 'STEAL_SECRETS()' WHERE id = 'evil'")
      .run();
    const tamperedBefore = readIntegrity('evil');

    resignCustomNodesWithStableSecret(asSqliteDb(conn));

    // La firma NON è stata rigenerata: ri-firmarla certificherebbe codice malevolo.
    expect(readIntegrity('evil')).toEqual(tamperedBefore);
    // E il loader col secret stabile la rifiuta comunque (digest_mismatch sui sorgenti reali).
    expect(loaderVerdict('evil', NEW_SECRET).valid).toBe(false);
  });

  it('🚨🚨 ONE-TIME — il gate è LOAD-BEARING: un FORGE auto-consistente iniettato dopo il 1° boot NON viene ri-firmato', () => {
    // Primo boot legittimo: ri-firma i nodi sani, setta il flag.
    insertSignedNode('n1', OLD_SECRET);
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(flagSet()).toBe(true);

    // ATTACCO: dopo il primo boot un attaccante con accesso al DB inietta un nodo
    // FORGIATO e AUTO-CONSISTENTE: digest = digest dei SUOI sorgenti malevoli,
    // firma fasulla. La guardia anti-tamper da sola NON lo ferma (il digest TORNA,
    // perché l'attaccante controlla sia sorgenti che digest). Solo il gate one-time
    // impedisce che al prossimo boot venga ri-firmato col secret stabile → senza il
    // gate l'attaccante otterrebbe una firma VALIDA su codice malevolo (RCE).
    const at = new Date().toISOString();
    const evil = pkgOf('forge', 'STEAL_ALL_SECRETS()');
    const selfConsistentDigest = makePackageIntegrity(evil, 'qualunque-secret-attaccante').digest;
    conn
      .prepare(
        `
      INSERT INTO custom_nodes (id, workspace_id, owner_user_id, slug, display_name, status, semver,
        source_executor, source_definition, source_schema, compiled_executor,
        integrity_digest, integrity_signature, integrity_algo, created_at, updated_at)
      VALUES ('forge', 'ws-A', 'owner', 'slug-forge', 'Forge', 'published_priv', '0.1.0',
        'STEAL_ALL_SECRETS()', 'def', 'schema', 'bundle', ?, 'firma-fasulla', 'sha256+hmac-sha256', ?, ?)
    `,
      )
      .run(selfConsistentDigest, at, at);

    resignCustomNodesWithStableSecret(asSqliteDb(conn)); // secondo boot

    // Il forge NON deve avere una firma valida col secret stabile.
    expect(readIntegrity('forge').signature).toBe('firma-fasulla'); // intoccato dal gate
    expect(loaderVerdict('forge', NEW_SECRET)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('idempotente sui nodi sani: ri-eseguito (flag resettato) produce lo stesso record', () => {
    insertSignedNode('n1', OLD_SECRET);
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    const first = readIntegrity('n1');
    conn.prepare('DELETE FROM system_flags WHERE key = ?').run(RESIGNED_FLAG);
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(readIntegrity('n1')).toEqual(first); // firma deterministica (HMAC), stesso secret
  });

  it('nodo già firmato col secret CORRENTE → ri-firma identica (no-op osservabile), resta valido', () => {
    insertSignedNode('fresh', NEW_SECRET); // già col secret giusto
    expect(loaderVerdict('fresh', NEW_SECRET)).toEqual({ valid: true });
    const before = readIntegrity('fresh');
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(readIntegrity('fresh')).toEqual(before); // HMAC deterministico → bit-identico
    expect(loaderVerdict('fresh', NEW_SECRET)).toEqual({ valid: true });
  });

  it('IGNORA i nodi legacy SENZA integrity_digest (li gestisce il backfill, non il resign)', () => {
    // compiled presente ma nessun record di integrità (nodo legacy pre-enforcement).
    const at = new Date().toISOString();
    conn
      .prepare(
        `
      INSERT INTO custom_nodes (id, workspace_id, owner_user_id, slug, display_name, status, semver,
        source_executor, source_definition, source_schema, compiled_executor, created_at, updated_at)
      VALUES ('legacy', 'ws-A', 'owner', 'slug-legacy', 'Legacy', 'published_priv', '0.1.0',
        'exec', 'def', 'schema', 'bundle', ?, ?)
    `,
      )
      .run(at, at);
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(readIntegrity('legacy').digest).toBeNull(); // intoccato
    expect(flagSet()).toBe(true); // il flag si setta comunque (one-time per-DB)
  });

  it('IGNORA i nodi senza compiled_executor (draft mai compilati)', () => {
    insertSignedNode('draft', OLD_SECRET, { compiled: null });
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(readIntegrity('draft').digest).toBeNull();
  });

  it("senza secret nell'env → no-op totale, NESSUN flag (back-compat dev/test)", () => {
    delete process.env.MEDEA_REGISTRY_SECRET;
    delete process.env.MEDEA_INTERNAL_TOKEN;
    insertSignedNode('n1', OLD_SECRET);
    const before = readIntegrity('n1');
    resignCustomNodesWithStableSecret(asSqliteDb(conn));
    expect(readIntegrity('n1')).toEqual(before);
    expect(flagSet()).toBe(false);
  });

  it('multi-nodo: ri-firma i sani e salta i manomessi nello stesso giro', () => {
    insertSignedNode('ok1', OLD_SECRET);
    insertSignedNode('ok2', OLD_SECRET);
    insertSignedNode('bad', OLD_SECRET);
    conn.prepare("UPDATE custom_nodes SET source_definition = 'TAMPERED' WHERE id = 'bad'").run();
    const badBefore = readIntegrity('bad');

    resignCustomNodesWithStableSecret(asSqliteDb(conn));

    expect(loaderVerdict('ok1', NEW_SECRET)).toEqual({ valid: true });
    expect(loaderVerdict('ok2', NEW_SECRET)).toEqual({ valid: true });
    expect(readIntegrity('bad')).toEqual(badBefore); // saltato
    expect(loaderVerdict('bad', NEW_SECRET).valid).toBe(false);
  });
});
