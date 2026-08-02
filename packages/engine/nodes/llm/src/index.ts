/**
 * @medea/engine-nodes-llm — AI provider nodes for workflows.
 *
 * Each node is BYO API key (X-LLM-API-Key header or `apiKey` config field).
 * FlowForge never proxies LLM credentials.
 *
 * Providers shipped in v0.1:
 *   - Anthropic (Claude family)
 *   - OpenAI (GPT family)
 *   - Google Gemini
 *   - OpenRouter (multi-provider aggregator)
 *   - Ollama (local-only, baseUrl-configured)
 */

import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import {
  safeFetchWithRedirects,
  readJsonCapped,
  readTextTruncated,
} from '@medea/engine-safe-fetch';

const PROVIDER_TIMEOUT_MS = 60_000; // LLM call può richiedere ~30-50s (long context)

/** Estratto d'errore anti-OOM: tronca a 8KB durante lo streaming (un endpoint
 *  rotto può rispondere con un body enorme), poi accorcia a 300 char per il msg.
 *  `(await res.text()).slice(0, 300)` leggeva PRIMA tutto il body in RAM → OOM. */
async function errBody(res: Response): Promise<string> {
  return (await readTextTruncated(res, 8192)).text.slice(0, 300);
}

/**
 * Gateway unico per chiamate provider LLM (Anthropic/OpenAI/Gemini/OpenRouter/Ollama).
 *
 * Audit consulente 2026-06-04: questi 5 fetch erano nudi → un provider giù
 * (OpenAI overloaded, rate-limit anthropic) faceva appendere la run del
 * workflow per minuti senza timeout. Pattern unificato gateway:
 *   - safeFetchWithRedirects (SSRF guard + max 5 redirect + cross-host
 *     Authorization strip + timeout 60s AbortSignal)
 *   - executeWithHostBreaker (5 fail → 30s open + HALF_OPEN probe per host)
 *   - allowDockerNet=true SOLO per Ollama (loopback config server, no
 *     user-controlled URL)
 */
async function gatewayFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    allowDockerNet?: boolean;
    allowedHosts?: readonly string[];
  },
): Promise<Response> {
  return executeWithHostBreaker(url, () => {
    const opts: Parameters<typeof safeFetchWithRedirects>[1] = {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      ...(init.allowDockerNet ? { allowDockerNet: true } : {}),
      // Esenzione SSRF per host esatto (loopback/IP-privato by-design, es. ollama locale).
      ...(init.allowedHosts ? { allowedHosts: init.allowedHosts } : {}),
    };
    return safeFetchWithRedirects(url, opts);
  });
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await gatewayFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${String(res.status)}: ${await errBody(res)}`);
  const data = await readJsonCapped<{ content?: { type: string; text?: string }[] }>(res);
  return (
    data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('') ?? ''
  );
}

async function callOpenAI(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await gatewayFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${String(res.status)}: ${await errBody(res)}`);
  const data = await readJsonCapped<{ choices?: { message: { content: string } }[] }>(res);
  return data.choices?.[0]?.message.content ?? '';
}

