/**
 * Use case — ExecuteRuleUseCase.
 *
 * Esegue UNA singola rule end-to-end:
 *   1. Acquisisce lock named per la rule (no concurrent run su stessa rule)
 *   2. Risolve data source + connetti adapter
 *   3. Garantisce schema quarantine sul data source
 *   4. detect() — read-only
 *   5. repair() opzionale
 *   6. quarantine() per le righe non riparate
 *   7. Append a janitor_run_log
 *   8. Notifica se severity critical + notifyOnDetection=true
 *   9. Rilascia lock
 *
 * Tutto idempotente. Il dry-run mode skippa 5/6/7 ma fa 1/2/3/4/8 (utile
 * per UI preview).
 */

import { nanoid } from 'nanoid';
import type { Logger } from 'pino';
import type {
  Rule, RuleConfig, JanitorRuleReport, JanitorContext, DetectedRow,
  CorruptionSeverity, DataSourceRef,
} from '@/services/janitor/domain/index.js';
import { aggregateBySeverity, emptyBySeverity, isCodeRule, validateParams } from '@/services/janitor/domain/index.js';
import type {
  IClock, ILockGateway, IDataSourceResolver, IQuarantineGateway,
  IRunLogRepository, IAuditEmitter, INotificationEmitter, IRuleConfigRepository,
} from '@/services/janitor/ports/index.js';

export interface ExecuteRuleInput {
  readonly rule: Rule;
  readonly tenantId: string;
  readonly triggeredBy: string;
  readonly dryRun: boolean;
  readonly cycleId?: string;
  /** Override params + maxRows (per dry-run preview con valori temporanei). */
  readonly overrides?: {
    readonly maxRowsPerRun?: number;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly dataSourceRef?: DataSourceRef;
  };
}

export interface ExecuteRuleOutput {
  readonly report: JanitorRuleReport;
  /** In dry-run mode: lista delle righe che SAREBBERO quarantinate. */
  readonly detected: readonly DetectedRow[];
}

const LOCK_TTL_MS = 5 * 60 * 1000;

