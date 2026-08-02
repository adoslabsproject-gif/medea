/**
 * Adapter — QuarantineGatewayAdapter.
 *
 * Implementazione cross-DB della quarantine tramite `IDatabaseAdapter`.
 * Funziona su tutti i SQL engine (SQLite, Postgres, MySQL, MSSQL, DuckDB,
 * pgvector). Mongo/Redis/qdrant/vector-embedded → lanciano errore esplicito
 * al `ensureSchema()` (queste engine richiedono schema diversi non SQL —
 * fase 2 con plugin dedicato; per ora UI mostra "non supportato").
 *
 * Schema generato (compatibile cross-DB grazie a `applyMigration`):
 *
 *   CREATE TABLE quarantined_rows (
 *     id INTEGER PRIMARY KEY AUTO_INCREMENT,   ← sintassi adapter-specific
 *     original_id      TEXT NOT NULL,
 *     original_table   TEXT NOT NULL,
 *     tenant_id        TEXT NULL,
 *     data_source_ref  TEXT NOT NULL,
 *     quarantined_at   TEXT NOT NULL,
 *     quarantined_by   TEXT NOT NULL,
 *     rule_id          TEXT NOT NULL,
 *     severity         TEXT NOT NULL,
 *     reason           TEXT NOT NULL,
 *     raw_json         TEXT NOT NULL
 *   );
 *   CREATE INDEX quarantined_rows_table_idx ON quarantined_rows(original_table);
 *   CREATE INDEX quarantined_rows_rule_idx ON quarantined_rows(rule_id);
 *   CREATE INDEX quarantined_rows_severity_idx ON quarantined_rows(severity);
 *
 * Transazionalità:
 *   • `quarantineRow()` usa `adapter.transaction([insert, delete])` quando
 *     l'adapter lo supporta. Fallback: due statement sequenziali con il
 *     compromesso che un crash dopo l'INSERT lascia la riga sia in quar
 *     che in live (idempotent restore previene danno).
 *   • `restore()` è inverse: insert in live, delete da quar.
 *   • `purge()` è semplice DELETE.
 */

import { logger } from '@/lib/logger.js';
import type {
  DataSourceRef,
  QuarantineRecord,
  QuarantineListFilter,
  QuarantineStats,
  CorruptionSeverity,
} from '@/services/janitor/domain/index.js';
import type {
  IQuarantineGateway,
  QuarantineRequest,
  IDataSourceResolver,
} from '@/services/janitor/ports/index.js';
import type { IDatabaseAdapter } from '@medea/engine-db-studio-engine';

const QUARANTINE_TABLE = 'quarantined_rows';
const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

interface QuarantineRawRow {
  id: number;
  original_id: string;
  original_table: string;
  tenant_id: string | null;
  data_source_ref: string;
  quarantined_at: string;
  quarantined_by: string;
  rule_id: string;
  severity: string;
  reason: string;
  raw_json: string;
}

export class QuarantineGatewayAdapter implements IQuarantineGateway {
  /** Tracking degli schemi già creati per data source (evita re-create). */
  private readonly schemaEnsured = new Set<DataSourceRef>();

  constructor(private readonly resolver: IDataSourceResolver) {}

  async ensureSchema(dataSourceRef: DataSourceRef): Promise<void> {
    if (this.schemaEnsured.has(dataSourceRef)) return;
    const adapter = await this.resolver.resolve(dataSourceRef);
    if (!this.supportsSqlQuarantine(adapter)) {
      throw new Error(
        `QuarantineGateway: engine "${adapter.engine}" non supporta SQL → ` +
          `quarantine richiede un plugin dedicato. Fase 2.`,
      );
    }
    // Verifica se la tabella esiste già — fa una SELECT con LIMIT 0.
    // Se errore → CREATE. Se ok → segna ensured.
    try {
      await adapter.query({
        table: QUARANTINE_TABLE,
        filters: [],
        orderBy: [],
        limit: 1,
      });
      // Esiste già — niente da fare.
      this.schemaEnsured.add(dataSourceRef);
      logger.debug({ dataSourceRef }, 'Quarantine schema already present');
      return;
    } catch {
      // Tabella non esiste — proseguo a CREATE
    }
    await this.createSchema(adapter);
    this.schemaEnsured.add(dataSourceRef);
    logger.info({ dataSourceRef, engine: adapter.engine }, 'Quarantine schema created');
  }

