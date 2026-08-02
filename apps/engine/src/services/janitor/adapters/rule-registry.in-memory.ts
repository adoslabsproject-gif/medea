/**
 * Adapter — InMemoryRuleRegistry.
 *
 * Mantiene in RAM le code-rules (deploy-time) e le DSL rules (caricate
 * da DB al boot e su evento). Indicizzazione doppia: id → rule e
 * tenantId → set di ruleIds, così `listForTenant()` è O(1).
 *
 * Concurrency: le mutate (register/unregister) sono sincronizzate dal
 * livello applicativo — il registry stesso non ha lock perché Node.js
 * single-thread + le operazioni sono atomiche (Map.set/delete).
 */

import type { Rule, CodeRule, DslRule } from '@/services/janitor/domain/index.js';
import { isCodeRule, isValidRuleId } from '@/services/janitor/domain/index.js';
import type { IRuleRegistry } from '@/services/janitor/ports/index.js';
import type { Logger } from 'pino';

export class InMemoryRuleRegistry implements IRuleRegistry {
  private readonly rules = new Map<string, Rule>();
  private readonly tenantIndex = new Map<string, Set<string>>(); // tenantId → ruleIds (only DSL)
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  registerCodeRule(rule: CodeRule): void {
    if (!isValidRuleId(rule.id)) {
      throw new Error(
        `Invalid CodeRule id "${rule.id}" — expected pattern <scope>.<table>.<problem>`,
      );
    }
    const existing = this.rules.get(rule.id);
    if (existing?.kind === 'dsl') {
      throw new Error(`CodeRule id "${rule.id}" conflicts with existing DSL rule`);
    }
    this.rules.set(rule.id, rule);
    this.logger.info({ ruleId: rule.id, kind: 'code' }, 'Janitor rule registered');
  }

  registerDslRule(rule: DslRule): void {
    if (!isValidRuleId(rule.id)) {
      throw new Error(`Invalid DslRule id "${rule.id}" — expected dsl_<id>`);
    }
    const existing = this.rules.get(rule.id);
    if (existing?.kind === 'code') {
      throw new Error(`DslRule id "${rule.id}" conflicts with existing code rule`);
    }
    this.rules.set(rule.id, rule);
    const idx = this.tenantIndex.get(rule.tenantId) ?? new Set();
    idx.add(rule.id);
    this.tenantIndex.set(rule.tenantId, idx);
    this.logger.info(
      { ruleId: rule.id, kind: 'dsl', tenantId: rule.tenantId },
      'Janitor DSL rule registered',
    );
  }

  unregisterDslRule(ruleId: string): void {
    const r = this.rules.get(ruleId);
    if (!r || isCodeRule(r)) return; // safe: niente unregister di code rules
    this.rules.delete(ruleId);
    const idx = this.tenantIndex.get(r.tenantId);
    if (idx) {
      idx.delete(ruleId);
      if (idx.size === 0) this.tenantIndex.delete(r.tenantId);
    }
    this.logger.info({ ruleId }, 'Janitor DSL rule unregistered');
  }

  get(ruleId: string): Rule | null {
    return this.rules.get(ruleId) ?? null;
  }

  listAll(): readonly Rule[] {
    return Array.from(this.rules.values());
  }

  listForTenant(tenantId: string): readonly Rule[] {
    // Code rules: sempre visibili a tutti i tenant.
    const out: Rule[] = [];
    for (const r of this.rules.values()) {
      if (isCodeRule(r)) out.push(r);
      else if (r.tenantId === tenantId) out.push(r);
    }
    return out;
  }
}
