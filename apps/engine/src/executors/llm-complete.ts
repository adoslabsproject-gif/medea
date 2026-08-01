/**
 * action_llm_complete — wrapper enterprise sopra dispatchLLMChat.
 *
 * Espone una API "single prompt + system + temperature + maxTokens" senza
 * costringere l'utente a setup history conversazionali. Per casi più complessi
 * (history, tool use, streaming) usare gli `agent_*` specifici.
 *
 * Provider:
 *   - liara (default) = Qwen3 32B self-hosted ZeliAI, gratis
 *   - anthropic/openai/gemini/mistral/groq/openrouter/deepseek/xai/perplexity = BYOK
 *
 * Output:
 *   {
 *     completion: string,
 *     model: string,
 *     provider: string,
 *     tokensUsed: { prompt, completion, total },  // LEGACY (pre Fase 1b), non rimuovere: workflow esistenti lo referenziano
 *     _llm: { inputTokens, outputTokens, model, provider, fromApi },  // campo usage STANDARD cross-nodo (Fase 1b #13)
 *     responseFormat: 'text'|'json',
 *     jsonParsed?: unknown    // popolato se responseFormat=json E parse ok
 *     finishReason: 'stop'|'length'|'error'
 *   }
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { logLlmExchange } from '@flowforge/nodes-stdlib';
import type { AgentLlmUsage } from '@flowforge/nodes-ai-agents';
import { dispatchLLMChat, LlmQuotaExceededError, type LlmTokenUsage } from '@/services/llm-chat.service.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';

interface LlmCompleteOutput {
  completion: string;
  model: string;
  provider: string;
  /** LEGACY: shape storica di questo nodo. Duplicata in `_llm` (standard cross-nodo); rimuovibile solo con migration dei workflow. */
  tokensUsed: { prompt: number; completion: number; total: number; fromApi: boolean };
  /** Usage standard cross-nodo (stesso shape degli agent_*, letto dalla card del pannello nodo in Fase 4). */
  _llm: AgentLlmUsage;
  responseFormat: 'text' | 'json';
  jsonParsed?: unknown;
  finishReason: 'stop' | 'length' | 'error';
  /**
   * Presente quando lo step ha degradato per quota esaurita: 'byok-fallback'
   * = quota Liara esaurita → rieseguito con la chiave BYOK del tenant. Esplicito
   * (mai swap nascosto): l'utente vede che il provider è cambiato.
   */
  degraded?: 'byok-fallback';
}

