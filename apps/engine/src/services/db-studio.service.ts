import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter, type IDatabaseAdapter, type BatchOp, type BatchResult } from '@medea/engine-db-studio-engine';
import { PostgresAdapter } from '@medea/engine-db-studio-postgres';
import { MysqlAdapter } from '@medea/engine-db-studio-mysql';
import { MongoDbAdapter } from '@medea/engine-db-studio-mongodb';
import { RedisAdapter } from '@medea/engine-db-studio-redis';
import { MssqlAdapter } from '@medea/engine-db-studio-mssql';
import { DuckDbAdapter } from '@medea/engine-db-studio-duckdb';
import { sealConnectionSecrets, unsealConnectionSecrets } from '@/services/db-studio/connection-secrets.js';
import { paginatePages } from '@/services/db-studio/db-export.js';
import {
  type Database,
  type MigrationAction,
  type QuerySpec,
  DatabaseSchema,
} from '@medea/engine-db-studio-core';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { loadConfig } from '@/config.js';
import { nanoid } from 'nanoid';
import { assertExternalHostAllowed } from '@/services/db-studio/external-host-guard.js';
import { openDbStudioSshTunnel } from '@/services/db-studio/ssh-tunnel-bridge.js';

interface DatabaseRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

function ensureDatabasesTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS db_studio_databases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      description TEXT,
      spec_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS db_studio_databases_tenant_idx ON db_studio_databases(tenant_id);

    CREATE TABLE IF NOT EXISTS db_change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      database_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      op TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS db_change_log_lookup_idx
      ON db_change_log(tenant_id, database_id, table_name, id);
  `);
}

function appendChangeLog(
  tenantId: string,
  databaseId: string,
  tableName: string,
  op: 'insert' | 'update' | 'delete',
  payload: unknown,
): void {
  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      'INSERT INTO db_change_log (tenant_id, database_id, table_name, op, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(tenantId, databaseId, tableName, op, JSON.stringify(payload), new Date().toISOString());
}

/** Quoting dell'identificatore tabella per dialetto, con escape (anti-injection):
 *  mysql → `x`, mssql → [x], altri (postgres/sqlite/duckdb/pgvector) → "x". */
export function quoteTableForEngine(engine: string, table: string): string {
  if (engine === 'mysql') return `\`${table.replace(/`/gu, '``')}\``;
  if (engine === 'mssql') return `[${table.replace(/\]/gu, ']]')}]`;
  return `"${table.replace(/"/gu, '""')}"`;
}

/** Placeholder mostrato al posto di un secret nella vista cross-tenant. */
export const REDACTED_SECRET = '***redacted***';

/**
 * Redazione dei riferimenti-secret della connessione per la vista cross-tenant
 * del superadmin (fix 2026-06-15). La bird's-eye view "gestore server"
 * (listAllAcrossTenants/getAnyTenant) NON deve esporre i secret di ALTRI tenant:
 * un passwordSecretRef LETTERALE sarebbe una password in chiaro leakata, e anche
 * i ref `vault:` rivelano i path del vault altrui. Per USARE/modificare davvero
 * un DB il superadmin deve IMPERSONARE (x-tenant-id → path tenant-scoped, audited)
 * che ritorna i valori reali. Ritorna SEMPRE una copia (mai muta l'input).
 */
export function redactConnectionSecrets(db: Database): Database {
  const conn = db.connection as Record<string, unknown>;
  const redacted: Record<string, unknown> = { ...conn };
  for (const key of ['passwordSecretRef', 'apiKeySecretRef']) {
    if (typeof redacted[key] === 'string' && redacted[key] !== '') redacted[key] = REDACTED_SECRET;
  }
  const ssh = redacted.sshTunnel as Record<string, unknown> | undefined;
  if (ssh && typeof ssh === 'object') {
    const sshCopy: Record<string, unknown> = { ...ssh };
    for (const key of ['privateKeySecretRef', 'passphraseSecretRef']) {
      if (typeof sshCopy[key] === 'string' && sshCopy[key] !== '') sshCopy[key] = REDACTED_SECRET;
    }
    redacted.sshTunnel = sshCopy;
  }
  return { ...db, connection: redacted as Database['connection'] };
}

