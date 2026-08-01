/**
 * TenantAiPreferencesService — per-tenant AI provider preferences.
 *
 * Today's only setting is `allowLiara`. Designed for additions later
 * (preferredDefaultProvider, disabledProviders[], rateLimit per provider).
 *
 * Two-tier enforcement (intentional):
 *   1. Global env `FLOWFORGE_DISABLE_LIARA=true` — set by sysops, applies
 *      to the entire instance. Cannot be overridden from UI.
 *   2. Per-tenant `allow_liara=0` — set by tenant admin in Settings UI.
 *      Only narrows further; cannot re-enable Liara when the global is off.
 *
 * Helper `isLiaraAllowedForTenant(tenantId)` returns the AND of both.
 * All callsites that previously called `isLiaraEnabled()` and need to be
 * tenant-aware should switch to this helper.
 */

import { getDatabase } from '@/storage/db.js';
import { isLiaraEnabled } from '@/config.js';

export interface TenantAiPreferences {
  allowLiara: boolean;
  /**
   * The provider name the tenant has chosen as default for scaffold-generated
   * `agent_*` nodes. When set, the AI scaffold MUST use this provider for every
   * agent node and never guess from training data. `null` = no explicit
   * preference → fallback chain (first configured provider, then liara).
   */
  defaultLlmProvider: string | null;
}

export class TenantAiPreferencesService {
  /** Returns the per-tenant preferences row (defaults applied). */
  get(tenantId: string): TenantAiPreferences {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT allow_liara, default_llm_provider FROM tenant_ai_preferences WHERE tenant_id = ?')
      .get(tenantId) as { allow_liara: number; default_llm_provider: string | null } | undefined;
    if (!row) return { allowLiara: true, defaultLlmProvider: null };
    return {
      allowLiara: row.allow_liara === 1,
      defaultLlmProvider: row.default_llm_provider && row.default_llm_provider.trim().length > 0
        ? row.default_llm_provider
        : null,
    };
  }

  /** Upsert the tenant's preferences. */
  set(tenantId: string, prefs: Partial<TenantAiPreferences>): void {
    const current = this.get(tenantId);
    const next: TenantAiPreferences = {
      allowLiara: prefs.allowLiara ?? current.allowLiara,
      defaultLlmProvider: prefs.defaultLlmProvider !== undefined
        ? prefs.defaultLlmProvider
        : current.defaultLlmProvider,
    };
    const { sqlite } = getDatabase();
    sqlite
      .prepare(`
        INSERT INTO tenant_ai_preferences (tenant_id, allow_liara, default_llm_provider, updated_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(tenant_id) DO UPDATE SET
          allow_liara = excluded.allow_liara,
          default_llm_provider = excluded.default_llm_provider,
          updated_at = excluded.updated_at
      `)
      .run(tenantId, next.allowLiara ? 1 : 0, next.defaultLlmProvider);
  }

  /**
   * Effective Liara enablement for the given tenant.
   * Two-tier AND: global env must allow it AND tenant must allow it.
   * Either layer can independently say "no".
   */
  isLiaraAllowedForTenant(tenantId: string): boolean {
    if (!isLiaraEnabled()) return false;
    return this.get(tenantId).allowLiara;
  }

  /**
   * The provider name the scaffold MUST use for `agent_*` nodes, given:
   *   1. The tenant's explicit `defaultLlmProvider` (if set and the provider
   *      has a key configured — Liara is always considered "configured" when
   *      `isLiaraAllowedForTenant` returns true).
   *   2. First configured external provider (anthropic/openai/google/…).
   *   3. Liara, if the tenant allows it.
   *   4. `null` — caller MUST surface a clear error to the user instead of
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
    const liaraOk = this.isLiaraAllowedForTenant(tenantId);

    // Build the set of providers that are usable RIGHT NOW.
    // ⛔ liara è governato SOLO da liaraOk (allowLiara tenant + abilitazione
    // globale), MAI da hasKey: il free-tier ha sempre hasKey=true, quindi
    // includerlo nel loop lo renderebbe "usable" anche quando il tenant ha
    // DISATTIVATO liara → un default=liara verrebbe onorato pur essendo spento
    // (bug 2026-06-17: effectiveDefault=liara con liaraEffective=false).
    const usable = new Set<string>();
    for (const p of configuredProviders) {
      if (p.provider === 'liara') continue; // usabilità liara = liaraOk, sotto
      if (p.hasKey) usable.add(p.provider);
    }
    if (liaraOk) usable.add('liara');

    // (1) explicit tenant preference — only honored if still usable.
    if (prefs.defaultLlmProvider && usable.has(prefs.defaultLlmProvider)) {
      return prefs.defaultLlmProvider;
    }
    // (2) first external provider with a key (deterministic order via input).
    for (const p of configuredProviders) {
      if (p.hasKey && p.provider !== 'liara') return p.provider;
    }
    // (3) liara fallback.
    if (liaraOk) return 'liara';
    // (4) nothing.
    return null;
  }
}

/** Module-level singleton for convenience. */
export const tenantAiPreferences = new TenantAiPreferencesService();

/** Standalone helper for callsites that don't want to instantiate. */
export function isLiaraAllowedForTenant(tenantId: string): boolean {
  return tenantAiPreferences.isLiaraAllowedForTenant(tenantId);
}
