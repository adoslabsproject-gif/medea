/**
 * Domain — RuleConfig.
 *
 * Configurazione UI-driven di una regola. Persistita in
 * `janitor_rule_configs(rule_id, tenant_id, ...)`. La regola code-defined
 * fornisce i default, l'utente UI può overridare ogni campo.
 */

import type { DataSourceRef } from './data-source-ref.js';
import type { CorruptionSeverity } from './severity.js';

export interface RuleConfig {
  readonly ruleId: string;
  readonly tenantId: string;
  readonly enabled: boolean;
  readonly schedule: string; // cron expression
  readonly dataSourceRef: DataSourceRef; // può overridare defaultDataSource
  readonly maxRowsPerRun: number;
  readonly severity: CorruptionSeverity;
  readonly params: Readonly<Record<string, unknown>>;
  /** Se true: su detection critica invia una notifica in-app agli owner del workspace. */
  readonly notifyOnDetection: boolean;
  readonly updatedAt: string;
  readonly updatedBy?: string;
}

/**
 * Patch parziale da applicare a una RuleConfig esistente.
 * Tutti i campi opzionali — solo i present vengono sovrascritti.
 */
export interface RuleConfigPatch {
  readonly enabled?: boolean;
  readonly schedule?: string;
  readonly dataSourceRef?: DataSourceRef;
  readonly maxRowsPerRun?: number;
  readonly severity?: CorruptionSeverity;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly notifyOnDetection?: boolean;
}

/**
 * Costruisce una RuleConfig di default partendo dai default della regola.
 * Usato la PRIMA volta che un tenant interagisce con una regola — viene
 * salvato il default + diventa l'oggetto editabile.
 */
export function makeDefaultRuleConfig(args: {
  ruleId: string;
  tenantId: string;
  defaultSchedule: string;
  defaultDataSource: DataSourceRef;
  defaultMaxRowsPerRun: number;
  defaultSeverity: CorruptionSeverity;
  defaultParams: Readonly<Record<string, unknown>>;
}): RuleConfig {
  return Object.freeze({
    ruleId: args.ruleId,
    tenantId: args.tenantId,
    enabled: true,
    schedule: args.defaultSchedule,
    dataSourceRef: args.defaultDataSource,
    maxRowsPerRun: args.defaultMaxRowsPerRun,
    severity: args.defaultSeverity,
    params: Object.freeze({ ...args.defaultParams }),
    notifyOnDetection: false,
    updatedAt: new Date().toISOString(),
  });
}