async function callGemini(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  // API key nell'HEADER `x-goog-api-key`, NON in query string: una key nell'URL
  // (a) finisce nei log/breaker-key e (b) su redirect cross-host NON viene strippata
  // (lo strip vale per l'header Authorization, non per la query) → leak credenziale.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await gatewayFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${String(res.status)}: ${await errBody(res)}`);
  const data = await readJsonCapped<{ candidates?: { content: { parts: { text: string }[] } }[] }>(
    res,
  );
  return data.candidates?.[0]?.content.parts.map((p) => p.text).join('') ?? '';
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await gatewayFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://flowforge.dev',
      'X-Title': 'FlowForge',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${String(res.status)}: ${await errBody(res)}`);
  const data = await readJsonCapped<{ choices?: { message: { content: string } }[] }>(res);
  return data.choices?.[0]?.message.content ?? '';
}

async function callOllama(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  // Ollama spesso loopback (localhost:11434) → allowDockerNet non esenta il loopback;
  // esenzione per host esatto (baseUrl da config/env di sistema, non payload utente).
  const ollamaHost = ((): string => {
    try {
      return new URL(baseUrl).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const res = await gatewayFetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    allowDockerNet: true,
    ...(ollamaHost ? { allowedHosts: [ollamaHost] } : {}),
  });
  if (!res.ok) throw new Error(`Ollama ${String(res.status)}: ${await errBody(res)}`);
  const data = await readJsonCapped<{ message?: { content?: string } }>(res);
  return data.message?.content ?? '';
}

function makeProviderExecutor(providerId: string): NodeExecutor {
  return async (config, input, _context) => {
    const start = Date.now();
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
    // customModel (free-text override) wins over `model` (curated select).
    const customModel = typeof config.customModel === 'string' ? config.customModel.trim() : '';
    const selectModel = typeof config.model === 'string' ? config.model : '';
    const model = customModel || selectModel;
    const system =
      typeof config.systemPrompt === 'string'
        ? config.systemPrompt
        : 'You are a helpful assistant.';
    const userPrompt = typeof config.prompt === 'string' ? config.prompt : '';
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : 'http://localhost:11434';
    const finalUser = userPrompt.includes('{{input}}')
      ? userPrompt.replace(
          /\{\{input\}\}/g,
          typeof input === 'string' ? input : JSON.stringify(input ?? ''),
        )
      : userPrompt || (typeof input === 'string' ? input : JSON.stringify(input));

    let text: string;
    switch (providerId) {
      case 'anthropic':
        text = await callAnthropic(apiKey, model || 'claude-sonnet-4-5', system, finalUser);
        break;
      case 'openai':
        text = await callOpenAI(apiKey, model || 'gpt-4o-mini', system, finalUser);
        break;
      case 'gemini':
        text = await callGemini(apiKey, model || 'gemini-2.0-flash', system, finalUser);
        break;
      case 'openrouter':
        text = await callOpenRouter(
          apiKey,
          model || 'anthropic/claude-sonnet-4.5',
          system,
          finalUser,
        );
        break;
      case 'ollama':
        text = await callOllama(baseUrl, model || 'llama3.2', system, finalUser);
        break;
      default:
        throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    return { output: { text, model, provider: providerId }, durationMs: Date.now() - start };
  };
}

// Curated per-provider model lists. We expose a `select` of well-known
// models PLUS a `customModel` text override for users who need a specific
// fine-tuned model or a brand-new release. Keeps the common path idiot-proof
// while not handcuffing power users.
const MODEL_PRESETS: Record<
  string,
  { default: string; options: string[]; help: string; docs: string; blurb: string }
> = {
  anthropic: {
    default: 'claude-sonnet-4-5',
    options: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    help: 'Opus = potenza massima (costoso). Sonnet = bilanciato (default). Haiku = economico, veloce.',
    docs: 'docs.anthropic.com/en/docs/about-claude/models',
    blurb:
      "Claude (Anthropic) eccelle nel ragionamento complesso, nell'analisi di documenti lunghi (fino a ~200K token di contesto), nello scrivere e nel seguire istruzioni articolate restituendo output strutturato affidabile: è il riferimento per agenti, estrazione dati e classificazione di qualità dove la precisione conta più del costo.",
  },
  openai: {
    default: 'gpt-4o-mini',
    options: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    help: 'gpt-4o = top quality. gpt-4o-mini = veloce/economico (default). gpt-3.5-turbo = legacy.',
    docs: 'platform.openai.com/docs/models',
    blurb:
      'GPT (OpenAI) è il modello generalista più diffuso, ottimo per chat, generazione di testo, function calling e con il più vasto ecosistema di tooling: gpt-4o-mini offre il miglior rapporto costo/qualità per volumi alti, gpt-4o la qualità di punta quando serve il massimo.',
  },
  gemini: {
    default: 'gemini-2.0-flash',
    options: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    help: 'gemini-2.0-flash = nuovo, veloce (default). 1.5-pro = qualità più alta.',
    docs: 'ai.google.dev/gemini-api/docs/models',
    blurb:
      "Gemini (Google) è forte sul multimodale e sul contesto molto lungo (fino a 1-2M token) ed è ben integrato nell'ecosistema Google: flash è economico e velocissimo per classificazione e riassunti su grandi volumi, 1.5-pro alza la qualità quando il compito è impegnativo.",
  },
  openrouter: {
    default: 'anthropic/claude-sonnet-4.5',
    options: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o',
      'meta-llama/llama-3.1-70b-instruct',
      'mistralai/mistral-large',
    ],
    help: 'OpenRouter dà accesso a 100+ modelli con una sola key. Formato: vendor/model.',
    docs: 'openrouter.ai/docs/models',
    blurb:
      'OpenRouter è un aggregatore: con UNA sola API key accedi a 100+ modelli di decine di vendor (Anthropic, OpenAI, Meta Llama, Mistral, Google e altri) usando il formato vendor/model, con routing automatico, fallback e prezzi trasparenti — ideale per confrontare modelli, ottimizzare costi o evitare il lock-in su un singolo provider.',
  },
  ollama: {
    default: 'llama3.2',
    options: ['llama3.2', 'llama3.1:70b', 'mistral', 'mixtral', 'qwen2.5:14b', 'phi3'],
    help: 'Modelli devi averli pull-ati localmente con `ollama pull <nome>` prima.',
    docs: 'ollama.com/library',
    blurb:
      "Ollama esegue i modelli IN LOCALE (on-premise) senza inviare un solo byte a servizi terzi: massima privacy e zero costo per-token, a patto di avere l'hardware adeguato — la scelta giusta per dati sensibili (sanitari, legali, PII) che per policy o GDPR non devono lasciare la tua infrastruttura.",
  },
};

// Blocco comune (gateway enterprise) — accodato a ogni provider per portare tutte
// le descrizioni allo standard "opera d'arte" con configurazione e use case espliciti.
const LLM_COMMON_BLURB =
  'Configurazione interamente in UI e a prova di idiota: modello da dropdown (con campo "override" per modelli custom/fine-tuned o appena rilasciati), system prompt opzionale per fissare ruolo, tono e FORMATO della risposta (es. "rispondi solo con JSON"), e prompt utente come espressione interpolabile con i dati degli step precedenti ({{$node.x.json...}}). La chiave è BYOK (Bring Your Own Key) e transita cifrata: il gateway LLM di FlowForge instrada la chiamata con circuit breaker per-provider (un provider giù non blocca gli altri) e contabilizzazione dei consumi. Output strutturato { text, model, provider } pronto per i nodi a valle. ' +
  'Use case: classificazione di email/ticket, estrazione di campi da testo libero, generazione di risposte e contenuti, riassunti, arricchimento dati e routing intelligente in un workflow agentico.';

function makeLlmNode(id: string, providerId: string, label: string, color: string): NodeModule {
  const preset = MODEL_PRESETS[providerId] ?? {
    default: '',
    options: [],
    help: '',
    docs: '',
    blurb: '',
  };
  const credentialField =
    providerId === 'ollama'
      ? {
          key: 'baseUrl',
          label: 'Ollama base URL',
          type: 'text' as const,
          required: true,
          placeholder: 'http://localhost:11434',
          defaultValue: 'http://localhost:11434',
          help: 'URL del server Ollama. Default localhost:11434 (Ollama installato sulla stessa macchina del runtime).',
        }
      : {
          key: 'apiKey',
          label: 'API key',
          type: 'secret' as const,
          required: true,
          help: `Chiave API del provider ${label}. Vai su ${preset.docs} per i dettagli.`,
        };

  return {
    def: {
      id,
      type: 'ai',
      label,
      icon: 'sparkles',
      color,
      description: `Chiama ${label} dai tuoi workflow con la tua API key (BYOK). ${preset.help} ${preset.blurb} ${LLM_COMMON_BLURB}`,
      configFields: [
        credentialField,
        {
          key: 'model',
          label: 'Modello',
          type: 'select',
          required: false,
          options: preset.options,
          defaultValue: preset.default,
          help: `${preset.help} Docs: ${preset.docs}`,
        },
        {
          key: 'customModel',
          label: 'Modello custom (override)',
          type: 'text',
          required: false,
          placeholder: 'es. claude-opus-4-1-20250805',
          help: 'Se hai bisogno di un modello specifico non in lista (fine-tuned, version pinned), mettilo qui. Sovrascrive il select sopra.',
        },
        {
          key: 'systemPrompt',
          label: 'System prompt (opzionale)',
          type: 'expression',
          required: false,
          placeholder: 'Sei un assistente esperto di...',
          help: 'Istruzioni "di sistema" date al modello (tono, ruolo, regole). Non vede il system prompt nel chat history, lo segue come direttiva.',
        },
        {
          key: 'prompt',
          label: 'Prompt utente',
          type: 'expression',
          required: true,
          placeholder: 'Riassumi questo testo: {{input.text}}',
          help: 'Il prompt vero e proprio. Usa {{input}} per il valore dal nodo precedente, {{$node.X.json.field}} per specifici nodi.',
        },
      ],
      vendor: 'flowforge',
      version: '1.1.0',
    },
    executor: makeProviderExecutor(providerId),
  };
}

export const aiAnthropicNode = makeLlmNode(
  'ai_anthropic',
  'anthropic',
  'AI: Anthropic Claude',
  '#cc7855',
);
export const aiOpenAINode = makeLlmNode('ai_openai', 'openai', 'AI: OpenAI GPT', '#74aa9c');
export const aiGeminiNode = makeLlmNode('ai_gemini', 'gemini', 'AI: Google Gemini', '#4285f4');
export const aiOpenRouterNode = makeLlmNode(
  'ai_openrouter',
  'openrouter',
  'AI: OpenRouter (100+ models)',
  '#a855f7',
);
export const aiOllamaNode = makeLlmNode('ai_ollama', 'ollama', 'AI: Ollama (local)', '#22c55e');

export const llmNodes: readonly NodeModule[] = [
  aiAnthropicNode,
  aiOpenAINode,
  aiGeminiNode,
  aiOpenRouterNode,
  aiOllamaNode,
] as const;
