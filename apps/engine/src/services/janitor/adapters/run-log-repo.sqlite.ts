/**
 * Adapter — RunLogRepository sopra Drizzle / system SQLite.
 *
 * Tabella `janitor_run_log` append-only. Le query di analytics (trend
 * daily / lastByRule) usano executeRaw via sqlite handle perché Drizzle
 * SQLite non ha sintassi nativa per GROUP BY date_trunc.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { janitorRunLog, type JanitorRunLogRow } from '@/storage/schema.js';
import type { IRunLogRepository, RunLogQuery, DailyBucket } from '@/services/janitor/ports/index.js';
import type {
  JanitorRuleReport, JanitorCycleReport, DataSourceRef,
} from '@/services/janitor/domain/index.js';

export class SqliteRunLogRepository implements IRunLogRepository {
  async appendRule(report: JanitorRuleReport): Promise<void> {
    const { db } = getDatabase();
    await db.insert(janitorRunLog).values({
      cycleId: report.cycleId,
      ruleId: report.ruleId,
      tenantId: report.tenantId,
      dataSourceRef: report.dataSourceRef,
      targetTable: report.targetTable,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      durationMs: report.durationMs,
      rowsDetected: report.rowsDetected,
      rowsRepaired: report.rowsRepaired,
      rowsQuarantined: report.rowsQuarantined,
      rowsSkipped: report.rowsSkipped,
      criticalCount: report.bySeverity.critical,
      warningCount: report.bySeverity.warning,
      dryRun: report.dryRun,
      success: report.success,
      errorMessage: report.error ?? null,
      triggeredBy: report.triggeredBy,
    });
  }

  async appendCycle(_report: JanitorCycleReport): Promise<void> {
    // Le rule reports sono già appese una per una via `appendRule()`;
    // il cycle aggregato non ha una tabella dedicata — la UI lo
    // ricostruisce on-demand via GROUP BY cycle_id sul `janitor_run_log`.
    //
    // Questo metodo esiste per simmetria di interfaccia e per future
    // estensioni (es. retention policy distinta cycle vs rule).
    return Promise.resolve();
  }

  async listRuleReports(q: RunLogQuery): Promise<readonly JanitorRuleReport[]> {
    const { db } = getDatabase();
    const wheres = [];
    if (q.tenantId) wheres.push(eq(janitorRunLog.tenantId, q.tenantId));
    if (q.ruleId) wheres.push(eq(janitorRunLog.ruleId, q.ruleId));
    if (q.successOnly) wheres.push(eq(janitorRunLog.success, true));
    if (q.dryRunOnly) wheres.push(eq(janitorRunLog.dryRun, true));
    if (q.fromIso) wheres.push(gte(janitorRunLog.startedAt, q.fromIso));
    if (q.toIso) wheres.push(lte(janitorRunLog.startedAt, q.toIso));
    const limit = Math.min(q.limit ?? 100, 500);

    const baseQuery = db.select().from(janitorRunLog);
    const filtered = wheres.length > 0 ? baseQuery.where(and(...wheres)) : baseQuery;
    const rows = await filtered.orderBy(desc(janitorRunLog.id)).limit(limit);
    return rows.map(rowToReport);
  }

  trendBuckets(args: { tenantId?: string; daysBack: number }): Promise<readonly DailyBucket[]> {
    const { db } = getDatabase();
    const fromIso = new Date(Date.now() - args.daysBack * 86400_000).toISOString();
    const tenantClause = args.tenantId
      ? sql`AND tenant_id = ${args.tenantId}`
      : sql``;
    const result = db.all<{ date_iso: string; rule_id: string; rows_quarantined: number; rows_repaired: number; errors: number }>(sql`
      SELECT
        substr(started_at, 1, 10) AS date_iso,
        rule_id,
        SUM(rows_quarantined) AS rows_quarantined,
        SUM(rows_repaired)    AS rows_repaired,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
      FROM janitor_run_log
      WHERE started_at >= ${fromIso} ${tenantClause}
      GROUP BY substr(started_at, 1, 10), rule_id
      ORDER BY date_iso ASC, rule_id ASC
    `);
    return Promise.resolve(result.map((r) => ({
      dateIso: r.date_iso,
      ruleId: r.rule_id,
      rowsQuarantined: Number(r.rows_quarantined),
      rowsRepaired: Number(r.rows_repaired),
      errors: Number(r.errors),
    })));
  }

  lastByRule(tenantId: string): Promise<Readonly<Record<string, JanitorRuleReport>>> {
    const { db } = getDatabase();
    // Subquery: per ogni rule_id, max(id). Poi join per recuperare il record.
    // sql.raw() ritorna colonne snake_case → mapping esplicito a camelCase.
    const rows = db.all<Record<string, unknown>>(sql`
      SELECT * FROM janitor_run_log
      WHERE tenant_id = ${tenantId}
        AND id IN (
          SELECT MAX(id) FROM janitor_run_log
          WHERE tenant_id = ${tenantId}
          GROUP BY rule_id
        )
    `);
    const out: Record<string, JanitorRuleReport> = {};
    for (const raw of rows) {
      const r = mapSnakeRow(raw);
      out[r.ruleId] = rowToReport(r);
    }
    return Promise.resolve(out);
  }
}

/**
 * Mappa una riga raw (sql.raw → colonne snake_case) a JanitorRunLogRow camelCase.
 * Usato SOLO dai metodi che bypassano Drizzle ORM (sql.raw + db.all).
 */
function mapSnakeRow(raw: Record<string, unknown>): JanitorRunLogRow {
  return {
    id: raw.id as number,
    cycleId: raw.cycle_id as string,
    ruleId: raw.rule_id as string,
    tenantId: raw.tenant_id as string,
    dataSourceRef: raw.data_source_ref as string,
    targetTable: raw.target_table as string,
    startedAt: raw.started_at as string,
    endedAt: raw.ended_at as string,
    durationMs: raw.duration_ms as number,
    rowsDetected: raw.rows_detected as number,
    rowsRepaired: raw.rows_repaired as number,
    rowsQuarantined: raw.rows_quarantined as number,
    rowsSkipped: raw.rows_skipped as number,
    criticalCount: raw.critical_count as number,
    warningCount: raw.warning_count as number,
    dryRun: Boolean(raw.dry_run),
    success: Boolean(raw.success),
    errorMessage: (raw.error_message as string | null) ?? null,
    triggeredBy: raw.triggered_by as string,
  };
}

function rowToReport(row: JanitorRunLogRow): JanitorRuleReport {
  const out: JanitorRuleReport = {
    cycleId: row.cycleId,
    ruleId: row.ruleId,
    tenantId: row.tenantId,
    dataSourceRef: row.dataSourceRef as DataSourceRef,
    targetTable: row.targetTable,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    rowsDetected: row.rowsDetected,
    rowsRepaired: row.rowsRepaired,
    rowsQuarantined: row.rowsQuarantined,
    rowsSkipped: row.rowsSkipped,
    bySeverity: {
      critical: row.criticalCount,
      warning: row.warningCount,
    },
    dryRun: row.dryRun,
    success: row.success,
    triggeredBy: row.triggeredBy,
    ...(row.errorMessage ? { error: row.errorMessage } : {}),
  };
  return Object.freeze(out);
}
