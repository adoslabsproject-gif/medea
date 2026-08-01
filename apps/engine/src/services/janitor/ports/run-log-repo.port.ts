/**
 * Port — IRunLogRepository.
 *
 * Persistenza degli esiti di esecuzione (`janitor_run_log`). Append-only.
 * Query per UI history + analytics.
 */

import type { JanitorRuleReport, JanitorCycleReport } from '@/services/janitor/domain/index.js';

export interface RunLogQuery {
  readonly tenantId?: string;
  readonly ruleId?: string;
  readonly successOnly?: boolean;
  readonly dryRunOnly?: boolean;
  readonly fromIso?: string;
  readonly toIso?: string;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface IRunLogRepository {
  appendRule(report: JanitorRuleReport): Promise<void>;
  appendCycle(report: JanitorCycleReport): Promise<void>;
  listRuleReports(q: RunLogQuery): Promise<readonly JanitorRuleReport[]>;
  /** Aggregati last 30 days, group by ruleId. */
  trendBuckets(args: {
    tenantId?: string;
    daysBack: number;
  }): Promise<readonly DailyBucket[]>;
  /** Ultima invocazione per ruleId (cards UI). */
  lastByRule(tenantId: string): Promise<Readonly<Record<string, JanitorRuleReport>>>;
}

export interface DailyBucket {
  readonly dateIso: string;
  readonly ruleId: string;
  readonly rowsQuarantined: number;
  readonly rowsRepaired: number;
  readonly errors: number;
}
