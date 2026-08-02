/**
 * Executor del nodo `db_remote_ssh_query` — legge da un DB Postgres ESTERNO
 * attraverso un tunnel SSH (il "nodo che n8n sogna"). SOLA LETTURA, sicuro.
 *
 * Composizione (core testabile con deps iniettate):
 *  1. assertReadOnlyQuery(sql) — PRIMA di aprire qualunque cosa (no socket se
 *     la query non è SELECT/EXPLAIN).
 *  2. connectRemoteDbOverSsh — policy + anti-rebinding + vault secret + tunnel.
 *  3. pgRun su 127.0.0.1:localPort (il forward) → righe.
 *  4. tunnel.close() SEMPRE (finally), anche su errore della query.
 *
 * @module executors/remote-ssh-db-query
 */
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import {
  parseSshDbConfig,
  assertReadOnlyQuery,
  SshPolicyError,
} from '@/services/db-remote-ssh/policy.js';
import {
  connectRemoteDbOverSsh,
  type SecretResolver,
  type DnsResolver,
  type TunnelOpener,
} from '@/services/db-remote-ssh/connect.js';
import { VaultSecretsService } from '@/services/vault-secrets.service.js';

const DEFAULT_ROW_LIMIT = 1000;
const MAX_ROW_LIMIT = 50_000;

export interface PgConn {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}
export type PgRunner = (
  conn: PgConn,
  sql: string,
  rowLimit: number,
) => Promise<Record<string, unknown>[]>;

export interface RemoteSshDeps {
  resolveSecret: SecretResolver;
  dnsResolve?: DnsResolver;
  openTunnel?: TunnelOpener;
  pgRun?: PgRunner;
}

async function mustSecret(resolve: SecretResolver, ref: string): Promise<string> {
  const v = await resolve(ref);
  if (v === null || v === undefined || v === '') {
    throw new SshPolicyError('CONFIG', `Segreto DB non risolvibile: "${ref}".`);
  }
  return v;
}

const defaultPgRun: PgRunner = async (conn, sql, rowLimit) => {
  const { default: postgres } = await import('postgres');
  const sql_ = postgres({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.user,
    password: conn.password,
    ssl: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
    prepare: false,
    // DIFESA IN PROFONDITÀ (revisore 2026-06-14): sessione read-only LATO SERVER.
    // assertReadOnlyQuery (classifyStatement) resta la prima barriera; se mai un
    // bypass del classificatore passasse, Postgres rifiuta comunque ogni scrittura
    // ("cannot execute … in a read-only transaction"). Cintura + bretelle.
    connection: { options: '-c default_transaction_read_only=on' },
  });
  try {
    const rows = await sql_.unsafe(sql).then((r) => r.slice(0, rowLimit));
    return rows;
  } finally {
    await sql_.end({ timeout: 5 });
  }
};

/**
 * Core orchestrazione — deterministico con deps iniettate. Ritorna le righe.
 * @throws SshPolicyError se la query non è sola-lettura o un segreto manca.
 */
export async function executeRemoteSshDbQuery(
  rawConfig: unknown,
  sql: string,
  rowLimit: number,
  deps: RemoteSshDeps,
): Promise<Record<string, unknown>[]> {
  const config = parseSshDbConfig(rawConfig);
  assertReadOnlyQuery(sql); // PRIMA di aprire il tunnel: niente socket se non SELECT/EXPLAIN

  const tunnel = await connectRemoteDbOverSsh(config, {
    resolveSecret: deps.resolveSecret,
    ...(deps.dnsResolve ? { dnsResolve: deps.dnsResolve } : {}),
    ...(deps.openTunnel ? { openTunnel: deps.openTunnel } : {}),
  });
  try {
    const user = config.db.userSecretRef
      ? await mustSecret(deps.resolveSecret, config.db.userSecretRef)
      : 'postgres';
    const password = config.db.passwordSecretRef
      ? await mustSecret(deps.resolveSecret, config.db.passwordSecretRef)
      : '';
    const pgRun = deps.pgRun ?? defaultPgRun;
    const limit = Math.min(Math.max(1, rowLimit || DEFAULT_ROW_LIMIT), MAX_ROW_LIMIT);
    return await pgRun(
      { host: '127.0.0.1', port: tunnel.localPort, database: config.db.database, user, password },
      sql,
      limit,
    );
  } finally {
    await tunnel.close();
  }
}

/**
 * Costruisce un SecretResolver dal vault iniettato (testabile).
 *
 * Contratto di `vault.resolve` (vault-secrets.service): `undefined` = NON è un
 * riferimento vault; `null` = È un ref vault ma la risoluzione è fallita; string
 * = risolto.
 *
 * Indurimento (revisore 2026-06-14): un ref con FORMA vault (`vault:…`) che NON
 * risolve NON deve mai ricadere sul valore letterale (prima un `vault:` malformato
 * tornava undefined → usato come password in chiaro, mascherando un typo). Solo i
 * valori chiaramente non-vault restano letterali (back-compat dev/local).
 */
export function makeVaultResolverFrom(
  resolveRef: (ref: string) => Promise<string | null | undefined>,
): SecretResolver {
  return async (ref: string) => {
    const v = await resolveRef(ref);
    if (v === null) {
      throw new SshPolicyError(
        'CONFIG',
        `Segreto vault non risolvibile (vault non configurato o path errato): "${ref}".`,
      );
    }
    if (v === undefined) {
      if (ref.trim().toLowerCase().startsWith('vault:')) {
        throw new SshPolicyError(
          'CONFIG',
          `Riferimento vault malformato: "${ref}" (atteso "vault:<mount>/<path>#<key>"). Non uso il valore come segreto letterale.`,
        );
      }
      return ref; // valore letterale/local legittimo (non ha forma vault)
    }
    return v;
  };
}

/** Resolver segreti reale: vault per i ref `vault:…`, letterale per gli altri. */
function makeVaultResolver(): SecretResolver {
  const vault = new VaultSecretsService();
  return makeVaultResolverFrom((ref) => vault.resolve(ref));
}

/** NodeExecutor (wrapper runtime): config { ssh, db } + sql + rowLimit. */
export const remoteSshDbQueryExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const sql = typeof config.sql === 'string' ? config.sql : '';
  const rowLimit = config.rowLimit !== undefined ? Number(config.rowLimit) : DEFAULT_ROW_LIMIT;
  const rows = await executeRemoteSshDbQuery(
    { ssh: config.ssh, db: config.db, readOnly: true },
    sql,
    rowLimit,
    { resolveSecret: makeVaultResolver() },
  );
  return {
    output: { rows, rowCount: rows.length, durationMs: Date.now() - start },
    durationMs: Date.now() - start,
  };
};
