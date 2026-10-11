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
 * Four copies of "pick the first configured provider" is exactly the bug
 * surface a senior reviewer flags first ("DRY this"). When a fix is needed
 * (e.g. add a new
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
 *   3. Auto-pick:            no provider specified                 → the tenant's
 *                              default if configured, else the first
 *                              provider with credentials.
 *   4. No provider available:                                      → return
 *                              a `NoProviderAvailableError` with clear msg.
 *
 * Inputs are validated with Zod-style runtime guards. Output is a fully
 * resolved descriptor the dispatcher can use directly.
 */

import { LlmProvidersService, type LlmProvider } from './llm-providers.service.js';
import { tenantAiPreferences } from './tenant-ai-preferences.service.js';
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
  /** Optional base URL — only set for ollama / self-hosted. */
  baseUrl?: string;
}

export interface ResolveOptions {
  /** Caller's explicit choice (from request body, env override, etc). */
  requestedProvider?: string;
  /** BYO key from HTTP header (legacy "X-LLM-API-Key" pattern). */
  headerApiKey?: string;
  /**
   * Indirizzo del provider, quando lo conosce solo il chiamante.
   *
   * Serve ai provider self-hosted — Ollama, un endpoint
   * OpenAI-compatibile privato — dove l'indirizzo non è una costante del
   * registry ma una scelta di chi chiama. Con la sola chiave in mano il
   * resolver tornava senza indirizzo, il dispatch usava quello di default e la
   * richiesta finiva su un host che per un motore locale non esiste:
   * «fetch failed», senza altro dettaglio.
   *
   * Vive per la durata della richiesta come la chiave: non viene salvato.
   */
  baseUrl?: string;
}

/**
 * Thrown when no LLM provider is available for the tenant — either nothing
 * is configured, OR the requested provider has no key.
 * Carries the human-readable message the HTTP layer can send back as 401/403.
 */
export class NoLlmProviderError extends Error {
  /**
   * httpStatus values:
   *  - 401: no API key configured (default)
   *  - 402: quota exceeded (Payment Required)
   *  - 403: provider available ma forbidden (e.g. plan gating)
   */
  constructor(
    message: string,
    public readonly httpStatus: 401 | 402 | 403 = 401,
  ) {
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
    const baseUrl = (options.baseUrl ?? '').trim();

    // ── (1) Explicit provider + explicit header key (BYO mode) ──────────
    if (requested && isSupportedProvider(requested) && headerKey) {
      return {
        provider: requested,
        apiKey: headerKey,
        model: '',
        ...(baseUrl ? { baseUrl } : {}),
      };
    }

    // ── (2) Legacy: only header key (assume anthropic) ──────────────────
    if (!requested && headerKey) {
      return {
        provider: 'anthropic',
        apiKey: headerKey,
        model: '',
        ...(baseUrl ? { baseUrl } : {}),
      };
    }

    // ── (3) Explicit provider, pull key from tenant Settings ────────────
    if (requested && isSupportedProvider(requested)) {
      const stored = this.providers.get(tenantId, requested);
      if (!stored) {
        throw new NoLlmProviderError(
          `Provider "${requested}" non configurato. Vai in Settings → AI Providers e aggiungi una API key.`,
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
    // ⛔ FIX 2026-06-18 (incident owner "risponde un provider, ne è mostrato
    // un altro"): PRIMA l'auto-pick scorreva BASE_PREFERENCE_ORDER (anthropic
    // per primo) e sceglieva QUALSIASI chiave configurata, IGNORANDO la
    // preferenza `defaultLlmProvider` del tenant. Risultato: chi aveva scelto
    // un default ma possedeva anche una chiave Anthropic veniva servito da
    // Claude in silenzio (addebiti su quella chiave), mentre l'avatar mostrava
    // il default — perché il BRANDING usa `resolveDefaultProvider`, che la
    // preferenza la rispetta. Due resolver divergenti = bugia di provenienza.
    //
    // Ora deleghiamo la SCELTA DEL NOME allo STESSO `resolveDefaultProvider`
    // del branding: "chi risponde" coincide sempre con "chi è mostrato".
    const all = this.providers.getAll(tenantId);
    const configured = this.providers
      .list(tenantId)
      .filter((p) => p.hasKey)
      .map((p) => ({ provider: p.provider, hasKey: true }));
    const chosen = tenantAiPreferences.resolveDefaultProvider(tenantId, configured);

    if (!chosen || !isSupportedProvider(chosen)) {
      throw new NoLlmProviderError(
        'Nessun provider LLM configurato. Vai in Settings → AI Providers e aggiungi almeno una API key.',
      );
    }

    // resolveDefaultProvider sceglie solo provider configurati → `stored` è
    // presente; difensivo comunque.
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
}

/** Convenience singleton — the service is stateless. */
export const llmResolver = new LlmResolverService();
