/**
 * Domain — Reports.
 *
 * DTO immutabili per il risultato di un'esecuzione di regola (singola) o
 * di un ciclo completo (tutte le regole abilitate). Persistiti in
 * `janitor_run_log` e ritornati dall'admin API.
 */

import type { CorruptionSeverity } from './severity.js';
import type { DataSourceRef } from './data-source-ref.js';

export interface JanitorRuleReport {
  readonly cycleId: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly dataSourceRef: DataSourceRef;
  readonly targetTable: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly rowsDetected: number;
  readonly rowsRepaired: number;
  readonly rowsQuarantined: number;
  readonly rowsSkipped: number;
  readonly bySeverity: Readonly<Record<CorruptionSeverity, number>>;
  readonly dryRun: boolean;
  readonly success: boolean;
  readonly error?: string;
  readonly triggeredBy: string;
}

export interface JanitorCycleReport {
  readonly cycleId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly triggeredBy: string;
  readonly dryRun: boolean;
  readonly rules: readonly JanitorRuleReport[];
  readonly rulesExecuted: number;
  readonly rulesSkippedLock: number;
  readonly rulesSkippedDisabled: number;
}

export function emptyBySeverity(): Readonly<Record<CorruptionSeverity, number>> {
  return Object.freeze({ critical: 0, warning: 0 });
}

export function aggregateBySeverity(
  rows: readonly { severity: CorruptionSeverity }[],
): Readonly<Record<CorruptionSeverity, number>> {
  const out: Record<CorruptionSeverity, number> = { critical: 0, warning: 0 };
  for (const r of rows) out[r.severity] += 1;
  return Object.freeze(out);
}
