/**
 * Port — IQuarantineGateway.
 *
 * Astrae le operazioni di quarantine sul data source target.
 * L'implementazione concreta usa `IDatabaseAdapter` per essere
 * portabile su SQLite/Postgres/MySQL/MSSQL/DuckDB.
 *
 * Idempotenza:
 *   • `ensureSchema()` chiamato al boot — crea tabella
 *     `quarantined_rows` se manca, no-op se già presente.
 *   • `quarantineRow()` è transazionale per riga; se la live row
 *     è già stata cancellata da un altro processo, l'INSERT in
 *     quarantine procede comunque (audit trail).
 */

import type {
  DetectedRow, DataSourceRef, QuarantineRecord,
  QuarantineListFilter, QuarantineStats,
} from '@/services/janitor/domain/index.js';

export interface QuarantineRequest {
  readonly originalTable: string;
  readonly pkColumn: string;
  readonly row: DetectedRow;
  readonly ruleId: string;
  readonly dataSourceRef: DataSourceRef;
  readonly triggeredBy: string;
}

export interface IQuarantineGateway {
  ensureSchema(dataSourceRef: DataSourceRef): Promise<void>;
  quarantineRow(req: QuarantineRequest): Promise<void>;
  list(filter: QuarantineListFilter): Promise<readonly QuarantineRecord[]>;
  stats(dataSourceRef?: DataSourceRef): Promise<QuarantineStats>;
  /** Ripristina la riga nella tabella live. Throw su FK conflict / PK conflict. */
  restore(quarantineId: number, dataSourceRef: DataSourceRef): Promise<void>;
  /** Hard-delete. Il caller DEVE avere già loggato il payload in audit_log. */
  purge(quarantineId: number, dataSourceRef: DataSourceRef): Promise<void>;
}
