/**
 * LlmResolverService — single source of truth for "which LLM provider should
 * we use for this tenant?"
 *
 * Before this service existed, the resolution logic was duplicated across:
 *   • routes/ai-assistant.ts      (chat for the editor side-panel)
 *   • routes/runs-history.ts      (run-explain endpoint)
 *   • routes/help-chat.ts         (in-app help)
 *   • packages/nodes/ai-agents/   (per-node executor)
 *
 * Four copies of "pick the first configured provider, fall back to Liara
 * if globally + per-tenant enabled" is exactly the bug surface a senior
 * reviewer flags first ("DRY this"). When a fix is needed (e.g. add a new
 * provider to the chain, change the order, honor a new opt-out flag), four
 * places must change in sync. They WON'T stay in sync.
 *
 * This service consolidates the logic. Every callsite that needs an LLM
 * provider for a tenant call `resolveLlmProvider(tenantId, options)`.
 *
 * Resolution order (consistent with what we had before):
 *   1. Explicit override:    callsite passed `requestedProvider` AND its key
 *                              is configured                       → use it
 *   2. Explicit + fallback:  callsite passed `requestedProvider` but no key  →
 *                              load the key from Settings; fail if missing
 *   3. Auto-pick:            no provider specified                 → iterate
 *                              preferenceOrder, first with credentials wins.
 *                              Liara is included ONLY if globally enabled +
 *                              tenant-allowed.
 *   4. No provider available:                                      → return
 *                              a `NoProviderAvailableError` with clear msg.
 *
 * Inputs are validated with Zod-style runtime guards. Output is a fully
 * resolved descriptor the dispatcher can use directly.
 */

import { LlmProvidersService, type LlmProvider } from './llm-providers.service.js';
import { isLiaraAllowedForTenant, tenantAiPreferences } from './tenant-ai-preferences.service.js';
import { isKnownProvider } from './llm/provider-registry.js';

// NB (2026-06-18): la vecchia `BASE_PREFERENCE_ORDER` locale è stata RIMOSSA.
// L'ordine di auto-pick e la scelta del default sono ora delegati a
// `tenantAiPreferences.resolveDefaultProvider` (la STESSA funzione del branding),
// che itera i provider configurati nell'ordine di `LlmProvidersService.list()`
// (= SSOT `SUPPORTED_PROVIDERS`). Niente più lista d'ordine duplicata e
// potenzialmente divergente qui.

export interface ResolvedLlm {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** Optional base URL — only set for ollama / liara / self-hosted. */
  baseUrl?: string;
}

export interface ResolveOptions {
  /** Caller's explicit choice (from request body, env override, etc). */
  requestedProvider?: string;
  /** BYO key from HTTP header (legacy "X-LLM-API-Key" pattern). */
  headerApiKey?: string;
}

/**
 * Thrown when no LLM provider is available for the tenant — either nothing
 * is configured AND Liara is disabled, OR the requested provider has no key.
 * Carries the human-readable message the HTTP layer can send back as 401/403.
 */
export class NoLlmProviderError extends Error {
  /**
   * httpStatus values:
   *  - 401: no API key configured (default)
   *  - 402: quota exceeded (Payment Required)
   *  - 403: provider available ma forbidden (e.g. plan gating)
   */
  constructor(message: string, public readonly httpStatus: 401 | 402 | 403 = 401) {
    super(message);
    this.name = 'NoLlmProviderError';
  }
}

/** Provider valido = noto al provider-registry (SSOT, alias inclusi). Niente più
 *  lista locale divergente (era la fonte del bug grok/deepseek). */
function isSupportedProvider(p: string): p is LlmProvider {
  return isKnownProvider(p);
}

export class LlmResolverService {
  private readonly providers = new LlmProvidersService();

