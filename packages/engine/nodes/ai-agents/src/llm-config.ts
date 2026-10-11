/**
 * Risoluzione provider/apiKey/model per i nodi AI (pattern "Settings → AI
 * Providers"). Modulo separato (Fase 2 #14): serve sia a index.ts (agent_*)
 * sia a tool-loop.ts — importarlo da index creerebbe un ciclo (index importa
 * tool-loop per esportare il nodo).
 *
 * Ordine di risoluzione:
 *   1. Override per-nodo (config.provider/apiKey/model/baseUrl)
 *   2. Settings tenant (context.llmProviders)
 *   3. Nessuno: si dice cosa manca. Non esiste un modello di ripiego.
 */

/**
 * Nessun provider è utilizzabile: né indicato sul nodo, né configurato dal
 * tenant. Il messaggio dice dove andare, perché arriva pari pari a chi guarda
 * l'esecuzione del workflow.
 */
export class NoLlmProviderConfiguredError extends Error {
  constructor(requested?: string) {
    super(
      requested
        ? `Il provider "${requested}" non è configurato: aggiungi la sua API key in Settings → AI Providers, oppure indicala sul nodo.`
        : 'Nessun provider LLM configurato: aggiungi una API key in Settings → AI Providers, oppure indica provider e chiave sul nodo.',
    );
    this.name = 'NoLlmProviderConfiguredError';
  }
}

export interface ResolvedLlmConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export function resolveLlmConfig(
  config: Record<string, unknown>,
  llmProviders?: Record<string, { apiKey: string; defaultModel?: string; baseUrl?: string }>,
): ResolvedLlmConfig {
  const overrideProvider = typeof config.provider === 'string' ? config.provider.trim() : '';
  const overrideApiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const overrideModel = typeof config.model === 'string' ? config.model.trim() : '';
  const overrideBaseUrl =
    typeof config.baseUrl === 'string' && config.baseUrl.trim() !== '' ? config.baseUrl : undefined;

  // Explicit per-node override (everything provided locally)
  if (
    overrideProvider !== '' &&
    (overrideApiKey !== '' || overrideProvider === 'ollama')
  ) {
    const out: ResolvedLlmConfig = {
      provider: overrideProvider,
      apiKey: overrideApiKey,
      model: overrideModel,
    };
    if (overrideBaseUrl !== undefined) out.baseUrl = overrideBaseUrl;
    return out;
  }

  // Per-node provider chosen, but no apiKey local → pull key from tenant settings
  if (overrideProvider !== '' && llmProviders?.[overrideProvider]) {
    const tenant = llmProviders[overrideProvider];
    const out: ResolvedLlmConfig = {
      provider: overrideProvider,
      apiKey: tenant.apiKey,
      model: overrideModel !== '' ? overrideModel : (tenant.defaultModel ?? ''),
    };
    const url = overrideBaseUrl ?? tenant.baseUrl;
    if (url) out.baseUrl = url;
    return out;
  }

  // No per-node provider → use first configured tenant provider (preference order)
  if (llmProviders) {
    const preferenceOrder = [
      'anthropic',
      'openai',
      'gemini',
      'mistral',
      'groq',
      'openrouter',
      'ollama',
    ];
    // Prima quelli noti nell'ordine di preferenza, poi qualunque altro il
    // tenant abbia configurato: un provider con la chiave non va scartato solo
    // perché manca da questa lista.
    const candidati = [
      ...preferenceOrder,
      ...Object.keys(llmProviders).filter((p) => !preferenceOrder.includes(p)),
    ];
    for (const p of candidati) {
      const tenant = llmProviders[p];
      if (tenant && (tenant.apiKey !== '' || p === 'ollama')) {
        const out: ResolvedLlmConfig = {
          provider: p,
          apiKey: tenant.apiKey,
          model: overrideModel !== '' ? overrideModel : (tenant.defaultModel ?? ''),
        };
        const url = overrideBaseUrl ?? tenant.baseUrl;
        if (url) out.baseUrl = url;
        return out;
      }
    }
  }

  // Niente da usare: lo si dice, col nome di ciò che manca.
  throw new NoLlmProviderConfiguredError(overrideProvider !== '' ? overrideProvider : undefined);
}
