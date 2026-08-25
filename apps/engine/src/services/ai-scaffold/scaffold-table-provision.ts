/**
 * Self-heal del databaseId per il pre-create delle tabelle scaffold (import wizard).
 *
 * Lo scaffold LLM può mettere un `databaseId` FAKE (o riferire un DB che non
 * persiste) nei nodi db_* e in tablesToCreate → la creazione tabella fallisce
 * (flash giallo) e a runtime db_insert/db_query non trova il database. Queste pure
 * helper risolvono l'id contro i DB REALI del tenant e rimappano i nodi.
 *
 * PURE → testabili in isolamento (la route fa il wiring con DbStudio).
 */

export interface DbLike {
  id: string;
  connection?: { embedded?: boolean };
}

/**
 * I DB LOCALI scrivibili del tenant (embedded). Le tabelle di un workflow
 * generato dall'AI vanno SOLO qui — MAI in un DB ESTERNO connesso dal tenant
 * (es. un Postgres remoto come NHA, spesso read-only): scriverci farebbe fallire
 * la `CREATE TABLE` (tabella mai creata, flash che mente) o inquinerebbe un DB
 * altrui. Se non c'è nessun locale, il caller ne crea uno on-demand.
 *
 * Bug reale (2026-06-16): unico DB = NHA remoto read-only → il default
 * cadeva su NHA → CREATE TABLE falliva → `news_audit` mai creata.
 */
export function localWritableDbs(dbs: readonly DbLike[]): {
  ids: Set<string>;
  defaultId: string | undefined;
} {
  const local = dbs.filter((d) => d.connection?.embedded === true);
  return { ids: new Set(local.map((d) => d.id)), defaultId: local[0]?.id };
}

/**
 * Risolve il databaseId da usare per una tabella: l'id richiesto SE esiste tra i
 * DB reali del tenant; altrimenti il default. `undefined` se non c'è nulla.
 */
export function resolveDatabaseId(
  requested: string | undefined,
  validIds: ReadonlySet<string>,
  defaultDbId: string | undefined,
): string | undefined {
  if (requested && validIds.has(requested)) return requested;
  return defaultDbId;
}

/**
 * Rimappa `config.databaseId` dei nodi che puntano a un id non-valido → id reale.
 * Muta i nodi in-place. Ritorna quanti nodi ha corretto.
 */
