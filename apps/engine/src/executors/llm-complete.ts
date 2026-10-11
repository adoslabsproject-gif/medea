/**
 * action_llm_complete — wrapper enterprise sopra dispatchLLMChat.
 *
 * Espone una API "single prompt + system + temperature + maxTokens" senza
 * costringere l'utente a setup history conversazionali. Per casi più complessi
 * (history, tool use, streaming) usare gli `agent_*` specifici.
 *
 * Provider:
 *   - vuoto = quello scelto dal tenant in Settings → AI Providers
 *   - anthropic/openai/gemini/mistral/groq/openrouter/deepseek/xai/perplexity = quello,
 *     con la chiave configurata dal tenant
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
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { logLlmExchange } from '@medea/engine-nodes-stdlib';
import type { AgentLlmUsage } from '@medea/engine-nodes-ai-agents';
import { dispatchLLMChat, type LlmTokenUsage } from '@/services/llm-chat.service.js';
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
}

// Provider che action_llm_complete lascia scegliere sul nodo. Esportato per il
// test anti-drift (deve combaciare col configField `provider` del nodo in stdlib).
export const ALLOWED_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'groq',
  'openrouter',
  'deepseek',
  'xai',
  'perplexity',
]);

const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
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
  const providerHint = coerceString(cfg.provider ?? '')
    .trim()
    .toLowerCase();
  // Un nome che non è fra quelli offerti dal nodo — vuoto, o rimasto in un
  // workflow salvato quando l'elenco era un altro — vale «quello del tenant».
  const requested = ALLOWED_PROVIDERS.has(providerHint) ? providerHint : '';
  const modelHint = coerceString(cfg.model ?? '').trim();
  // temperature: clampata a [0,2] e passata a dispatchLLMChat via opts.temperature.
  const temperatureRaw = Number(cfg.temperature ?? 0.7);
  const temperature = Number.isFinite(temperatureRaw)
    ? Math.max(0, Math.min(2, temperatureRaw))
    : 0.7;
  const maxTokensRaw = Number(cfg.maxTokens ?? 2048);
  const maxTokens =
    Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? Math.min(Math.floor(maxTokensRaw), 32_768)
      : 2048;
  const responseFormat: 'text' | 'json' =
    coerceString(cfg.responseFormat ?? 'text') === 'json' ? 'json' : 'text';
  const timeoutMsRaw = Number(cfg.timeoutMs ?? 60_000);
  const timeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(Math.floor(timeoutMsRaw), 300_000)
      : 60_000;

  // Provider resolution: llmResolver.resolve(tenantId) restituisce
  // ResolvedLlm = { provider, apiKey, model, baseUrl? } leggendo dal vault del
  // tenant. Con un provider scelto sul nodo si chiede quello; senza, decide la
  // preferenza del tenant. In entrambi i casi serve una chiave configurata.
  let provider: string;
  let apiKey: string;
  let model: string;
  let baseUrl: string | undefined;
  try {
    const resolved = llmResolver.resolve(
      context.tenantId,
      requested ? { requestedProvider: requested } : {},
    );
    provider = resolved.provider;
    apiKey = resolved.apiKey;
    model = modelHint || resolved.model || PROVIDER_DEFAULT_MODEL[provider] || '';
    if (resolved.baseUrl) baseUrl = resolved.baseUrl;
  } catch (err) {
    if (err instanceof NoLlmProviderError) {
      throw new Error(
        requested
          ? `action_llm_complete: provider "${requested}" richiede API key configurata in Settings → AI Providers (${err.message})`
          : `action_llm_complete: ${err.message}`,
      );
    }
    throw err;
  }

  // Forza JSON nel system prompt quando responseFormat=json — pattern
  // industriale (OpenAI/Anthropic structured output): istruzione esplicita
  // di rispondere SOLO con JSON valido, niente prosa attorno.
  const effectiveSystem =
    responseFormat === 'json'
      ? `${systemPrompt}\n\nIMPORTANTE: rispondi SOLO con un oggetto JSON valido. Niente testo prima o dopo. Niente backtick \`\`\`json\`\`\` wrapper.`
      : systemPrompt;

  // Override PER-CHIAMATA di timeout/maxTokens passati ESPLICITAMENTE a
  // dispatchLLMChat: l'env è globale al processo, mai mutarlo per una
  // configurazione che vale per una chiamata (race tra run concorrenti).
  const llmOpts = { maxTokens, timeoutMs, temperature } as const;

  let usage: LlmTokenUsage = { input: 0, output: 0, fromApi: false };
  let finishReason: 'stop' | 'length' | 'error' = 'stop';

  const completion = await dispatchLLMChat(
    provider,
    apiKey,
    model,
    effectiveSystem,
    prompt,
    baseUrl, // endpoint configurato dal tenant per il provider, o undefined per quello fisso
    [], // history vuota — single-shot
    (u) => {
      usage = u;
    },
    llmOpts,
  );

  // Fase 3 (#15): prompt completo (system effettivo incluso) + risposta → StepLog 'llm'.
  logLlmExchange(context, {
    provider,
    model: model || `${provider}-default`,
    system: effectiveSystem,
    user: prompt,
    response: completion,
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
  };

  return { output, durationMs: Date.now() - start };
};