export class DbStudioService {
  private readonly adapters = new Map<string, IDatabaseAdapter>();
  /** Tunnel SSH aperti per connessioni `sshTunnel` (chiave = database.id). Chiusi
   *  alla disconnessione/eviction dell'adapter corrispondente. */
  private readonly tunnels = new Map<string, { close: () => Promise<void> }>();

  constructor() {
    ensureDatabasesTable();
  }

  list(tenantId = 'default'): Database[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM db_studio_databases WHERE tenant_id = ? ORDER BY updated_at DESC')
      .all(tenantId) as DatabaseRow[];
    return rows.map((r) => {
      // Inietta tenant_id nello spec_json prima del parse — alcuni
      // spec legacy potrebbero non averlo, ma il frontend cross-tenant
      // lo richiede per il grouping.
      const spec = JSON.parse(r.spec_json) as Record<string, unknown>;
      spec.tenantId = r.tenant_id;
      return DatabaseSchema.parse(spec);
    });
  }

  /**
   * Cross-tenant listing — usato SOLO dalla route /databases quando il
   * caller è superadmin senza impersonate (vista "gestore server").
   * Ritorna tutti i DB di tutti i tenant con tenantId esposto per
   * permettere alla UI il grouping.
   */
  listAllAcrossTenants(): Database[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM db_studio_databases ORDER BY tenant_id ASC, updated_at DESC')
      .all() as DatabaseRow[];
    return rows.map((r) => {
      const spec = JSON.parse(r.spec_json) as Record<string, unknown>;
      spec.tenantId = r.tenant_id;
      return redactConnectionSecrets(DatabaseSchema.parse(spec));
    });
  }