// Provider realmente gestiti dal gateway per action_llm_complete. Esportato per il
// test anti-drift (deve combaciare col configField `provider` del nodo in stdlib).
export const ALLOWED_PROVIDERS = new Set(['liara', 'anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'deepseek', 'xai', 'perplexity']);

const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  liara: '',                              // Liara backend decide (qwen3-32b)
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-sonnet-4',
  deepseek: 'deepseek-chat',
  xai: 'grok-2-latest',
  perplexity: 'sonar',
};

export const llmCompleteExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const cfg = config;

  const prompt = coerceString(cfg.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('action_llm_complete: "prompt" è obbligatorio');
  }
  const systemPrompt = coerceString(cfg.systemPrompt ?? '').trim();
  const providerHint = coerceString(cfg.provider ?? 'liara').trim().toLowerCase();
  const allowed = ALLOWED_PROVIDERS.has(providerHint) ? providerHint : 'liara';
  const modelHint = coerceString(cfg.model ?? '').trim();
  // temperature: clampata a [0,2] e passata a dispatchLLMChat via opts.temperature
  // (rispettata sia dal ramo Liara sia dai provider openai-compat). Prima era
  // documentata nell'UI ma IGNORATA (0.2 hardcoded per Liara) — fix 2026-07.
  const temperatureRaw = Number(cfg.temperature ?? 0.7);
  const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(2, temperatureRaw)) : 0.7;
  const maxTokensRaw = Number(cfg.maxTokens ?? 2048);
  const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
    ? Math.min(Math.floor(maxTokensRaw), 32_768)
    : 2048;
  const responseFormat: 'text' | 'json' = coerceString(cfg.responseFormat ?? 'text') === 'json' ? 'json' : 'text';
  const timeoutMsRaw = Number(cfg.timeoutMs ?? 60_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? Math.min(Math.floor(timeoutMsRaw), 300_000)
    : 60_000;

  // Provider resolution:
  //   - liara: nessuna API key (lic key del container fa da auth via portal gateway)
  //   - BYOK (anthropic/openai/...): llmResolver.resolve(tenantId) restituisce
  //     ResolvedLlm = { provider, apiKey, model, baseUrl? } leggendo dal
  //     vault tenant. Se config.provider != quello configurato dal tenant,
  //     lo ignoriamo silently (rispettiamo le preferences platform).
  let provider = allowed;
  let apiKey = '';
  let model = modelHint || PROVIDER_DEFAULT_MODEL[provider] || '';
  let baseUrl: string | undefined;
  if (provider !== 'liara') {
    try {
      const resolved = llmResolver.resolve(context.tenantId, { requestedProvider: providerHint });
      provider = resolved.provider;
      apiKey = resolved.apiKey;
      if (!modelHint && resolved.model) model = resolved.model;
      if (resolved.baseUrl) baseUrl = resolved.baseUrl;
    } catch (err) {
      if (err instanceof NoLlmProviderError) {
        throw new Error(`action_llm_complete: provider "${providerHint}" richiede API key configurata in Settings → AI Providers (${err.message})`);
      }
      throw err;
    }
  }

  // Forza JSON nel system prompt quando responseFormat=json — pattern
  // industriale (OpenAI/Anthropic structured output): istruzione esplicita
  // di rispondere SOLO con JSON valido, niente prosa attorno.
  const effectiveSystem = responseFormat === 'json'
    ? `${systemPrompt}\n\nIMPORTANTE: rispondi SOLO con un oggetto JSON valido. Niente testo prima o dopo. Niente backtick \`\`\`json\`\`\` wrapper.`
    : systemPrompt;

  // Override PER-CHIAMATA di timeout/maxTokens passati ESPLICITAMENTE a dispatchLLMChat.
  // ⛔ PRIMA: si mutava process.env.FLOWFORGE_LIARA_{TIMEOUT_MS,MAX_TOKENS} attorno
  // all'await → race tra run/nodi concorrenti nello STESSO container (A scrive, B
  // sovrascrive, A legge il valore di B; il restore nel finally si incrociava). L'env
  // è globale al processo: mai mutarlo per config per-chiamata.
  const llmOpts = { maxTokens, timeoutMs, temperature } as const;

  let completion: string;
  let usage: LlmTokenUsage = { input: 0, output: 0, fromApi: false };
  let finishReason: 'stop' | 'length' | 'error' = 'stop';
  let degraded: 'byok-fallback' | undefined;

  try {
    completion = await dispatchLLMChat(
      provider,
      apiKey,
      model,
      effectiveSystem,
      prompt,
      baseUrl, // BYOK custom endpoint (es. proxy aziendale OpenAI-compatible) o undefined per default
      [],      // history vuota — single-shot
      (u) => { usage = u; },
      undefined, // requestId
      llmOpts,
    );
  } catch (err) {
    // ── DEGRADAZIONE QUOTA: fallback BYOK ────────────────────────────────
    // Quota Liara esaurita (errore TIPIZZATO) + il tenant ha una chiave BYOK →
    // riprova con quella (i token BYOK non contano sulla quota Liara). È
    // ESPLICITO (output.degraded='byok-fallback' + provider cambiato), mai uno
    // swap nascosto su chiave a pagamento. Senza BYOK: propaga l'errore quota
    // CHIARO (la pausa-su-rinnovo è gestita a livello engine, fase successiva).
    if (provider === 'liara' && err instanceof LlmQuotaExceededError) {
      const fb = llmResolver.resolveExternalFallback(context.tenantId);
      if (!fb) {
        finishReason = 'error';
        throw err;
      }
      try {
        completion = await dispatchLLMChat(
          fb.provider,
          fb.apiKey,
          fb.model || PROVIDER_DEFAULT_MODEL[fb.provider] || '',
          effectiveSystem,
          prompt,
          fb.baseUrl,
          [],
          (u) => { usage = u; },
          undefined, // requestId
          llmOpts,
        );
        provider = fb.provider;
        model = fb.model || PROVIDER_DEFAULT_MODEL[fb.provider] || model;
        degraded = 'byok-fallback';
        finishReason = 'stop';
      } catch (fallbackErr) {
        finishReason = 'error';
        throw fallbackErr;
      }
    } else {
      finishReason = 'error';
      throw err;
    }
  }
  void temperature; // doc-only: pinned per UI consistency (vedi commento sopra)

  // Fase 3 (#15): prompt completo (system effettivo incluso) + risposta → StepLog 'llm'.
  logLlmExchange(context, {
    provider,
    model: model || `${provider}-default`,
    system: effectiveSystem,
    user: prompt,
    response: completion,
    ...(degraded ? { phase: 'byok-fallback' } : {}),
  });

  // Parse JSON output se richiesto (best-effort, no throw — il completion
  // testuale resta sempre disponibile in output.completion).
  let jsonParsed: unknown;
  if (responseFormat === 'json') {
    const cleaned = completion
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      jsonParsed = JSON.parse(cleaned) as unknown;
    } catch {
      // jsonParsed resta undefined — il caller può ispezionare output.completion grezzo
    }
  }

  // Detect finish reason: heuristic post-dispatch. Se output troncato vicino
  // al maxTokens senza punteggiatura terminale, marca 'length' invece di 'stop'.
  // Il branch 'error' è gestito dal throw sopra (mai raggiunto qui in
  // condizioni normali).
  const lastChar = completion.trim().slice(-1);
  const endsCleanly = ['.', '!', '?', '"', '}', ']', ')'].includes(lastChar);
  if (!endsCleanly && usage.output >= maxTokens * 0.95) {
    finishReason = 'length';
  }

  const output: LlmCompleteOutput = {
    completion,
    model: model || `${provider}-default`,
    provider,
    tokensUsed: {
      prompt: usage.input,
      completion: usage.output,
      total: usage.input + usage.output,
      fromApi: usage.fromApi,
    },
    _llm: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      model: model || `${provider}-default`,
      provider,
      fromApi: usage.fromApi,
    },
    responseFormat,
    ...(jsonParsed !== undefined ? { jsonParsed } : {}),
    finishReason,
    ...(degraded ? { degraded } : {}),
  };

  return { output, durationMs: Date.now() - start };
};