  async quarantineRow(req: QuarantineRequest): Promise<void> {
    assertSafeIdentifier(req.originalTable);
    assertSafeIdentifier(req.pkColumn);
    await this.ensureSchema(req.dataSourceRef);
    const adapter = await this.resolver.resolve(req.dataSourceRef);

    const quarantineRow: Record<string, unknown> = {
      original_id: req.row.id,
      original_table: req.originalTable,
      tenant_id: req.row.tenantId ?? null,
      data_source_ref: req.dataSourceRef,
      quarantined_at: new Date().toISOString(),
      quarantined_by: req.triggeredBy,
      rule_id: req.ruleId,
      severity: req.row.severity,
      reason: req.row.reason,
      raw_json: JSON.stringify(req.row.raw),
    };

    // L'API pubblica di IDatabaseAdapter ha transaction() limitata a
    // insert/insertMany (per insert padre+figli atomici). DELETE non vi
    // partecipa. Strategia idempotente:
    //   1. INSERT in quarantine. Se già esiste per UNIQUE (data_source_ref,
    //      original_table, original_id) → la rule ha già catturato questa
    //      riga in un run precedente, NON ri-quarantinare ma procedi al
    //      DELETE per allinearsi (la live potrebbe essere ricomparsa).
    //   2. DELETE dalla live.
    //
    // Crash window: se INSERT riesce ma DELETE fallisce → la live ha
    // ancora la riga. La rule la rilegge alla prossima run, ma l'INSERT
    // skippa per unique constraint → DELETE riprova. Idempotenza
    // garantita senza transazione cross-table.
    try {
      await adapter.insert(QUARANTINE_TABLE, quarantineRow);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isUniqueConflict =
        msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint');
      if (!isUniqueConflict) throw err;
      logger.debug(
        { ruleId: req.ruleId, originalId: req.row.id },
        'Quarantine already present, proceeding to delete',
      );
    }
    await adapter.delete(req.originalTable, { [req.pkColumn]: req.row.id });
  }

  async list(filter: QuarantineListFilter): Promise<readonly QuarantineRecord[]> {
    const ref = filter.dataSourceRef;
    if (!ref) {
      // Quando il caller non specifica la datasource, listiamo sul system DB
      // — questa è la home page del Janitor (le altre datasource non hanno
      // ancora la propria UI list dedicata). Federico-grade: facciamo
      // un'azione coerente, non un cross-DB scan invisibile all'utente.
      return this.listOnRef('system' as DataSourceRef, filter);
    }
    return this.listOnRef(ref, filter);
  }

  async stats(dataSourceRef?: DataSourceRef): Promise<QuarantineStats> {
    const ref = dataSourceRef ?? ('system' as DataSourceRef);
    const adapter = await this.resolver.resolve(ref);
    if (!this.supportsSqlQuarantine(adapter)) {
      return { total: 0, byTable: {}, byRule: {}, bySeverity: { critical: 0, warning: 0 } };
    }
    await this.ensureSchema(ref);

    if (typeof adapter.executeRaw !== 'function') {
      throw new Error(`Adapter ${adapter.engine} non supporta executeRaw — stats impossibili`);
    }

    const total = await this.scalarCount(adapter, `SELECT COUNT(*) AS c FROM ${QUARANTINE_TABLE}`);
    const byTableRaw = await adapter.executeRaw(
      `SELECT original_table AS k, COUNT(*) AS c FROM ${QUARANTINE_TABLE} GROUP BY original_table`,
    );
    const byRuleRaw = await adapter.executeRaw(
      `SELECT rule_id AS k, COUNT(*) AS c FROM ${QUARANTINE_TABLE} GROUP BY rule_id`,
    );
    const bySeverityRaw = await adapter.executeRaw(
      `SELECT severity AS k, COUNT(*) AS c FROM ${QUARANTINE_TABLE} GROUP BY severity`,
    );

    const byTable: Record<string, number> = {};
    for (const r of byTableRaw.rows as { k: string; c: number }[]) byTable[r.k] = Number(r.c);
    const byRule: Record<string, number> = {};
    for (const r of byRuleRaw.rows as { k: string; c: number }[]) byRule[r.k] = Number(r.c);
    const bySeverity: Record<CorruptionSeverity, number> = { critical: 0, warning: 0 };
    for (const r of bySeverityRaw.rows as { k: string; c: number }[]) {
      if (r.k === 'critical' || r.k === 'warning') bySeverity[r.k] = Number(r.c);
    }
    return { total, byTable, byRule, bySeverity };
  }

