/**
 * Use case — ExecuteCycleUseCase.
 *
 * Esegue UN ciclo di tutte le rule abilitate per uno specifico tenant
 * (o cross-tenant se chiamato dallo scheduler). Per ogni rule chiama
 * ExecuteRuleUseCase, aggrega i report e produce un `JanitorCycleReport`.
 *
 * Le rule sono eseguite in SEQUENZA — non in parallelo. Motivo:
 *   • Sul system DB le rule possono toccare le stesse tabelle (es. runs
 *     + workflow_checkpoints). Una rule che ALTER una colonna o BEGIN
 *     IMMEDIATE blocca l'altra. Sequenziale = predittibile + safe.
 *   • Inflight contattore semplice da gestire.
 * In futuro: parallelismo basato su data-source key.
 */

import { nanoid } from 'nanoid';
import type { Logger } from 'pino';
import type {
  JanitorCycleReport,
  JanitorRuleReport,
  Rule,
} from '@/services/janitor/domain/index.js';
import type {
  IClock,
  IRuleRegistry,
  IRuleConfigRepository,
} from '@/services/janitor/ports/index.js';
import type { ExecuteRuleUseCase } from './execute-rule.usecase.js';

export interface ExecuteCycleInput {
  readonly tenantId?: string; // se omesso → cross-tenant (solo per scheduler)
  readonly triggeredBy: string;
  readonly dryRun: boolean;
  /** Filtro: solo le rule che matchano questi tag. Vuoto = tutte. */
  readonly tagFilter?: readonly string[];
  /** Filtro: ruleId specifici (utile per UI "esegui solo questa"). */
  readonly ruleIds?: readonly string[];
}

export class ExecuteCycleUseCase {
  constructor(
    private readonly clock: IClock,
    private readonly registry: IRuleRegistry,
    private readonly configRepo: IRuleConfigRepository,
    private readonly executeRule: ExecuteRuleUseCase,
    private readonly logger: Logger,
  ) {}

  async execute(input: ExecuteCycleInput): Promise<JanitorCycleReport> {
    const cycleId = nanoid();
    const startedAt = this.clock.now();
    const tenantId = input.tenantId ?? 'default';

    const candidates = this.selectRules(tenantId, input);
    this.logger.info(
      {
        cycleId,
        tenantId,
        candidateCount: candidates.length,
        dryRun: input.dryRun,
      },
      'Janitor cycle start',
    );

    const ruleReports: JanitorRuleReport[] = [];
    let rulesSkippedLock = 0;
    let rulesSkippedDisabled = 0;
    let rulesExecuted = 0;

    for (const rule of candidates) {
      const config = await this.configRepo.get(rule.id, tenantId);
      if (config !== null && !config.enabled) {
        rulesSkippedDisabled += 1;
        continue;
      }
      const result = await this.executeRule.execute({
        rule,
        tenantId,
        triggeredBy: input.triggeredBy,
        dryRun: input.dryRun,
        cycleId,
      });
      ruleReports.push(result.report);
      if (!result.report.success && result.report.error?.startsWith('Lock')) {
        rulesSkippedLock += 1;
      } else {
        rulesExecuted += 1;
      }
    }

    const endedAt = this.clock.now();
    return Object.freeze({
      cycleId,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      triggeredBy: input.triggeredBy,
      dryRun: input.dryRun,
      rules: Object.freeze(ruleReports),
      rulesExecuted,
      rulesSkippedLock,
      rulesSkippedDisabled,
    });
  }

  private selectRules(tenantId: string, input: ExecuteCycleInput): readonly Rule[] {
    const all = this.registry.listForTenant(tenantId);
    if (input.ruleIds && input.ruleIds.length > 0) {
      const set = new Set(input.ruleIds);
      return all.filter((r) => set.has(r.id));
    }
    if (input.tagFilter && input.tagFilter.length > 0) {
      const tagSet = new Set(input.tagFilter);
      return all.filter((r) => r.tags.some((t) => tagSet.has(t)));
    }
    return all;
  }
}