export class ExecuteRuleUseCase {
  constructor(
    private readonly clock: IClock,
    private readonly locks: ILockGateway,
    private readonly resolver: IDataSourceResolver,
    private readonly quarantine: IQuarantineGateway,
    private readonly runLog: IRunLogRepository,
    private readonly audit: IAuditEmitter,
    private readonly notifications: INotificationEmitter,
    private readonly configRepo: IRuleConfigRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: ExecuteRuleInput): Promise<ExecuteRuleOutput> {
    const cycleId = input.cycleId ?? nanoid();
    const startedAt = this.clock.now();
    const holderId = `${process.pid.toString()}-${nanoid(6)}`;
    const ruleLogger = this.logger.child({
      ruleId: input.rule.id,
      cycleId,
      tenantId: input.tenantId,
      dryRun: input.dryRun,
    });

    // 1. Acquisisci lock — NB: il lock è named per `<ruleId>:<tenantId>` per
    //    permettere a tenant diversi di eseguire la stessa rule in parallelo.
    const lockKey = `${input.rule.id}:${input.tenantId}`;
    const acquired = this.locks.acquire(lockKey, holderId, LOCK_TTL_MS);
    if (!acquired) {
      ruleLogger.info('Skip: lock già detenuto');
      const failArgs: Parameters<typeof this.failReport>[0] = {
        cycleId, rule: input.rule, tenantId: input.tenantId,
        startedAt, dryRun: input.dryRun, triggeredBy: input.triggeredBy,
        error: 'Lock già detenuto da un altro processo',
      };
      if (input.overrides?.dataSourceRef !== undefined) {
        failArgs.dataSourceRef = input.overrides.dataSourceRef;
      }
      return { report: this.failReport(failArgs), detected: [] };
    }

    try {
      // 2. Risolvi config + adapter
      const config = await this.resolveEffectiveConfig(input);
      const adapter = await this.resolver.resolve(config.dataSourceRef);

      // 3. Ensure schema quarantine sul data source target
      if (!input.dryRun) {
        await this.quarantine.ensureSchema(config.dataSourceRef);
      }

      // 4. Detect
      const ctx: JanitorContext = {
        adapter,
        targetTable: input.rule.targetTable,
        targetPkColumn: input.rule.targetPkColumn,
        now: startedAt,
        dryRun: input.dryRun,
        triggeredBy: input.triggeredBy,
        logger: ruleLogger,
        params: config.params,
        maxRows: config.maxRowsPerRun,
        ...(input.tenantId !== 'default' ? { tenantId: input.tenantId } : {}),
      };

      let detected: readonly DetectedRow[];
      try {
        detected = await this.runDetect(input.rule, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ruleLogger.error({ err }, 'detect() ha lanciato eccezione');
        const report = this.failReport({
          cycleId, rule: input.rule, tenantId: input.tenantId,
          dataSourceRef: config.dataSourceRef, startedAt, dryRun: input.dryRun,
          triggeredBy: input.triggeredBy, error: `detect() error: ${msg}`,
        });
        if (!input.dryRun) await this.runLog.appendRule(report);
        return { report, detected: [] };
      }

      // 5. Repair opzionale
      let repairedIds: ReadonlySet<string> = new Set();
      if (!input.dryRun && isCodeRule(input.rule) && typeof input.rule.repair === 'function' && detected.length > 0) {
        try {
          const result = await input.rule.repair(ctx, detected);
          repairedIds = new Set(result.repairedIds);
          ruleLogger.info({ count: repairedIds.size }, 'Repair completato');
        } catch (err) {
          ruleLogger.warn({ err }, 'repair() ha lanciato eccezione — proseguo con quarantine');
        }
      }

      // 6. Quarantine delle righe NON riparate
      let rowsQuarantined = 0;
      let rowsSkipped = 0;
      if (!input.dryRun) {
        for (const row of detected) {
          if (repairedIds.has(row.id)) continue;
          try {
            await this.quarantine.quarantineRow({
              originalTable: input.rule.targetTable,
              pkColumn: input.rule.targetPkColumn,
              row,
              ruleId: input.rule.id,
              dataSourceRef: config.dataSourceRef,
              triggeredBy: input.triggeredBy,
            });
            rowsQuarantined += 1;
          } catch (err) {
            rowsSkipped += 1;
            ruleLogger.warn({ err, rowId: row.id }, 'quarantineRow() fallito — riga skippata');
          }
        }
      }

      const endedAt = this.clock.now();
      const report: JanitorRuleReport = Object.freeze({
        cycleId,
        ruleId: input.rule.id,
        tenantId: input.tenantId,
        dataSourceRef: config.dataSourceRef,
        targetTable: input.rule.targetTable,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        rowsDetected: detected.length,
        rowsRepaired: repairedIds.size,
        rowsQuarantined,
        rowsSkipped,
        bySeverity: detected.length > 0 ? aggregateBySeverity(detected) : emptyBySeverity(),
        dryRun: input.dryRun,
        success: true,
        triggeredBy: input.triggeredBy,
      });

      // 7. Persistenza log
      if (!input.dryRun) {
        await this.runLog.appendRule(report);
        await this.audit.emit({
          tenantId: input.tenantId,
          action: 'janitor.rule.executed',
          resourceType: 'janitor_rule',
          resourceId: input.rule.id,
          actorId: input.triggeredBy,
          metadata: {
            cycleId,
            rowsDetected: detected.length,
            rowsRepaired: repairedIds.size,
            rowsQuarantined,
          },
        });
      }

      // 8. Notifica detection
      if (config.notifyOnDetection && !input.dryRun) {
        await this.notifications.notifyDetection(report);
      }

      return { report, detected };
    } finally {
      this.locks.release(lockKey, holderId);
    }
  }

  /**
   * Combina i defaults della rule con la config persistita (se esiste)
   * e con eventuali overrides ad-hoc (per UI preview). Valida i params
   * contro lo schema della rule — Federico-grade input validation.
   */
  private async resolveEffectiveConfig(input: ExecuteRuleInput): Promise<RuleConfig> {
    const persisted = await this.configRepo.get(input.rule.id, input.tenantId);
    const ruleDefaults = ruleDefaultConfig(input.rule, input.tenantId);
    const base = persisted ?? ruleDefaults;

    const params = input.overrides?.params ?? base.params;
    const dataSourceRef = input.overrides?.dataSourceRef ?? base.dataSourceRef;
    const maxRowsPerRun = input.overrides?.maxRowsPerRun ?? base.maxRowsPerRun;

    // Validazione params contro lo schema della rule (solo CodeRule —
    // le DslRule non hanno schema dichiarato).
    if (isCodeRule(input.rule)) {
      const validated = validateParams(input.rule.paramsSchema, params);
      if (!validated.ok) {
        const msgs = validated.error.map((e) => `${e.param}: ${e.message}`).join('; ');
        throw new Error(`Config invalida per rule ${input.rule.id}: ${msgs}`);
      }
      return {
        ...base,
        dataSourceRef,
        maxRowsPerRun,
        params: validated.value,
      };
    }

    return {
      ...base,
      dataSourceRef,
      maxRowsPerRun,
      params,
    };
  }

  /**
   * Wrapper che intercetta CodeRule.detect() vs DslRule (SQL execution).
   * Le DslRule eseguono detectSql via executeRaw, parsano risultati come
   * DetectedRow.
   */
  private async runDetect(rule: Rule, ctx: JanitorContext): Promise<readonly DetectedRow[]> {
    if (isCodeRule(rule)) {
      return rule.detect(ctx);
    }
    return this.runDslDetect(rule.detectSql, rule.placeholders, ctx, rule);
  }

  private async runDslDetect(
    sqlTemplate: string,
    placeholders: Readonly<Record<string, string | number | boolean>>,
    ctx: JanitorContext,
    rule: { defaultSeverity: CorruptionSeverity; id: string; targetPkColumn: string },
  ): Promise<readonly DetectedRow[]> {
    if (typeof ctx.adapter.executeRaw !== 'function') {
      ctx.logger.warn('Adapter non supporta executeRaw — DSL rule non applicabile');
      return [];
    }
    const sql = interpolatePlaceholders(sqlTemplate, placeholders, ctx);
    // N19 audit (2026-05-29): DSL `detectSql` is validated as SELECT/WITH
    // at create/update time, but the validator alone is not load-bearing
    // (it could have been bypassed by a future bug, or by a hostile
    // operator with DB-level write to `janitor_dsl_rules`). Layer-3
    // defense: the adapter rejects DML/DDL/other when readOnly=true,
    // including multi-statement payloads and modifying CTEs.
    const res = await ctx.adapter.executeRaw(sql, { rowLimit: ctx.maxRows, readOnly: true });
    const rows = res.rows;
    return rows.slice(0, ctx.maxRows).map((row): DetectedRow => {
      const pkVal = row[rule.targetPkColumn];
      return Object.freeze({
        id: String(pkVal),
        reason: `Match DSL rule "${rule.id}"`,
        severity: rule.defaultSeverity,
        raw: Object.freeze({ ...row }),
        ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
      });
    });
  }

  private failReport(args: {
    cycleId: string;
    rule: Rule;
    tenantId: string;
    dataSourceRef?: DataSourceRef;
    startedAt: Date;
    dryRun: boolean;
    triggeredBy: string;
    error: string;
  }): JanitorRuleReport {
    const endedAt = this.clock.now();
    const dsr = args.dataSourceRef ?? (args.rule.kind === 'code' ? args.rule.defaultDataSource : args.rule.dataSourceRef);
    return Object.freeze({
      cycleId: args.cycleId,
      ruleId: args.rule.id,
      tenantId: args.tenantId,
      dataSourceRef: dsr,
      targetTable: args.rule.targetTable,
      startedAt: args.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - args.startedAt.getTime(),
      rowsDetected: 0,
      rowsRepaired: 0,
      rowsQuarantined: 0,
      rowsSkipped: 0,
      bySeverity: emptyBySeverity(),
      dryRun: args.dryRun,
      success: false,
      error: args.error,
      triggeredBy: args.triggeredBy,
    });
  }
}

function ruleDefaultConfig(rule: Rule, tenantId: string): RuleConfig {
  const isCode = rule.kind === 'code';
  const defaultDataSource = isCode ? rule.defaultDataSource : rule.dataSourceRef;
  const defaultParams: Record<string, unknown> = {};
  if (isCode) {
    for (const p of rule.paramsSchema) defaultParams[p.name] = p.default;
  }
  return Object.freeze({
    ruleId: rule.id,
    tenantId,
    enabled: true,
    schedule: rule.defaultSchedule,
    dataSourceRef: defaultDataSource,
    maxRowsPerRun: rule.defaultMaxRowsPerRun,
    severity: rule.defaultSeverity,
    params: Object.freeze(defaultParams),
    notifyOnDetection: false,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Sostituisce placeholder `${name}` nel template SQL con il valore
 * corrispondente da `placeholders`. Se il valore è una stringa, viene
 * SQL-escaped (raddoppia gli apici). Numeri/booleani: stampati inline.
 */
function interpolatePlaceholders(
  template: string,
  values: Readonly<Record<string, string | number | boolean>>,
  ctx: JanitorContext,
): string {
  // Built-in placeholders disponibili sempre
  const ALL: Record<string, string | number | boolean> = {
    ...values,
    nowIso: ctx.now.toISOString(),
    tenantId: ctx.tenantId ?? 'default',
  };
  return template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    if (!(name in ALL)) return match; // lascia il template inalterato se placeholder ignoto
    const v = ALL[name];
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return match;
  });
}
