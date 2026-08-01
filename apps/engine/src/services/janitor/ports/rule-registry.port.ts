/**
 * Port — IRuleRegistry.
 *
 * Registro in-memory delle code-rules (deploy con il binary) + DSL rules
 * (caricate da DB al boot e su evento). Mai mutato a runtime dopo il boot
 * — modifiche ai DSL rules → reload completo.
 */

import type { Rule, CodeRule, DslRule } from '@/services/janitor/domain/index.js';

export interface IRuleRegistry {
  registerCodeRule(rule: CodeRule): void;
  registerDslRule(rule: DslRule): void;
  unregisterDslRule(ruleId: string): void;
  get(ruleId: string): Rule | null;
  listAll(): readonly Rule[];
  listForTenant(tenantId: string): readonly Rule[];
}
