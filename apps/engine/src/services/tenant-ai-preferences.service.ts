/**
 * TenantAiPreferencesService — per-tenant AI provider preferences.
 *
 * Today's only setting is `defaultLlmProvider`. Designed for additions later
 * (disabledProviders[], rateLimit per provider).
 */

import { getDatabase } from '@/storage/db.js';

export interface TenantAiPreferences {
  /**
   * The provider name the tenant has chosen as default for scaffold-generated
   * `agent_*` nodes. When set, the AI scaffold MUST use this provider for every
   * agent node and never guess from training data. `null` = no explicit
   * preference → the first configured provider.
   */
  defaultLlmProvider: string | null;
}

export class TenantAiPreferencesService {
  /** Returns the per-tenant preferences row (defaults applied). */
  get(tenantId: string): TenantAiPreferences {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT default_llm_provider FROM tenant_ai_preferences WHERE tenant_id = ?')
      .get(tenantId) as { default_llm_provider: string | null } | undefined;
    if (!row) return { defaultLlmProvider: null };
    return {
      defaultLlmProvider:
        row.default_llm_provider && row.default_llm_provider.trim().length > 0
          ? row.default_llm_provider
          : null,
    };
  }

  /** Upsert the tenant's preferences. */
  set(tenantId: string, prefs: Partial<TenantAiPreferences>): void {
    const current = this.get(tenantId);
    const next: TenantAiPreferences = {
      defaultLlmProvider:
        prefs.defaultLlmProvider !== undefined
          ? prefs.defaultLlmProvider
          : current.defaultLlmProvider,
    };
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        `
        INSERT INTO tenant_ai_preferences (tenant_id, default_llm_provider, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(tenant_id) DO UPDATE SET
          default_llm_provider = excluded.default_llm_provider,
          updated_at = excluded.updated_at
      `,
      )
      .run(tenantId, next.defaultLlmProvider);
  }

  /**
   * The provider name the scaffold MUST use for `agent_*` nodes, given:
   *   1. The tenant's explicit `defaultLlmProvider`, if that provider is
   *      configured. A preference naming a provider that is not configured —
   *      or that no longer exists — is ignored, never honored blindly.
   *   2. First configured provider (deterministic order via input).
   *   3. `null` — caller MUST surface a clear error to the user instead of
   *      silently degrading.
   *
   * Pure dependency-injection: the list of configured providers is passed in
   * so this service stays UI-layer independent (no circular import with
   * LlmProvidersService).
   */
  resolveDefaultProvider(
    tenantId: string,
    configuredProviders: readonly { provider: string; hasKey: boolean }[],
  ): string | null {
    const prefs = this.get(tenantId);
    const usable = configuredProviders.filter((p) => p.hasKey).map((p) => p.provider);

    if (prefs.defaultLlmProvider && usable.includes(prefs.defaultLlmProvider)) {
      return prefs.defaultLlmProvider;
    }
    return usable[0] ?? null;
  }
}

/** Module-level singleton for convenience. */
export const tenantAiPreferences = new TenantAiPreferencesService();