  get(id: string, tenantId = 'default'): Database | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM db_studio_databases WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as DatabaseRow | undefined;
    if (!row) return null;
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    spec.tenantId = row.tenant_id;
    return DatabaseSchema.parse(spec);
  }

  /**
   * Cross-tenant get — superadmin senza impersonate può aprire qualsiasi
   * DB del server. Usato dalla route /databases/:id quando isCrossTenant.
   */
  getAnyTenant(id: string): Database | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM db_studio_databases WHERE id = ?')
      .get(id) as DatabaseRow | undefined;
    if (!row) return null;
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    spec.tenantId = row.tenant_id;
    return redactConnectionSecrets(DatabaseSchema.parse(spec));
  }

  create(input: Omit<Database, 'id' | 'createdAt' | 'updatedAt'>): Database {
    const id = nanoid();
    const now = new Date().toISOString();
    const database: Database = { ...input, id, createdAt: now, updatedAt: now };
    const validated = DatabaseSchema.parse(database);

    // Encryption-at-rest: il secret letterale viene cifrato PRIMA di toccare il
    // disco (lo spec_json non contiene mai password in chiaro).
    const stored = { ...validated, connection: sealConnectionSecrets(validated.connection, validated.tenantId) };

    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO db_studio_databases (id, tenant_id, name, description, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        stored.id,
        stored.tenantId,
        stored.name,
        stored.description ?? null,
        JSON.stringify(stored),
        stored.createdAt,
        stored.updatedAt,
      );
    return validated;
  }

  update(id: string, patch: Partial<Database>, tenantId = 'default'): Database | null {
    const existing = this.get(id, tenantId); // connection STORED (sealed/literal)
    if (!existing) return null;

    // Secret handling (encryption-at-rest):
    //  - se il patch porta una connection, e il suo passwordSecretRef è VUOTO o
    //    il sentinel di redazione ('***redacted***', ciò che il frontend ha
    //    ricevuto e rimandato indietro), allora MANTIENI il secret già salvato
    //    (il frontend non vede mai il valore reale → non può reinviarlo).
    //  - poi sealConnectionSecrets cifra eventuali literal (nuovi O ereditati da
    //    righe pre-encryption) e lascia invariati enc:/vault:.
    let patchToApply = patch;
    if (patch.connection !== undefined) {
      const pwIn = (patch.connection as Record<string, unknown>).passwordSecretRef;
      const keepExisting = pwIn === undefined || pwIn === '' || pwIn === REDACTED_SECRET;
      const mergedConn = keepExisting
        ? { ...patch.connection, passwordSecretRef: (existing.connection as Record<string, unknown>).passwordSecretRef as string | undefined }
        : patch.connection;
      patchToApply = { ...patch, connection: sealConnectionSecrets(mergedConn, tenantId) };
    }

    const next = DatabaseSchema.parse({ ...existing, ...patchToApply, id, tenantId, updatedAt: new Date().toISOString() });
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'UPDATE db_studio_databases SET name = ?, description = ?, spec_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      )
      .run(next.name, next.description ?? null, JSON.stringify(next), next.updatedAt, id, tenantId);
    return next;
  }

  delete(id: string, tenantId = 'default'): boolean {
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM db_studio_databases WHERE id = ? AND tenant_id = ?')
      .run(id, tenantId);
    this.adapters.delete(id);
    void this.closeTunnel(id); // chiude l'eventuale tunnel SSH (best-effort, async)
    return info.changes > 0;
  }

  async getAdapter(database: Database): Promise<IDatabaseAdapter> {
    const cached = this.adapters.get(database.id);
    if (cached) return cached;

    // Encryption-at-rest: decifra il secret (enc:) JUST-IN-TIME su una COPIA
    // prima di costruire la connessione reale. Lo spec a riposo resta cifrato;
    // gli adapter ricevono il plaintext. No-op per literal/vault:/managed.
    database = { ...database, connection: unsealConnectionSecrets(database.connection, database.tenantId) };

    // Anti-SSRF: una connessione ESTERNA non può puntare a un IP privato/riservato
    // (pivot rete interna). managed/embedded sono esenti (host interno/file locale).
    await assertExternalHostAllowed(database.connection);

    let adapter: IDatabaseAdapter;
    let databaseForConnect = database;

    switch (database.connection.engine) {
      case 'sqlite': {
        adapter = new SqliteAdapter();
        const config = loadConfig();
        const dbDir = join(config.MEDEA_DATA_DIR, 'user-databases');
        if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
        const dbPath = database.connection.embedded
          ? join(dbDir, `${database.id}.sqlite`)
          : database.connection.url ?? join(dbDir, `${database.id}.sqlite`);
        databaseForConnect = {
          ...database,
          connection: { ...database.connection, url: dbPath },
        };
        break;
      }
      case 'postgres':
        adapter = new PostgresAdapter();
        break;
      case 'mysql':
        adapter = new MysqlAdapter();
        break;
      case 'mongodb':
        adapter = new MongoDbAdapter();
        break;
      case 'redis':
        adapter = new RedisAdapter();
        break;
      case 'mssql':
        adapter = new MssqlAdapter();
        break;
      case 'duckdb': {
        // DuckDB è EMBEDDED in-process (come SQLite): persiste su un file dentro
        // il volume /data del tenant (quota'd). Senza path → DuckDBInstance apre
        // :memory: e i dati SPARISCONO al riavvio. Path = data/user-databases/<id>.duckdb.
        adapter = new DuckDbAdapter();
        const config = loadConfig();
        const dbDir = join(config.MEDEA_DATA_DIR, 'user-databases');
        if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
        const duckPath = database.connection.database && database.connection.database.trim() !== ''
          ? database.connection.database
          : join(dbDir, `${database.id}.duckdb`);
        databaseForConnect = {
          ...database,
          connection: { ...database.connection, database: duckPath },
        };
        break;
      }
      default:
        throw new Error(`Adapter for engine "${database.connection.engine}" not bundled in this runtime build.`);
    }

    // SSH TUNNEL (stile DBeaver): il DB è dietro un bastion. Apriamo il tunnel
    // (db-remote-ssh: host-key pinning + anti-rebinding sull'host SSH) e puntiamo
    // l'adapter al forward locale 127.0.0.1:<localPort>. Il tunnel resta aperto
    // per la sessione e viene chiuso alla eviction/disconnect dell'adapter.
    if (database.connection.sshTunnel) {
      const tunnel = await openDbStudioSshTunnel(database.connection);
      this.tunnels.set(database.id, tunnel);
      databaseForConnect = {
        ...databaseForConnect,
        connection: { ...databaseForConnect.connection, hostname: '127.0.0.1', port: tunnel.localPort, sshTunnel: undefined },
      };
    }

    try {
      await adapter.connect(databaseForConnect);
    } catch (err) {
      // Connessione fallita: chiudi il tunnel appena aperto (no leak).
      await this.closeTunnel(database.id);
      throw err;
    }
    this.adapters.set(database.id, adapter);
    return adapter;
  }

  /** Chiude e dimentica il tunnel SSH della connessione (se presente). Best-effort. */
  private async closeTunnel(databaseId: string): Promise<void> {
    const t = this.tunnels.get(databaseId);
    if (!t) return;
    this.tunnels.delete(databaseId);
    try { await t.close(); } catch { /* best-effort */ }
  }

  async previewMigration(id: string, actions: MigrationAction[], tenantId = 'default'): Promise<string> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    return adapter.previewMigration(actions);
  }

  async applyMigration(id: string, actions: MigrationAction[], tenantId = 'default'): Promise<{ sql: string; affectedTables: string[] }> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const result = await adapter.applyMigration(actions);
    logger.info({ databaseId: id, affectedTables: result.affectedTables }, 'Migration applied');

    // Sync the cached manifest (spec_json.tables) with the actual schema so the
    // UI sees the new/dropped tables without a manual refresh. Best-effort:
    // failure here doesn't roll back the migration (the data is already correct).
    try {
      const liveTables = await adapter.introspect();
      const { sqlite } = getDatabase();
      const updated = { ...database, tables: liveTables, updatedAt: new Date().toISOString() };
      sqlite
        .prepare('UPDATE db_studio_databases SET spec_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(JSON.stringify(updated), updated.updatedAt, id, tenantId);
    } catch (err) {
      logger.warn({ err, databaseId: id }, 'Manifest sync after migration failed (data is OK, UI may need refresh)');
    }

    return result;
  }

  async query(id: string, spec: QuerySpec, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    return adapter.query(spec);
  }

  /**
   * Una PAGINA di righe di una tabella (limit/offset). Usata sia per il pre-flight
   * dell'export (valida che tabella/connessione esistano PRIMA di iniziare lo stream
   * → status HTTP corretto, non un file troncato) sia come fetcher dello streaming.
   * Read-only: ok anche su DB esterni read-only.
   */
  async fetchTablePage(
    id: string,
    table: string,
    limit: number,
    offset: number,
    tenantId = 'default',
  ): Promise<Record<string, unknown>[]> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const res = (await adapter.query({ table, filters: [], orderBy: [], limit, offset })) as {
      rows?: Record<string, unknown>[];
    };
    return res.rows ?? [];
  }

  /**
   * EXPORT a MEMORIA LIMITATA: pagina la tabella e invoca `onPage(rows)` per ogni
   * blocco (il chiamante lo scrive sullo stream e lo scarta) → mai l'intera tabella
   * in RAM. Senza questo l'export di una tabella grande del CRM saturava l'heap del
   * container (OOM crash, bug 2026-06-16). Ritorna conteggio righe + `truncated`.
   */
  async streamTableRows(
    id: string,
    table: string,
    onPage: (rows: readonly Record<string, unknown>[]) => void | Promise<void>,
    tenantId = 'default',
    opts: { maxRows?: number; pageSize?: number } = {},
  ): Promise<{ rows: number; truncated: boolean }> {
    return paginatePages(
      (limit, offset) => this.fetchTablePage(id, table, limit, offset, tenantId),
      onPage,
      opts,
    );
  }

  /**
   * Conta le righe totali di una tabella (per la paginazione: "pagina X di Y").
   * SELECT COUNT(*) via executeRaw read-only. Il nome tabella è quotato col
   * dialetto giusto + escape (anti-injection). Engine senza raw SQL → lancia.
   */
  async countRows(id: string, table: string, tenantId = 'default'): Promise<number> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const quoted = quoteTableForEngine(database.connection.engine, table);
    const result = await this.executeRaw(id, `SELECT COUNT(*) AS c FROM ${quoted}`, { rowLimit: 1 }, tenantId) as {
      rows?: Record<string, unknown>[];
      statementResults?: { rows?: Record<string, unknown>[] }[];
    };
    const rows = result.rows ?? result.statementResults?.[0]?.rows ?? [];
    const first = rows[0] ?? {};
    const raw = first.c ?? first.count ?? Object.values(first)[0];
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async executeRaw(id: string, sql: string, opts: { dryRun?: boolean; rowLimit?: number }, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    if (!adapter.executeRaw) {
      const err = new Error(`Raw SQL not supported for engine '${database.connection.engine}'`);
      (err as Error & { code?: string }).code = 'RAW_SQL_UNSUPPORTED';
      throw err;
    }
    const result = await adapter.executeRaw(sql, opts);

    // If this batch contained any DDL/write (not just SELECT/EXPLAIN) AND
    // it wasn't a dry-run, re-introspect and persist the new schema into
    // db_studio_databases.spec_json so the UI sidebar sees the new tables
    // immediately. Without this, the SQL editor creates tables that exist
    // in the file but are invisible everywhere else in DB Studio.
    //
    // Same pattern as `applyMigration` above — best-effort, non-fatal.
    const r = result as {
      rolledBack?: boolean;
      statementKind?: string;
      statementResults?: { kind: string }[];
    };
    const wroteSomething = !r.rolledBack && (
      r.statementResults
        ? r.statementResults.some((s) => s.kind !== 'select' && s.kind !== 'explain')
        : (r.statementKind !== 'select' && r.statementKind !== 'explain' && r.statementKind !== undefined)
    );
    if (wroteSomething) {
      try {
        const liveTables = await adapter.introspect();
        const { sqlite } = getDatabase();
        const updated = { ...database, tables: liveTables, updatedAt: new Date().toISOString() };
        sqlite
          .prepare('UPDATE db_studio_databases SET spec_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run(JSON.stringify(updated), updated.updatedAt, id, tenantId);
      } catch (err) {
        logger.warn({ err, databaseId: id }, 'Manifest sync after executeRaw failed (data is OK, UI may need refresh)');
      }
    }

    return result;
  }

  async insert(id: string, table: string, row: Record<string, unknown>, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const result = await adapter.insert(table, row);
    appendChangeLog(tenantId, id, table, 'insert', { row, result });
    return result;
  }

  /**
   * Atomic multi-op batch. Used by `db_insert_batch` workflow node for
   * header+children inserts (orders/order_lines, invoices/invoice_lines, ...).
   * Rolls back the entire transaction on any failure.
   */
  async transaction(id: string, ops: BatchOp[], tenantId = 'default'): Promise<BatchResult> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    if (typeof adapter.transaction !== 'function') {
      throw Object.assign(new Error(`Engine "${adapter.engine}" does not support atomic batch transactions yet.`), { code: 'BATCH_UNSUPPORTED' });
    }
    const result = await adapter.transaction(ops);
    // One change-log entry per op so the changes-since feed surfaces them.
    for (const step of result.steps) {
      const op = ops[step.index];
      if (!op) continue;
      appendChangeLog(tenantId, id, op.table, 'insert', { batchIndex: step.index, kind: op.kind, affectedRows: step.affectedRows });
    }
    return result;
  }

  async updateRow(id: string, table: string, where: Record<string, unknown>, patch: Record<string, unknown>, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const result = await adapter.update(table, where, patch);
    appendChangeLog(tenantId, id, table, 'update', { where, patch, result });
    return result;
  }

  async deleteRow(id: string, table: string, where: Record<string, unknown>, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const result = await adapter.delete(table, where);
    appendChangeLog(tenantId, id, table, 'delete', { where, result });
    return result;
  }

  getChangesSince(
    tenantId: string,
    databaseId: string,
    tableName: string,
    sinceId: number,
    limit = 100,
  ): { id: number; op: string; payload: unknown; createdAt: string }[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT id, op, payload_json, created_at FROM db_change_log WHERE tenant_id = ? AND database_id = ? AND table_name = ? AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(tenantId, databaseId, tableName, sinceId, limit) as {
        id: number;
        op: string;
        payload_json: string;
        created_at: string;
      }[];
    return rows.map((r) => ({
      id: r.id,
      op: r.op,
      payload: JSON.parse(r.payload_json) as unknown,
      createdAt: r.created_at,
    }));
  }

  async introspect(id: string, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    const tables = await adapter.introspect();
    // Persisti le tabelle in spec_json → la sidebar/lista (DatabaseList) mostra il
    // count corretto anche per i DB ESTERNI, le cui tabelle non passano da
    // applyMigration. Best-effort: un errore qui non fa fallire l'introspect.
    try {
      const { sqlite } = getDatabase();
      const updated = { ...database, tables, updatedAt: new Date().toISOString() };
      sqlite
        .prepare('UPDATE db_studio_databases SET spec_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(JSON.stringify(updated), updated.updatedAt, id, tenantId);
    } catch (err) {
      logger.warn({ err, databaseId: id }, 'Persist introspected tables failed (UI may show stale table count)');
    }
    return tables;
  }

  /**
   * Foreign key REALI del DB (per l'ER diagram). Tenant-scoped. Engine senza
   * supporto (Mongo/Redis/Vector) → [] (nessun concetto di FK relazionale).
   */
  async introspectRelations(id: string, tenantId = 'default'): Promise<unknown> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);
    const adapter = await this.getAdapter(database);
    return adapter.introspectRelations ? adapter.introspectRelations() : [];
  }

  /**
   * Analisi pre-truncate FK-aware, CROSS-DIALECT (fix 2026-06-15).
   *
   * Prima viveva nella route con PRAGMA foreign_key_list + sqlite_master →
   * SQLite-ONLY: per i sidecar managed Postgres/MySQL il preview dell'impatto
   * FK NON funzionava (l'utente truncava alla cieca). Ora usa i mattoni
   * già cross-dialect: `countRows` (quota col dialetto giusto) + i FK REALI da
   * `introspectRelations` (implementata per ogni adapter relazionale).
   *
   *   - references:   FK in USCITA da questa tabella (questa → altre)
   *   - referencedBy: FK in ENTRATA (altre → questa) ⇒ svuotando, le INSERT
   *                   future su QUELLE falliranno se il valore non esiste qui.
   *
   * Engine senza FK relazionali (Mongo/Redis/Vector) o senza raw SQL → liste
   * vuote + rowCount best-effort 0, senza lanciare.
   */
  async truncatePreview(id: string, tableName: string, tenantId = 'default'): Promise<{
    table: string;
    rowCount: number;
    references: { targetTable: string; column: string; targetColumn: string; onDelete: string }[];
    referencedBy: { sourceTable: string; sourceColumn: string; targetColumn: string; onDelete: string }[];
  }> {
    const database = this.get(id, tenantId);
    if (!database) throw new Error(`Database ${id} not found`);

    let rowCount = 0;
    try { rowCount = await this.countRows(id, tableName, tenantId); } catch { rowCount = 0; }

    const rels = (await this.introspectRelations(id, tenantId)) as {
      fromTable: string; fromColumn: string; toTable: string; toColumn: string; onDelete?: string;
    }[];
    const references = rels
      .filter((r) => r.fromTable === tableName)
      .map((r) => ({ targetTable: r.toTable, column: r.fromColumn, targetColumn: r.toColumn, onDelete: r.onDelete ?? 'NO ACTION' }));
    const referencedBy = rels
      .filter((r) => r.toTable === tableName)
      .map((r) => ({ sourceTable: r.fromTable, sourceColumn: r.fromColumn, targetColumn: r.toColumn, onDelete: r.onDelete ?? 'NO ACTION' }));

    return { table: tableName, rowCount, references, referencedBy };
  }

  /**
   * Test di una connessione PRIMA del salvataggio: costruisce un adapter
   * effimero (id temporaneo, non cache-condiviso col DB reale), prova a
   * connettersi + introspect leggero, poi disconnette. Non persiste nulla.
   * Ritorna { ok } o { ok:false, error } — non lancia.
   */
  async testConnection(connection: Database['connection'], tenantId = 'default'): Promise<{ ok: boolean; error?: string }> {
    const now = new Date().toISOString();
    const temp: Database = {
      id: `__test__${nanoid()}`, tenantId, name: '__test__', connection,
      tables: [], relations: [], createdAt: now, updatedAt: now,
    };
    try {
      const adapter = await this.getAdapter(temp);
      await adapter.introspect(); // tocca davvero la connessione
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      const a = this.adapters.get(temp.id);
      if (a) { try { await a.disconnect(); } catch { /* best-effort */ } }
      this.adapters.delete(temp.id);
      await this.closeTunnel(temp.id); // chiude il tunnel SSH effimero del test
    }
  }
}