  resolve(tenantId: string, options: ResolveOptions = {}): ResolvedLlm {
    const requested = (options.requestedProvider ?? '').trim();
    const headerKey = (options.headerApiKey ?? '').trim();

    // ── (1) Explicit provider + explicit header key (BYO mode) ──────────
    if (requested && isSupportedProvider(requested) && headerKey) {
      return { provider: requested, apiKey: headerKey, model: '' };
    }

    // ── (2) Legacy: only header key (assume anthropic) ──────────────────
    if (!requested && headerKey) {
      return { provider: 'anthropic', apiKey: headerKey, model: '' };
    }

    // ── (3) Explicit provider, pull key from tenant Settings ────────────
    if (requested && isSupportedProvider(requested)) {
      const stored = this.providers.get(tenantId, requested);
      if (!stored) {
        throw new NoLlmProviderError(
          `Provider "${requested}" non configurato. Vai in Settings → AI Providers e aggiungi una API key.`,
        );
      }
      // Liara can still be denied at this point if env/tenant flag is off —
      // get() already returns null for liara when disabled, so we wouldn't
      // reach here. But be defensive: check the actual allow flag.
      if (requested === 'liara' && !isLiaraAllowedForTenant(tenantId)) {
        throw new NoLlmProviderError(
          'Liara è disabilitata (a livello istanza o per questo tenant). Configura un altro provider in Settings → AI Providers.',
          403,
        );
      }
      const resolved: ResolvedLlm = {
        provider: requested,
        apiKey: stored.apiKey,
        model: stored.defaultModel ?? '',
      };
      if (stored.baseUrl) resolved.baseUrl = stored.baseUrl;
      return resolved;
    }

    // ── (4) Auto-pick — STESSA fonte di verità del branding ─────────────
    //
    // ⛔ FIX 2026-06-18 (incident owner "risponde Claude ma mostra Liara"):
    // PRIMA l'auto-pick scorreva BASE_PREFERENCE_ORDER (anthropic per primo) e
    // sceglieva QUALSIASI chiave BYOK configurata, IGNORANDO la preferenza
    // `defaultLlmProvider` del tenant. Risultato: chi aveva scelto Liara come
    // default ma possedeva una chiave Anthropic veniva servito da Claude in
    // silenzio (addebiti sulla chiave a pagamento), mentre l'avatar restava
    // "Liara" — perché il BRANDING usa `resolveDefaultProvider`, che la
    // preferenza la rispetta. Due resolver divergenti = bugia di provenienza.
    //
    // Ora deleghiamo la SCELTA DEL NOME allo STESSO `resolveDefaultProvider`
    // del branding: "chi risponde" coincide sempre con "chi è mostrato". La
    // chiave a pagamento si usa SOLO se l'utente l'ha scelta esplicitamente
    // (preferenza o selettore), mai come ripiego nascosto.
    const all = this.providers.getAll(tenantId);
    const liaraOk = isLiaraAllowedForTenant(tenantId);
    const configured = this.providers.list(tenantId)
      .filter((p) => p.hasKey)
      .map((p) => ({ provider: p.provider, hasKey: true }));
    const chosen = tenantAiPreferences.resolveDefaultProvider(tenantId, configured);

    if (!chosen || !isSupportedProvider(chosen)) {
      throw new NoLlmProviderError(
        liaraOk
          ? 'Nessun provider LLM configurato. Vai in Settings → AI Providers e aggiungi almeno una API key (o usa il free tier Liara/Ollama).'
          : 'Nessun provider LLM configurato e Liara è disabilitata. Configura una API key Anthropic/OpenAI/altro, oppure abilita Liara/Ollama.',
      );
    }

    // `get()` ritorna per liara { apiKey:'', baseUrl } quando abilitata, e per
    // gli esterni la chiave decifrata. resolveDefaultProvider sceglie solo
    // provider usabili → `stored` è presente; difensivo comunque.
    const stored = all[chosen];
    if (!stored) {
      throw new NoLlmProviderError(
        `Provider "${chosen}" risolto come default ma non configurato. Verifica Settings → AI Providers.`,
      );
    }
    const resolved: ResolvedLlm = {
      provider: chosen,
      apiKey: stored.apiKey,
      model: stored.defaultModel ?? '',
    };
    if (stored.baseUrl) resolved.baseUrl = stored.baseUrl;
    return resolved;
  }

  /**
   * Risolve un provider ESTERNO (BYOK, non-liara) configurato dal tenant, da
   * usare come FALLBACK quando la quota Liara è esaurita (i token BYOK non
   * contano sulla quota). Rispetta la preferenza del tenant TRA gli esterni
   * configurati; ricade sul primo se la preferenza è Liara/non risolvibile.
   * Ritorna `null` se il tenant non ha alcuna chiave BYOK → il chiamante
   * applica errore chiaro / pausa.
   */
  resolveExternalFallback(tenantId: string): ResolvedLlm | null {
    const externalConfigured = this.providers.list(tenantId)
      .filter((p) => p.hasKey && p.provider !== 'liara')
      .map((p) => ({ provider: p.provider, hasKey: true }));
    const first = externalConfigured[0];
    if (!first) return null;

    const preferred = tenantAiPreferences.resolveDefaultProvider(tenantId, externalConfigured);
    const pick = preferred && preferred !== 'liara' && isSupportedProvider(preferred)
      ? preferred
      : first.provider;

    const stored = this.providers.getAll(tenantId)[pick];
    if (!stored) return null;
    const resolved: ResolvedLlm = {
      provider: pick,
      apiKey: stored.apiKey,
      model: stored.defaultModel ?? '',
    };
    if (stored.baseUrl) resolved.baseUrl = stored.baseUrl;
    return resolved;
  }
}

/** Convenience singleton — the service is stateless. */
export const llmResolver = new LlmResolverService();
