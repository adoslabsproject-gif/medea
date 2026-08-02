/**
 * Use case — ManageRuleConfigUseCase.
 *
 * Operazioni UI-driven sulla configurazione di una regola:
 *   • listForTenant: lista rules + config-effettivo (resolved from defaults)
 *   • getEffective: get singolo (per edit drawer)
 *   • patch: aggiorna campi specifici (validazione full)
 *   • resetToDefault: cancella config persistita → torna ai default
 *
 * Tutte le mutazioni validano i params contro lo schema della rule e
 * emettono audit. Il chiamante UI è responsabile dei permission check.
 */

import {
  validateParams,
  isCodeRule,
  makeDefaultRuleConfig,
} from '@/services/janitor/domain/index.js';
import type {
  Rule,
  CodeRule,
  RuleConfig,
  RuleConfigPatch,
} from '@/services/janitor/domain/index.js';
import type {
  IRuleRegistry,
  IRuleConfigRepository,
  IAuditEmitter,
} from '@/services/janitor/ports/index.js';
import { validateCronExpression } from './cron-evaluator.js';

export interface RuleListItem {
  readonly rule: Rule;
  readonly config: RuleConfig;
  readonly isPersistedConfig: boolean;
}

export class ManageRuleConfigUseCase {
  constructor(
    private readonly registry: IRuleRegistry,
    private readonly configRepo: IRuleConfigRepository,
    private readonly audit: IAuditEmitter,
  ) {}

  async listForTenant(tenantId: string): Promise<readonly RuleListItem[]> {
    const rules = this.registry.listForTenant(tenantId);
    const persistedAll = await this.configRepo.list(tenantId);
    const byId = new Map(persistedAll.map((c) => [c.ruleId, c]));
    return rules.map((r) => {
      const persisted = byId.get(r.id);
      const config = persisted ?? this.defaultConfigFor(r, tenantId);
      return {
        rule: r,
        config,
        isPersistedConfig: persisted !== undefined,
      };
    });
  }

  async getEffective(ruleId: string, tenantId: string): Promise<RuleListItem | null> {
    const rule = this.registry.get(ruleId);
    if (!rule) return null;
    const persisted = await this.configRepo.get(ruleId, tenantId);
    return {
      rule,
      config: persisted ?? this.defaultConfigFor(rule, tenantId),
      isPersistedConfig: persisted !== null,
    };
  }

  async patch(args: {
    ruleId: string;
    tenantId: string;
    patch: RuleConfigPatch;
    updatedBy?: string;
  }): Promise<RuleConfig> {
    const rule = this.registry.get(args.ruleId);
    if (!rule) throw new Error(`Rule "${args.ruleId}" non trovata`);

    // Validazione cron, se viene cambiato
    if (args.patch.schedule !== undefined) {
      const err = validateCronExpression(args.patch.schedule);
      if (err) throw new Error(`Schedule non valido: ${err}`);
    }

    // Validazione params, se vengono cambiati
    if (args.patch.params !== undefined && isCodeRule(rule)) {
      const validated = validateParams(rule.paramsSchema, args.patch.params);
      if (!validated.ok) {
        const msgs = validated.error.map((e) => `${e.param}: ${e.message}`).join('; ');
        throw new Error(`Parametri invalidi: ${msgs}`);
      }
    }

    // Validazione maxRowsPerRun
    if (args.patch.maxRowsPerRun !== undefined) {
      if (
        !Number.isInteger(args.patch.maxRowsPerRun) ||
        args.patch.maxRowsPerRun < 1 ||
        args.patch.maxRowsPerRun > 100_000
      ) {
        throw new Error('maxRowsPerRun deve essere intero tra 1 e 100.000');
      }
    }

    // Garantisci esistenza di una RuleConfig persistita PRIMA di chiamare patch
    let existing = await this.configRepo.get(args.ruleId, args.tenantId);
    if (!existing) {
      existing = this.defaultConfigFor(rule, args.tenantId);
      await this.configRepo.upsert(existing);
    }
    const result = await this.configRepo.patch(
      args.ruleId,
      args.tenantId,
      args.patch,
      args.updatedBy,
    );

    await this.audit.emit({
      tenantId: args.tenantId,
      action: 'janitor.rule_config.patched',
      resourceType: 'janitor_rule_config',
      resourceId: args.ruleId,
      ...(args.updatedBy !== undefined ? { actorId: args.updatedBy } : {}),
      metadata: { changedFields: Object.keys(args.patch) },
    });
    return result;
  }

  async resetToDefault(ruleId: string, tenantId: string, updatedBy?: string): Promise<RuleConfig> {
    const rule = this.registry.get(ruleId);
    if (!rule) throw new Error(`Rule "${ruleId}" non trovata`);
    await this.configRepo.delete(ruleId, tenantId);
    await this.audit.emit({
      tenantId,
      action: 'janitor.rule_config.reset',
      resourceType: 'janitor_rule_config',
      resourceId: ruleId,
      ...(updatedBy !== undefined ? { actorId: updatedBy } : {}),
    });
    return this.defaultConfigFor(rule, tenantId);
  }

  private defaultConfigFor(rule: Rule, tenantId: string): RuleConfig {
    if (rule.kind === 'code') return defaultsForCodeRule(rule, tenantId);
    // DSL rule
    return makeDefaultRuleConfig({
      ruleId: rule.id,
      tenantId,
      defaultSchedule: rule.defaultSchedule,
      defaultDataSource: rule.dataSourceRef,
      defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
      defaultSeverity: rule.defaultSeverity,
      defaultParams: Object.freeze({}),
    });
  }
}

function defaultsForCodeRule(rule: CodeRule, tenantId: string): RuleConfig {
  const defaultParams: Record<string, unknown> = {};
  for (const p of rule.paramsSchema) defaultParams[p.name] = p.default;
  return makeDefaultRuleConfig({
    ruleId: rule.id,
    tenantId,
    defaultSchedule: rule.defaultSchedule,
    defaultDataSource: rule.defaultDataSource,
    defaultMaxRowsPerRun: rule.defaultMaxRowsPerRun,
    defaultSeverity: rule.defaultSeverity,
    defaultParams: Object.freeze(defaultParams),
  });
}
