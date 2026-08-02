/**
 * Port — IRuleConfigRepository.
 *
 * CRUD su `janitor_rule_configs`. La tabella è SOLO sul system DB
 * (configurazione globale del Janitor, non per-tenant-DB).
 */

import type { RuleConfig, RuleConfigPatch } from '@/services/janitor/domain/index.js';

export interface IRuleConfigRepository {
  /** Lista le config esistenti per un tenant. Default tenant='default'. */
  list(tenantId: string): Promise<readonly RuleConfig[]>;
  /** Lista TUTTE le config (cross-tenant). Solo per scheduler dispatcher. */
  listAll(): Promise<readonly RuleConfig[]>;
  /** Get o null se mai configurato dall'utente. */
  get(ruleId: string, tenantId: string): Promise<RuleConfig | null>;
  /** Insert se mancante. */
  upsert(config: RuleConfig): Promise<void>;
  /** Patch in-place — merge sui campi presenti. Throw se config inesistente. */
  patch(
    ruleId: string,
    tenantId: string,
    patch: RuleConfigPatch,
    updatedBy?: string,
  ): Promise<RuleConfig>;
  /** Delete — torna ai default della rule. */
  delete(ruleId: string, tenantId: string): Promise<void>;
}