  async restore(quarantineId: number, dataSourceRef: DataSourceRef): Promise<void> {
    const adapter = await this.resolver.resolve(dataSourceRef);
    if (!this.supportsSqlQuarantine(adapter)) {
      throw new Error(`Restore non supportato per engine ${adapter.engine}`);
    }
    const rows = await adapter.query<QuarantineRawRow>({
      table: QUARANTINE_TABLE,
      filters: [{ column: 'id', op: 'eq', value: quarantineId }],
      orderBy: [],
      limit: 1,
    });
    const row = rows.rows[0];
    if (!row) throw new Error(`Quarantine record ${quarantineId.toString()} non trovato`);

    const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
    assertSafeIdentifier(row.original_table);

    // Restore: simmetrico alla quarantine. INSERT prima (può fallire per
    // FK), DELETE dopo. Se INSERT fallisce → la quar resta intatta.
    try {
      await adapter.insert(row.original_table, raw);
    } catch (err) {
      throw new Error(
        `Restore impossibile: INSERT in "${row.original_table}" fallita. ` +
          `Probabile violazione FK o PK esistente. La riga resta in quarantine. ` +
          `Dettagli: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await adapter.delete(QUARANTINE_TABLE, { id: quarantineId });
    logger.info({ quarantineId, originalTable: row.original_table }, 'Quarantine row restored');
  }

  async purge(quarantineId: number, dataSourceRef: DataSourceRef): Promise<void> {
    const adapter = await this.resolver.resolve(dataSourceRef);
    if (!this.supportsSqlQuarantine(adapter)) {
      throw new Error(`Purge non supportato per engine ${adapter.engine}`);
    }
    const res = await adapter.delete(QUARANTINE_TABLE, { id: quarantineId });
    if (res.affectedRows === 0) {
      throw new Error(`Quarantine record ${quarantineId.toString()} non trovato`);
    }
    logger.info({ quarantineId, dataSourceRef }, 'Quarantine row purged');
  }

  // ────────────────────────────────────────────────────────────────────
  // private
  // ────────────────────────────────────────────────────────────────────

  private supportsSqlQuarantine(adapter: IDatabaseAdapter): boolean {
    return (
      adapter.engine === 'sqlite' ||
      adapter.engine === 'postgres' ||
      adapter.engine === 'mysql' ||
      adapter.engine === 'mssql' ||
      adapter.engine === 'duckdb' ||
      adapter.engine === 'pgvector'
    );
  }

  /**
   * Crea schema quarantine sul DB target tramite `applyMigration`.
   * applyMigration è cross-DB compatible — ogni adapter sa renderizzare
   * MigrationAction[] nel proprio dialetto.
   */
  private async createSchema(adapter: IDatabaseAdapter): Promise<void> {
    // Schema "naive but portable" generato via `applyMigration` — ogni
    // adapter sa renderlo nel proprio dialetto (SQLite INTEGER PK, Postgres
    // BIGSERIAL, MySQL INT AUTO_INCREMENT, MSSQL INT IDENTITY).
    const cols = (
      defs: { name: string; type: 'text' | 'bigint'; nullable: boolean; primaryKey?: boolean }[],
    ) =>
      defs.map((c) => ({
        id: `col_${c.name}`,
        name: c.name,
        type: c.type,
        constraints: {
          nullable: c.nullable,
          unique: false,
          primaryKey: c.primaryKey ?? false,
        },
      }));
    await adapter.applyMigration([
      {
        kind: 'create_table',
        table: {
          id: `tbl_${QUARANTINE_TABLE}`,
          name: QUARANTINE_TABLE,
          description: 'Janitor — righe corrotte spostate qui da una rule',
          columns: cols([
            { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
            { name: 'original_id', type: 'text', nullable: false },
            { name: 'original_table', type: 'text', nullable: false },
            { name: 'tenant_id', type: 'text', nullable: true },
            { name: 'data_source_ref', type: 'text', nullable: false },
            { name: 'quarantined_at', type: 'text', nullable: false },
            { name: 'quarantined_by', type: 'text', nullable: false },
            { name: 'rule_id', type: 'text', nullable: false },
            { name: 'severity', type: 'text', nullable: false },
            { name: 'reason', type: 'text', nullable: false },
            { name: 'raw_json', type: 'text', nullable: false },
          ]),
          indexes: [],
        },
      },
      {
        kind: 'add_index',
        tableName: QUARANTINE_TABLE,
        index: {
          id: 'idx_quar_table',
          name: 'quar_table_idx',
          columns: ['original_table'],
          unique: false,
        },
      },
      {
        kind: 'add_index',
        tableName: QUARANTINE_TABLE,
        index: { id: 'idx_quar_rule', name: 'quar_rule_idx', columns: ['rule_id'], unique: false },
      },
      {
        kind: 'add_index',
        tableName: QUARANTINE_TABLE,
        index: {
          id: 'idx_quar_severity',
          name: 'quar_severity_idx',
          columns: ['severity'],
          unique: false,
        },
      },
      {
        kind: 'add_index',
        tableName: QUARANTINE_TABLE,
        index: {
          id: 'idx_quar_tenant',
          name: 'quar_tenant_idx',
          columns: ['tenant_id'],
          unique: false,
        },
      },
      // UNIQUE su (data_source_ref, original_table, original_id) → due
      // esecuzioni della stessa rule sulla stessa riga non duplicano la
      // quarantena. Crash recovery affidabile.
      {
        kind: 'add_index',
        tableName: QUARANTINE_TABLE,
        index: {
          id: 'idx_quar_dedup',
          name: 'quar_dedup_idx',
          columns: ['data_source_ref', 'original_table', 'original_id'],
          unique: true,
        },
      },
    ]);
  }

  private async listOnRef(
    ref: DataSourceRef,
    filter: QuarantineListFilter,
  ): Promise<readonly QuarantineRecord[]> {
    const adapter = await this.resolver.resolve(ref);
    if (!this.supportsSqlQuarantine(adapter)) return [];
    await this.ensureSchema(ref);

    const filters: { column: string; op: 'eq' | 'lt'; value: unknown }[] = [];
    if (filter.table) filters.push({ column: 'original_table', op: 'eq', value: filter.table });
    if (filter.tenantId) filters.push({ column: 'tenant_id', op: 'eq', value: filter.tenantId });
    if (filter.ruleId) filters.push({ column: 'rule_id', op: 'eq', value: filter.ruleId });
    if (filter.severity) filters.push({ column: 'severity', op: 'eq', value: filter.severity });
    if (filter.cursor !== undefined) filters.push({ column: 'id', op: 'lt', value: filter.cursor });

    const limit = Math.min(filter.limit ?? 100, 500);
    const res = await adapter.query<QuarantineRawRow>({
      table: QUARANTINE_TABLE,
      filters,
      orderBy: [{ column: 'id', direction: 'desc' }],
      limit,
    });

    return res.rows.map(
      (r): QuarantineRecord => ({
        id: Number(r.id),
        originalId: r.original_id,
        originalTable: r.original_table,
        tenantId: r.tenant_id,
        dataSourceRef: r.data_source_ref as DataSourceRef,
        quarantinedAt: r.quarantined_at,
        quarantinedBy: r.quarantined_by,
        ruleId: r.rule_id,
        severity: r.severity as CorruptionSeverity,
        reason: r.reason,
        rawJson: r.raw_json,
      }),
    );
  }

  private async scalarCount(adapter: IDatabaseAdapter, sql: string): Promise<number> {
    if (typeof adapter.executeRaw !== 'function') return 0;
    const res = await adapter.executeRaw(sql);
    const row = res.rows[0] as { c: number | string } | undefined;
    return row ? Number(row.c) : 0;
  }
}

/**
 * Defense-in-depth: tutti i nomi di tabella/colonna che finiscono in
 * stringhe SQL passano da qui. I valori SQL parametrici NON serve
 * sanitizzare — il driver li tratta come bind values.
 */
function assertSafeIdentifier(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Identifier SQL non sicuro: ${name}`);
  }
}
