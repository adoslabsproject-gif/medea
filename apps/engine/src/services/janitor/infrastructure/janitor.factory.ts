/**
 * Infrastructure — JanitorFactory.
 *
 * Composition root del Janitor. Assembla ports/adapters/use cases in un
 * `JanitorRuntime` consumibile dalle route HTTP e dal boot wiring.
 *
 * Federico-grade: zero DI container fancy. Wiring esplicito. Ogni
 * dipendenza visibile in 1 punto. Quando vuoi sostituire un adapter (es.
 * Postgres-backed lock), modifichi qui e in nessun altro posto.
 */

import type { Logger } from 'pino';
import { logger as defaultLogger } from '@/lib/logger.js';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from '@/services/audit.service.js';
import type { DbStudioService } from '@/services/db-studio.service.js';
import { NotificationsService } from '@/services/notifications.service.js';

// Adapters
import { SystemClock } from '@/services/janitor/adapters/system-clock.js';
import { AuditEmitterAdapter } from '@/services/janitor/adapters/audit-emitter.adapter.js';
import { SqliteLockGateway } from '@/services/janitor/adapters/lock-gateway.sqlite.js';
import { InMemoryRuleRegistry } from '@/services/janitor/adapters/rule-registry.in-memory.js';
import { DataSourceResolverAdapter } from '@/services/janitor/adapters/data-source-resolver.adapter.js';
import { QuarantineGatewayAdapter } from '@/services/janitor/adapters/quarantine.adapter.js';
import { SqliteRuleConfigRepository } from '@/services/janitor/adapters/rule-config-repo.sqlite.js';
import { SqliteRunLogRepository } from '@/services/janitor/adapters/run-log-repo.sqlite.js';
import { NotificationEmitterAdapter } from '@/services/janitor/adapters/notification-emitter.adapter.js';
import { DslRuleRepository } from '@/services/janitor/adapters/dsl-rule.repository.js';

// Application
import { ExecuteRuleUseCase } from '@/services/janitor/application/execute-rule.usecase.js';
import { ExecuteCycleUseCase } from '@/services/janitor/application/execute-cycle.usecase.js';
import { ManageRuleConfigUseCase } from '@/services/janitor/application/manage-rule-config.usecase.js';
import { ManageQuarantineUseCase } from '@/services/janitor/application/manage-quarantine.usecase.js';
import { ManageDslRulesUseCase } from '@/services/janitor/application/manage-dsl-rules.usecase.js';

// Scheduler
import { JanitorScheduler } from '@/services/janitor/scheduler/janitor.scheduler.js';

// Built-in rules
import { BUILTIN_CODE_RULES } from '@/services/janitor/rules/index.js';

// Domain / Ports (per re-export)
import type {
  IRuleRegistry,
  IRuleConfigRepository,
  IDataSourceResolver,
  IQuarantineGateway,
  IRunLogRepository,
} from '@/services/janitor/ports/index.js';

export interface JanitorRuntime {
  readonly logger: Logger;
  readonly registry: IRuleRegistry;
  readonly configRepo: IRuleConfigRepository;
  readonly resolver: IDataSourceResolver;
  readonly quarantine: IQuarantineGateway;
  readonly runLog: IRunLogRepository;
  readonly executeRule: ExecuteRuleUseCase;
  readonly executeCycle: ExecuteCycleUseCase;
  readonly manageRuleConfig: ManageRuleConfigUseCase;
  readonly manageQuarantine: ManageQuarantineUseCase;
  readonly manageDslRules: ManageDslRulesUseCase;
  readonly scheduler: JanitorScheduler;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface JanitorFactoryOptions {
  readonly dbStudio: DbStudioService;
  readonly logger?: Logger;
}

export function createJanitorRuntime(opts: JanitorFactoryOptions): JanitorRuntime {
  const logger = (opts.logger ?? defaultLogger).child({ component: 'janitor' });

  // ─── Adapters infrastrutturali ───
  const clock = new SystemClock();
  const audit = new AuditEmitterAdapter(new AuditLogService());
  const { sqlite } = getDatabase();
  const locks = new SqliteLockGateway(sqlite);
  const registry = new InMemoryRuleRegistry(logger);
  const resolver = new DataSourceResolverAdapter(opts.dbStudio);
  const quarantine = new QuarantineGatewayAdapter(resolver);
  const configRepo = new SqliteRuleConfigRepository();
  const runLog = new SqliteRunLogRepository();
  const notifications = new NotificationEmitterAdapter(new NotificationsService());
  const dslRepo = new DslRuleRepository();

  // ─── Use cases ───
  const executeRule = new ExecuteRuleUseCase(
    clock,
    locks,
    resolver,
    quarantine,
    runLog,
    audit,
    notifications,
    configRepo,
    logger,
  );
  const executeCycle = new ExecuteCycleUseCase(clock, registry, configRepo, executeRule, logger);
  const manageRuleConfig = new ManageRuleConfigUseCase(registry, configRepo, audit);
  const manageQuarantine = new ManageQuarantineUseCase(quarantine, audit);
  const manageDslRules = new ManageDslRulesUseCase(dslRepo, registry, resolver, audit);

  // ─── Scheduler ───
  const scheduler = new JanitorScheduler(clock, configRepo, registry, locks, executeRule, logger);

  // ─── Start / stop lifecycle ───
  async function start(): Promise<void> {
    // 1. Registra le built-in code rules
    for (const rule of BUILTIN_CODE_RULES) registry.registerCodeRule(rule);

    // 2. Carica DSL rules persistite
    const dsl = await dslRepo.listAll();
    for (const r of dsl) registry.registerDslRule(r);

    // 3. Avvia scheduler
    scheduler.start();

    logger.info(
      {
        codeRules: BUILTIN_CODE_RULES.length,
        dslRules: dsl.length,
      },
      'Janitor runtime avviato',
    );
  }

  async function stop(): Promise<void> {
    await scheduler.stop();
    await resolver.disposeSystem();
    logger.info('Janitor runtime fermato');
  }

  return {
    logger,
    registry,
    configRepo,
    resolver,
    quarantine,
    runLog,
    executeRule,
    executeCycle,
    manageRuleConfig,
    manageQuarantine,
    manageDslRules,
    scheduler,
    start,
    stop,
  };
}
