/**
 * Domain — QuarantineRecord.
 *
 * DTO immutabile per una riga in `quarantined_rows`. Il `rawJson` è
 * la stringa serializzata della riga originale; la deserializzazione
 * lazy avviene SOLO al momento del restore (no overhead in list).
 */

import type { CorruptionSeverity } from './severity.js';
import type { DataSourceRef } from './data-source-ref.js';

export interface QuarantineRecord {
  readonly id: number;
  readonly originalId: string;
  readonly originalTable: string;
  readonly tenantId: string | null;
  readonly dataSourceRef: DataSourceRef;
  readonly quarantinedAt: string;
  readonly quarantinedBy: string;
  readonly ruleId: string;
  readonly severity: CorruptionSeverity;
  readonly reason: string;
  readonly rawJson: string;
}

export interface QuarantineListFilter {
  readonly table?: string;
  readonly tenantId?: string;
  readonly ruleId?: string;
  readonly severity?: CorruptionSeverity;
  readonly dataSourceRef?: DataSourceRef;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface QuarantineStats {
  readonly total: number;
  readonly byTable: Readonly<Record<string, number>>;
  readonly byRule: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<CorruptionSeverity, number>>;
}
