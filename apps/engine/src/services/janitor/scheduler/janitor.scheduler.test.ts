/**
 * Test 2026-grade — scheduler/janitor.scheduler.ts (tick + cron dispatch).
 *
 * 🚨 IDEMPOTENZA START: chiamare start() due volte non avvia 2 timer.
 *    Bug = doppi tick = doppia run = audit duplicato + race quarantine.
 *
 * 🚨 STALE LOCK CLEANUP AL BOOT: locks.cleanupStale() chiamato 1x.
 *    Bug = lock di processo crashato MAI rilasciato → regola muta.
 *
 * 🚨 DOUBLE-TICK DRIFT: setInterval può fire 2x stesso minute (drift JS).
 *    lastTickMinute filtra → eseguita 1 sola volta per minuto.
 *
 * 🚨 SKIP DISABLED: config.enabled=false → no execute.
 * 🚨 SKIP CRON-MISMATCH: cron NON match now → skip.
 * 🚨 SKIP RULE-NOT-FOUND: registry.get null → skip + counter.
 * 🚨 CATCH EXEC ERROR: executeRule throw non blocca altri rule del tick.
 * 🚨 SCHEDULE PARSE FAIL: warn + skip (no crash scheduler).
 *
 * 🚨 STOP GRACEFUL: aspetta tick in volo prima di tornare.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JanitorScheduler } from './janitor.scheduler.js';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type {
  IClock, IRuleConfigRepository, IRuleRegistry, ILockGateway,
} from '@/services/janitor/ports/index.js';
import type { Logger } from 'pino';

const mkLogger = (): Logger =>
  ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const mkClock = (fixedNow: Date): IClock => ({
  now: vi.fn(() => fixedNow),
  epochMs: vi.fn(() => fixedNow.getTime()),
  nowIso: vi.fn(() => fixedNow.toISOString()),
});

const mkConfig = (over: Partial<{
  ruleId: string; enabled: boolean; schedule: string; tenantId: string;
}> = {}) => ({
  ruleId: over.ruleId ?? 'rule.a',
  tenantId: over.tenantId ?? 't1',
  enabled: over.enabled ?? true,
  schedule: over.schedule ?? '* * * * *', // every minute
  dataSourceRef: SYSTEM_REF,
  maxRowsPerRun: 100,
  severity: 'critical' as const,
  params: {},
  notifyOnDetection: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const mkCodeRule = (id: string) => ({
  kind: 'code' as const,
  id,
  title: id,
  description: 'test rule',
  defaultDataSource: SYSTEM_REF,
  targetTable: 'runs',
  targetPkColumn: 'id',
  tags: [] as readonly string[],
  paramsSchema: [] as readonly never[],
  defaultSeverity: 'critical' as const,
  defaultSchedule: '0 * * * *',
  defaultMaxRowsPerRun: 100,
  detect: vi.fn(async () => []),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('🚨 JanitorScheduler — start idempotency', () => {
  it('🚨 start chiamato 2x → NON avvia 2 timer', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => []),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(), listAll: vi.fn(() => []),
      registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const logger = mkLogger();

    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    s.start(); // dup
    expect(logger.warn).toHaveBeenCalledWith('JanitorScheduler già avviato, skip');
    vi.clearAllTimers();
  });

  it('🚨 start chiama cleanupStale (1x al boot, resilience post-crash)', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => []),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(), listAll: vi.fn(() => []),
      registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 3),
      listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const logger = mkLogger();

    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    expect(locks.cleanupStale).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({ staleCount: 3 }, expect.stringContaining('stale lock cleanup'));
    vi.clearAllTimers();
  });
});

describe('🚨 JanitorScheduler — tick logic', () => {
  it('🚨 enabled config + cron match → execute called', async () => {
    const fixedNow = new Date('2026-06-08T12:34:00Z');
    const config = mkConfig({ schedule: '* * * * *' }); // ogni minuto
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [config]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const rule = mkCodeRule('rule.a');
    const registry: IRuleRegistry = {
      get: vi.fn(() => rule) as IRuleRegistry['get'],
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn(async () => ({ detected: [], report: {} })) };

    const s = new JanitorScheduler(
      mkClock(fixedNow), cfgRepo, registry, locks, exec as never, mkLogger(),
    );
    s.start();
    // start chiama tick subito (microtask)
    await vi.runOnlyPendingTimersAsync();
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(exec.execute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', triggeredBy: 'scheduler', dryRun: false,
    }));
    vi.clearAllTimers();
  });

  it('🚨 enabled=false → SKIP execute', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [mkConfig({ enabled: false })]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(() => mkCodeRule('rule.a')) as IRuleRegistry['get'],
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, mkLogger(),
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    expect(exec.execute).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });

  it('🚨 cron NOT match now → SKIP execute', async () => {
    const fixedNow = new Date('2026-06-08T12:34:00Z'); // minuto 34
    // schedule "0 * * * *" = solo a minuto 0
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [mkConfig({ schedule: '0 * * * *' })]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(() => mkCodeRule('rule.a')) as IRuleRegistry['get'],
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const s = new JanitorScheduler(
      mkClock(fixedNow), cfgRepo, registry, locks, exec as never, mkLogger(),
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    expect(exec.execute).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });

  it('🚨 rule.id not in registry → SKIP + counter notFound', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [mkConfig({ ruleId: 'missing.rule' })]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(() => null), // mai trovato
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const logger = mkLogger();
    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    expect(exec.execute).not.toHaveBeenCalled();
    // counter notFound > 0 → log info chiamato con skippedNotFound: 1
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skippedNotFound: 1 }),
      expect.stringContaining('tick'),
    );
    vi.clearAllTimers();
  });

  it('🚨 cron MALFORMATA → warn + skip (no crash)', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [mkConfig({ schedule: 'NOT A CRON' })]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(() => mkCodeRule('rule.a')) as IRuleRegistry['get'],
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const logger = mkLogger();
    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule.a' }),
      expect.stringContaining('cron malformata'),
    );
    expect(exec.execute).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });

  it('🚨 executeRule THROW → catch, log error, continua altri', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [
        mkConfig({ ruleId: 'rule.a' }),
        mkConfig({ ruleId: 'rule.b' }),
      ]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn((id: string) => mkCodeRule(id)),
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = {
      execute: vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error('boom-a');
        })
        .mockImplementationOnce(async () => ({ detected: [], report: {} })),
    };
    const logger = mkLogger();
    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    // entrambi tentati, anche se primo throw
    expect(exec.execute).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule.a' }),
      expect.stringContaining('eccezione'),
    );
    vi.clearAllTimers();
  });
});

describe('🚨 JanitorScheduler — drift protection', () => {
  it('🚨 doppio tick stesso minuto → SECONDA chiamata SKIP (lastTickMinute filter)', async () => {
    const fixedNow = new Date('2026-06-08T12:00:30Z'); // minuto 12:00
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => [mkConfig({ schedule: '* * * * *' })]),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(() => mkCodeRule('rule.a')) as IRuleRegistry['get'],
      listAll: vi.fn(() => []), registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn(async () => ({ detected: [], report: {} })) };

    const s = new JanitorScheduler(
      mkClock(fixedNow), cfgRepo, registry, locks, exec as never, mkLogger(),
    );
    s.start(); // tick 1 immediato
    await vi.runOnlyPendingTimersAsync();
    expect(exec.execute).toHaveBeenCalledTimes(1);

    // Avanza setInterval tick 2 (60s) → ma now fixed → stesso minuto
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec.execute).toHaveBeenCalledTimes(1); // ancora 1, drift filter
    vi.clearAllTimers();
  });
});

describe('🚨 JanitorScheduler — stop graceful', () => {
  it('🚨 stop clear timer + flag', async () => {
    const cfgRepo: IRuleConfigRepository = {
      listAll: vi.fn(async () => []),
      list: vi.fn(), get: vi.fn(), upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const registry: IRuleRegistry = {
      get: vi.fn(), listAll: vi.fn(() => []),
      registerCodeRule: vi.fn(), registerDslRule: vi.fn(),
      unregisterDslRule: vi.fn(), listForTenant: vi.fn(() => []),
    };
    const locks: ILockGateway = {
      acquire: vi.fn(() => true), release: vi.fn(),
      cleanupStale: vi.fn(() => 0), listActive: vi.fn(() => []),
    };
    const exec = { execute: vi.fn() };
    const logger = mkLogger();
    const s = new JanitorScheduler(
      mkClock(new Date('2026-06-08T12:00:00Z')),
      cfgRepo, registry, locks, exec as never, logger,
    );
    s.start();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await s.stop();
    expect(logger.info).toHaveBeenCalledWith('JanitorScheduler fermato');
  });
});