export function remapNodeDatabaseIds(
  nodes: readonly unknown[],
  remap: ReadonlyMap<string, string>,
): number {
  if (remap.size === 0) return 0;
  let count = 0;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const cfg = (n as { config?: unknown }).config;
    if (!cfg || typeof cfg !== 'object') continue;
    const config = cfg as Record<string, unknown>;
    if (typeof config.databaseId === 'string') {
      const real = remap.get(config.databaseId);
      if (real !== undefined) {
        config.databaseId = real;
        count++;
      }
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning tabelle dichiarate (wizard scaffold + template gallery).
// Estratto da routes/workflows.ts (2026-07-06) per essere riusato dalla route
// /templates/:id/instantiate — prima i template NON creavano le tabelle
// dichiarate ("tabelle comprese" era falso per quel path).
// ─────────────────────────────────────────────────────────────────────────────

export interface DeclaredColumn {
  name: string;
  type: string;
  nullable?: boolean | undefined;
  unique?: boolean | undefined;
  primaryKey?: boolean | undefined;
}

export interface DeclaredTable {
  databaseId?: string | undefined;
  name: string;
  description?: string | undefined;
  columns: readonly DeclaredColumn[];
  /** Righe demo da inserire SOLO se la tabella è stata appena creata (mai su tabelle esistenti: non si tocca la roba del tenant). */
  seedRows?: readonly Record<string, unknown>[] | undefined;
}

export interface TableProvisionResult {
  tablesCreated: { name: string; ok: boolean; error?: string }[];
  /** id-non-valido (placeholder del template/scaffold) → id DB reale. */
  dbRemap: Map<string, string>;
  seededRows: number;
}

/** Sottoinsieme di DbStudioService usato dal provisioning (iniettabile nei test). */
export interface DbStudioLike {
  list(tenantId: string): DbLike[];
  create(input: {
    tenantId: string;
    name: string;
    description: string;
    connection: { engine: 'sqlite'; embedded: boolean };
    tables: never[];
    relations: never[];
  }): DbLike;
  applyMigration(dbId: string, actions: unknown[], tenantId: string): unknown;
  insert(dbId: string, table: string, row: Record<string, unknown>, tenantId: string): unknown;
}

export interface ProvisionLogger {
  info(ctx: Record<string, unknown>, msg: string): void;
  warn(ctx: Record<string, unknown>, msg: string): void;
}

/**
 * Crea le tabelle dichiarate nel DB locale scrivibile del tenant (creandone uno
 * SQLite on-demand se non esiste), con la stessa semantica best-effort del
 * wizard: tabella già esistente = ok idempotente (e seedRows SALTATE), errori
 * SQL veri loggati senza bloccare. Ritorna il remap placeholder→id reale da
 * passare a remapNodeDatabaseIds sui nodi.
 */
export async function provisionDeclaredTables(
  dbStudio: DbStudioLike,
  tenantId: string,
  tables: readonly DeclaredTable[],
  log: ProvisionLogger,
): Promise<TableProvisionResult> {
  const result: TableProvisionResult = { tablesCreated: [], dbRemap: new Map(), seededRows: 0 };
  if (tables.length === 0) return result;

  let validIds = new Set<string>();
  let defaultDbId: string | undefined;
  try {
    const local = localWritableDbs(dbStudio.list(tenantId));
    validIds = local.ids;
    defaultDbId = local.defaultId;
  } catch {
    /* ignore */
  }
  if (!defaultDbId) {
    try {
      const createdDb = dbStudio.create({
        tenantId,
        name: 'workflow_data',
        description: 'Database creato automaticamente per il workflow',
        connection: { engine: 'sqlite', embedded: true },
        tables: [],
        relations: [],
      });
      defaultDbId = createdDb.id;
      validIds.add(createdDb.id);
      log.info(
        { databaseId: createdDb.id, tenantId },
        '[table-provision] nessun DB nel tenant → creato workflow_data on-demand',
      );
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), tenantId },
        '[table-provision] create DB on-demand fallita',
      );
    }
  }

  for (const tbl of tables) {
    const requested = tbl.databaseId;
    const dbId = resolveDatabaseId(requested, validIds, defaultDbId);
    if (!dbId) {
      result.tablesCreated.push({
        name: tbl.name,
        ok: false,
        error: 'Nessun database disponibile e creazione on-demand fallita',
      });
      continue;
    }
    if (requested && requested !== dbId) result.dbRemap.set(requested, dbId);
    try {
      await dbStudio.applyMigration(
        dbId,
        [
          {
            kind: 'create_table',
            table: {
              id: tbl.name,
              name: tbl.name,
              columns: tbl.columns.map((c) => ({
                id: `${tbl.name}.${c.name}`,
                name: c.name,
                type: c.type as never,
                constraints: {
                  nullable: c.nullable !== false,
                  unique: c.unique === true,
                  primaryKey: c.primaryKey === true,
                },
              })),
              indexes: [],
            },
          },
        ],
        tenantId,
      );
      result.tablesCreated.push({ name: tbl.name, ok: true });
      log.info(
        { tableName: tbl.name, databaseId: dbId, columns: tbl.columns.length, tenantId },
        '[table-provision] table pre-created',
      );
      // Seed demo SOLO su tabella appena creata: mai inserire in tabelle
      // pre-esistenti del tenant (potrebbero contenere dati veri).
      for (const row of tbl.seedRows ?? []) {
        try {
          await dbStudio.insert(dbId, tbl.name, row, tenantId);
          result.seededRows += 1;
        } catch (e) {
          log.warn(
            { err: e instanceof Error ? e.message : String(e), tableName: tbl.name, tenantId },
            '[table-provision] seed row fallita',
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Tabella già esistente non è errore vero (idempotent semantic)
      const isDuplicate = /already exists|duplicate/i.test(msg);
      result.tablesCreated.push({
        name: tbl.name,
        ok: isDuplicate,
        ...(isDuplicate ? {} : { error: msg }),
      });
      if (!isDuplicate) {
        log.warn(
          { err: msg, tableName: tbl.name, tenantId },
          '[table-provision] table pre-create failed',
        );
      }
    }
  }
  return result;
}
