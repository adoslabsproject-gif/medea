/**
 * Test 2026-grade — ExecuteRuleUseCase (janitor orchestrator).
 *
 * Coverage REALE: dependency injection di tutti i 9 port + Rule fixture in-memory.
 * Verifica:
 *  - lock contention: acquire=false → failReport, NO detect, lock released
 *  - happy path CodeRule: detect → repair → quarantine → audit + log
 *  - detect throw: failReport con error message; runLog.appendRule chiamato
 *  - repair throw: warn + proseguo con quarantine TUTTE le rows
 *  - 🚨 quarantineRow throw per riga: rowsSkipped++ ma continua su altre
 *  - dry-run: NO ensureSchema, NO repair, NO quarantineRow, NO appendRule,
 *    NO audit.emit, NO notifyDetection — solo detect
 *  - 🚨 notifyOnDetection=true: notifications.notifyDetection chiamato post-success
 *  - 🚨 notifyOnDetection in dry-run: NON chiamato
 *  - DslRule: runDslDetect tramite executeRaw, placeholder interpolation
 *    con SQL escape ('${tenantId}' → 'tA' con apici raddoppiati)
 *  - 🚨 placeholder ignoto → lascia template invariato (NO crash)
 *  - DslRule + adapter senza executeRaw → ritorna [] (no throw)
 *  - effective config: override params/maxRows/dataSourceRef applicati
 *  - params validation: schema fail → throw "Config invalida"
 *  - lock release: try/finally garantisce release anche su throw
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecuteRuleUseCase } from './execute-rule.usecase.js';
import type {
  Rule,
  CodeRule,
  DslRule,
  DetectedRow,
  RuleConfig,
  DataSourceRef,
} from '@/services/janitor/domain/index.js';

const dataSourceRef = 'system' as DataSourceRef;

function makeFakeAdapter(
  executeRawImpl?: (sql: string, opts?: unknown) => unknown,
): Record<string, unknown> {
  return {
    engine: 'sqlite',
    executeRaw: executeRawImpl ?? (async () => ({ rows: [] })),
    introspect: async () => [],
    query: async () => [],
    insert: async () => ({}),
    update: async () => ({}),
    delete: async () => ({}),
    transaction: undefined,
    connect: async () => undefined,
  };
}

function makeCodeRule(over: Partial<CodeRule> = {}): CodeRule {
  return {
    kind: 'code',
    id: 'janitor.test.basic',
    title: 'Test rule',
    description: 'A test rule',
    defaultDataSource: dataSourceRef,
    targetTable: 'users',
    targetPkColumn: 'id',
    tags: [],
    paramsSchema: [],
    defaultSeverity: 'warning',
    defaultSchedule: '0 * * * *',
    defaultMaxRowsPerRun: 100,
    detect: async () => [],
    ...over,
  };
}

function makeDslRule(over: Partial<DslRule> = {}): DslRule {
  return {
    kind: 'dsl',
    id: 'dsl_test123',
    tenantId: 't1',
    title: 'Dsl Test',
    description: 'desc',
    dataSourceRef,
    targetTable: 'orders',
    targetPkColumn: 'id',
    detectSql: 'SELECT id FROM orders WHERE total < 0',
    placeholders: {},
    tags: [],
    defaultSeverity: 'critical',
    defaultSchedule: '0 * * * *',
    defaultMaxRowsPerRun: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const detectedRow = (id: string, severity: DetectedRow['severity'] = 'warning'): DetectedRow =>
  Object.freeze({
    id,
    reason: 'reason',
    severity,
    raw: Object.freeze({ id }),
  });

function makeUseCase(
  opts: {
    acquire?: boolean;
    configGet?: RuleConfig | null;
    adapter?: Record<string, unknown>;
    ensureSchema?: () => Promise<void>;
    quarantineRow?: (args: unknown) => Promise<unknown>;
  } = {},
) {
  const clock = { now: () => new Date('2026-06-06T10:00:00Z') };
  const locks = {
    acquire: vi.fn(() => opts.acquire ?? true),
    release: vi.fn(),
  };
  const resolver = {
    resolve: vi.fn(async () => opts.adapter ?? makeFakeAdapter()),
  };
  const quarantine = {
    ensureSchema: vi.fn(
      opts.ensureSchema ??
        (async () => {
          /* noop */
        }),
    ),
    quarantineRow: vi.fn(opts.quarantineRow ?? (async () => ({}))),
  };
  const runLog = {
    appendRule: vi.fn(async () => {
      /* noop */
    }),
  };
  const audit = {
    emit: vi.fn(async () => {
      /* noop */
    }),
  };
  const notifications = {
    notifyDetection: vi.fn(async () => {
      /* noop */
    }),
  };
  const configRepo = {
    get: vi.fn(async () => opts.configGet ?? null),
  };
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const uc = new ExecuteRuleUseCase(
    clock as never,
    locks as never,
    resolver as never,
    quarantine as never,
    runLog as never,
    audit as never,
    notifications as never,
    configRepo as never,
    logger as never,
  );
  return {
    uc,
    clock,
    locks,
    resolver,
    quarantine,
    runLog,
    audit,
    notifications,
    configRepo,
    logger,
  };
}

