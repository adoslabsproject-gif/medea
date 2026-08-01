/**
 * Scheduler — JanitorScheduler.
 *
 * Tick centrale che gira ogni 60 secondi. Per ogni tick:
 *   1. Carica tutte le RuleConfig persistite (cross-tenant)
 *   2. Per ogni config con enabled=true → verifica se la cron schedule
 *      matcha il momento attuale (entro la finestra del minute)
 *   3. Se match → lancia ExecuteRuleUseCase (con dryRun=false, triggeredBy='scheduler')
 *   4. Niente attesa: i tick sono indipendenti, il lock garantisce
 *      no-overlap
 *
 * Federico-grade design:
 *   • Un solo setInterval per tutto il sistema (no proliferation)
 *   • Cron evaluation deterministica e testabile (vedi cron-evaluator.ts)
 *   • Cleanup stale lock al boot per resilienza a crash
 *   • Stop graceful via stop() — niente process.exit nascosti
 */

import type { Logger } from 'pino';
import { parseCron, cronMatches } from '@/services/janitor/application/cron-evaluator.js';
import type { ExecuteRuleUseCase } from '@/services/janitor/application/execute-rule.usecase.js';
import type { IClock, IRuleConfigRepository, IRuleRegistry, ILockGateway } from '@/services/janitor/ports/index.js';

const TICK_MS = 60_000; // 1 min — granularità minima cron 5-field

export class JanitorScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickMinute = -1;

  constructor(
    private readonly clock: IClock,
    private readonly configRepo: IRuleConfigRepository,
    private readonly registry: IRuleRegistry,
    private readonly locks: ILockGateway,
    private readonly executeRule: ExecuteRuleUseCase,
    private readonly logger: Logger,
  ) {}

  /**
   * Avvia lo scheduler. Idempotente — chiamarlo due volte non avvia
   * due timer.
   */
  start(): void {
    if (this.timer !== null) {
      this.logger.warn('JanitorScheduler già avviato, skip');
      return;
    }
    const staleCount = this.locks.cleanupStale();
    if (staleCount > 0) {
      this.logger.info({ staleCount }, 'Janitor stale lock cleanup al boot');
    }
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Tick iniziale immediato per non aspettare 1 minuto al boot.
    void this.tick();
    this.logger.info({ tickMs: TICK_MS }, 'JanitorScheduler avviato');
  }

  /**
   * Stop graceful — aspetta che il tick in corso finisca.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Attendi che eventuale tick in volo termini
    while (this.running) await sleep(50);
    this.logger.info('JanitorScheduler fermato');
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // Tick precedente non ancora finito (cron espressioni multiple su
      // rule lente). Saltiamo questo per evitare backpressure.
      return;
    }
    this.running = true;
    try {
      const now = this.clock.now();
      const currentMinute = Math.floor(now.getTime() / 60_000);
      // Protezione contro doppi tick nello stesso minuto (setInterval drift)
      if (currentMinute === this.lastTickMinute) return;
      this.lastTickMinute = currentMinute;

      const configs = await this.configRepo.listAll();
      let executed = 0;
      let skippedSchedule = 0;
      let skippedDisabled = 0;
      let skippedNotFound = 0;

      for (const config of configs) {
        if (!config.enabled) {
          skippedDisabled += 1;
          continue;
        }
        let cronExpr;
        try {
          cronExpr = parseCron(config.schedule);
        } catch (err) {
          this.logger.warn({ ruleId: config.ruleId, err }, 'Schedule cron malformata — skip');
          continue;
        }
        if (!cronMatches(cronExpr, now)) {
          skippedSchedule += 1;
          continue;
        }
        const rule = this.registry.get(config.ruleId);
        if (!rule) {
          skippedNotFound += 1;
          continue;
        }
        // Esegui in modalità fire-and-await — la pipeline interna
        // ha già lock + audit + cleanup
        try {
          await this.executeRule.execute({
            rule,
            tenantId: config.tenantId,
            triggeredBy: 'scheduler',
            dryRun: false,
          });
          executed += 1;
        } catch (err) {
          this.logger.error({ ruleId: rule.id, err }, 'Janitor scheduler: executeRule lanciato eccezione (non dovrebbe — il use case dovrebbe catturarli)');
        }
      }
      if (executed > 0 || skippedNotFound > 0) {
        this.logger.info({
          executed,
          skippedSchedule,
          skippedDisabled,
          skippedNotFound,
        }, 'Janitor scheduler tick');
      }
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