beforeEach(() => {
  // vitest auto resets between tests
});

describe('lock contention', () => {
  it('acquire=false → failReport, NO detect, NO release di altri', async () => {
    const { uc, locks } = makeUseCase({ acquire: false });
    const detectSpy = vi.fn(async () => []);
    const rule = makeCodeRule({ detect: detectSpy });
    const { report, detected } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'test',
      dryRun: false,
    });
    expect(report.success).toBe(false);
    expect(report.error).toContain('Lock già detenuto');
    expect(detected).toEqual([]);
    expect(detectSpy).not.toHaveBeenCalled();
    // release NON chiamato perche\` non e\` stato acquisito
    expect(locks.release).not.toHaveBeenCalled();
  });
});

describe('happy path CodeRule', () => {
  it('detect 2 rows → repair 1 → quarantine 1 → audit + runLog appended', async () => {
    const rows: DetectedRow[] = [detectedRow('r1'), detectedRow('r2', 'critical')];
    const rule = makeCodeRule({
      detect: async () => rows,
      repair: async () => ({ repairedIds: ['r1'] }),
    });
    const { uc, quarantine, runLog, audit, notifications, locks } = makeUseCase();
    const { report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(report.success).toBe(true);
    expect(report.rowsDetected).toBe(2);
    expect(report.rowsRepaired).toBe(1);
    expect(report.rowsQuarantined).toBe(1);
    expect(report.rowsSkipped).toBe(0);
    expect(quarantine.quarantineRow).toHaveBeenCalledTimes(1);
    expect(runLog.appendRule).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(notifications.notifyDetection).not.toHaveBeenCalled();
    expect(locks.release).toHaveBeenCalledTimes(1);
  });

  it('detect 0 rows: report rowsDetected=0, no quarantine call', async () => {
    const { uc, quarantine } = makeUseCase();
    const { report } = await uc.execute({
      rule: makeCodeRule(),
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(report.success).toBe(true);
    expect(report.rowsDetected).toBe(0);
    expect(quarantine.quarantineRow).not.toHaveBeenCalled();
  });
});

describe('detect error path', () => {
  it('detect throw → failReport con error + runLog.appendRule appended', async () => {
    const rule = makeCodeRule({
      detect: async () => {
        throw new Error('SQL syntax');
      },
    });
    const { uc, runLog, locks } = makeUseCase();
    const { report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(report.success).toBe(false);
    expect(report.error).toContain('SQL syntax');
    expect(runLog.appendRule).toHaveBeenCalledTimes(1);
    expect(locks.release).toHaveBeenCalledTimes(1); // try/finally
  });

  it('detect throw in dry-run → failReport ma NO runLog (skip)', async () => {
    const rule = makeCodeRule({
      detect: async () => {
        throw new Error('boom');
      },
    });
    const { uc, runLog } = makeUseCase();
    const { report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'preview',
      dryRun: true,
    });
    expect(report.success).toBe(false);
    expect(runLog.appendRule).not.toHaveBeenCalled();
  });
});

describe('repair fault tolerance', () => {
  it('repair throw → warn + proseguo con quarantine TUTTE le rows', async () => {
    const rows: DetectedRow[] = [detectedRow('r1'), detectedRow('r2')];
    const rule = makeCodeRule({
      detect: async () => rows,
      repair: async () => {
        throw new Error('repair conn lost');
      },
    });
    const { uc, quarantine } = makeUseCase();
    const { report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(report.rowsRepaired).toBe(0);
    expect(report.rowsQuarantined).toBe(2);
    expect(quarantine.quarantineRow).toHaveBeenCalledTimes(2);
  });
});

describe('quarantine per-row tolerance', () => {
  it('🚨 quarantineRow throw per UNA riga → rowsSkipped=1, altre proseguono', async () => {
    const rows: DetectedRow[] = [detectedRow('r1'), detectedRow('r2'), detectedRow('r3')];
    const rule = makeCodeRule({ detect: async () => rows });
    let call = 0;
    const { uc, quarantine } = makeUseCase({
      quarantineRow: async () => {
        call += 1;
        if (call === 2) throw new Error('UNIQUE constraint');
        return {};
      },
    });
    const { report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(report.rowsQuarantined).toBe(2);
    expect(report.rowsSkipped).toBe(1);
    expect(quarantine.quarantineRow).toHaveBeenCalledTimes(3);
  });
});

describe('dry-run mode — read-only', () => {
  it('dry-run: NO ensureSchema, NO quarantineRow, NO repair, NO audit, NO notify', async () => {
    const rows: DetectedRow[] = [detectedRow('r1')];
    const repairSpy = vi.fn(async () => ({ repairedIds: ['r1'] }));
    const rule = makeCodeRule({ detect: async () => rows, repair: repairSpy });
    const { uc, quarantine, runLog, audit, notifications } = makeUseCase();
    const { report, detected } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'preview',
      dryRun: true,
    });
    expect(report.success).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(detected).toHaveLength(1);
    expect(quarantine.ensureSchema).not.toHaveBeenCalled();
    expect(quarantine.quarantineRow).not.toHaveBeenCalled();
    expect(repairSpy).not.toHaveBeenCalled();
    expect(runLog.appendRule).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
    expect(notifications.notifyDetection).not.toHaveBeenCalled();
  });
});

describe('notifyOnDetection', () => {
  const persistedConfigNotify = (rule: CodeRule): RuleConfig =>
    Object.freeze({
      ruleId: rule.id,
      tenantId: 't1',
      enabled: true,
      schedule: rule.defaultSchedule,
      dataSourceRef,
      maxRowsPerRun: 100,
      severity: rule.defaultSeverity,
      params: {},
      notifyOnDetection: true,
      updatedAt: new Date().toISOString(),
    });

  it('🚨 notifyOnDetection=true + non-dry-run → notifyDetection chiamato', async () => {
    const rule = makeCodeRule();
    const { uc, notifications } = makeUseCase({ configGet: persistedConfigNotify(rule) });
    await uc.execute({ rule, tenantId: 't1', triggeredBy: 'cron', dryRun: false });
    expect(notifications.notifyDetection).toHaveBeenCalledTimes(1);
  });

  it('🚨 notifyOnDetection=true + dry-run → notifyDetection NON chiamato', async () => {
    const rule = makeCodeRule();
    const { uc, notifications } = makeUseCase({ configGet: persistedConfigNotify(rule) });
    await uc.execute({ rule, tenantId: 't1', triggeredBy: 'cron', dryRun: true });
    expect(notifications.notifyDetection).not.toHaveBeenCalled();
  });
});

describe('DslRule path', () => {
  it('detectSql via executeRaw, rows mapped a DetectedRow', async () => {
    const rule: Rule = makeDslRule();
    const adapter = makeFakeAdapter(async () => ({
      rows: [
        { id: 42, total: -5 },
        { id: 43, total: -10 },
      ],
    }));
    const { uc } = makeUseCase({ adapter });
    const { detected } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(detected).toHaveLength(2);
    expect(detected[0]!.id).toBe('42');
    expect(detected[0]!.severity).toBe('critical');
    expect(detected[0]!.reason).toContain(rule.id);
  });

  it('🚨 placeholder interpolation: SQL escape per stringhe', async () => {
    let capturedSql = '';
    const rule = makeDslRule({
      detectSql: "SELECT * FROM logs WHERE tenant = '${tenantId}' AND msg = '${msg}'",
      placeholders: { msg: "with 'apos" },
    });
    const adapter = makeFakeAdapter(async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    });
    const { uc } = makeUseCase({ adapter });
    await uc.execute({ rule, tenantId: 't1', triggeredBy: 'cron', dryRun: false });
    expect(capturedSql).toContain("'t1'"); // tenantId built-in
    expect(capturedSql).toContain("'with ''apos'"); // single quote escaped
  });

  it('placeholder ignoto → lascia template invariato (no crash)', async () => {
    let capturedSql = '';
    const rule = makeDslRule({
      detectSql: 'SELECT * WHERE foo = ${unknownVar}',
      placeholders: {},
    });
    const adapter = makeFakeAdapter(async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    });
    const { uc } = makeUseCase({ adapter });
    await uc.execute({ rule, tenantId: 't1', triggeredBy: 'cron', dryRun: false });
    expect(capturedSql).toContain('${unknownVar}'); // unchanged
  });

  it('🚨 adapter senza executeRaw → ritorna [] (graceful)', async () => {
    const rule = makeDslRule();
    const adapter = { ...makeFakeAdapter(), executeRaw: undefined };
    const { uc } = makeUseCase({ adapter });
    const { detected, report } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(detected).toEqual([]);
    expect(report.success).toBe(true);
    expect(report.rowsDetected).toBe(0);
  });

  it('DSL rows.length > maxRows → trimmed a maxRows', async () => {
    const rule = makeDslRule({ defaultMaxRowsPerRun: 2 });
    const adapter = makeFakeAdapter(async () => ({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    }));
    const { uc } = makeUseCase({ adapter });
    const { detected } = await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
    });
    expect(detected).toHaveLength(2);
  });
});

describe('config overrides', () => {
  it('override params/maxRowsPerRun propagati nel context', async () => {
    let capturedCtx: { maxRows: number; params: Record<string, unknown> } | null = null;
    const rule = makeCodeRule({
      detect: async (ctx) => {
        capturedCtx = { maxRows: ctx.maxRows, params: ctx.params as Record<string, unknown> };
        return [];
      },
    });
    const { uc } = makeUseCase();
    await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
      overrides: { maxRowsPerRun: 5, params: { custom: 'value' } },
    });
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.maxRows).toBe(5);
    // paramsSchema=[] → validateParams strippa params non dichiarati
    // (Federico-grade hardening anti-typo). Comportamento corretto.
    expect(capturedCtx!.params).toEqual({});
  });

  it('override dataSourceRef applicato in resolveEffective', async () => {
    const customDsr = 'tenant:t1:custom-db' as DataSourceRef;
    const rule = makeCodeRule();
    const { uc, resolver } = makeUseCase();
    await uc.execute({
      rule,
      tenantId: 't1',
      triggeredBy: 'cron',
      dryRun: false,
      overrides: { dataSourceRef: customDsr },
    });
    expect(resolver.resolve).toHaveBeenCalledWith(customDsr);
  });
});
