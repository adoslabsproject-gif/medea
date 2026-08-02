/**
 * provider-registry — UNICA FONTE DI VERITÀ per "come si parla con ogni provider
 * LLM": endpoint HTTP, modello di default, schema di autenticazione, formato wire
 * (OpenAI-compat / Gemini nativo / Anthropic / Ollama / embeddings) e se l'endpoint
 * accetta il tool-calling in formato OpenAI.
 *
 * PRIMA di questo modulo lo stesso mapping era duplicato — e DIVERGENTE — in:
 *   • routes/db-agent-chat.ts       (endpointFor: solo openai + fallback Liara → gemini/grok/deepseek instradati MALE)
 *   • services/llm-chat.service.ts  (mega-switch: url + default model hardcoded)
 *   • services/llm-test.service.ts  (mega-switch: url + default model hardcoded, grok/deepseek MANCANTI)
 *
 * Tre copie che NON restavano in sync (mistral-large vs mistral-small, openrouter
 * required vs claude-haiku, ecc). Questo è il bug-surface che un senior elimina
 * accentrando. Ogni consumer ora legge da qui.
 *
 * Modulo PURO: nessun accesso a config/env/db → testabile in isolamento. I provider
 * self-host (liara/ollama) hanno baseUrl dinamico fornito dal chiamante.
 *
 * @module services/llm/provider-registry
 */
import type { LlmProvider } from '../llm-providers.service.js';

/** Come è formato il body della richiesta e parsata la risposta. */
export type WireFormat = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'embeddings';

/** Come si autentica la richiesta HTTP. */
export type AuthScheme =
  | 'bearer' // Authorization: Bearer <key>  (OpenAI-compat, Mistral, Groq, Grok, DeepSeek, OpenRouter, Voyage)
  | 'gemini-query' // ?key=<key>  (Google Gemini nativo)
  | 'anthropic' // x-api-key + anthropic-version
  | 'none'; // Liara gateway / Ollama locale (nessuna key)

/** Come si determina l'URL HTTP del provider. */
export type EndpointKind = 'fixed' | 'self-host';

export interface ProviderSpec {
  format: WireFormat;
  auth: AuthScheme;
  /** Modello usato per le chat reali quando il tenant non ne specifica uno.
   *  '' = il provider ESIGE un model esplicito (es. OpenRouter, gateway multi-modello). */
  chatModel: string;
  /** Modello usato dal "Test connection" (di solito il più economico). Default: chatModel. */
  pingModel: string;
  /** true se l'endpoint accetta il formato OpenAI tool-calling (necessario per il DB-agent). */
  openAiToolCompat: boolean;
  /** Header HTTP extra fissi (es. attribution OpenRouter). */
  extraHeaders?: Readonly<Record<string, string>>;
  endpoint:
    | { kind: 'fixed'; chatUrl: string; toolUrl?: string }
    | { kind: 'self-host'; defaultBaseUrl: string; chatPath: string; toolPath: string };
}

/** Suffisso da appendere al baseUrl per i provider self-host. */
const OPENAI_PATH = '/chat/completions';

/**
 * SSOT. Una riga per provider. Cambiare un endpoint/modello QUI lo cambia ovunque.
 */
const SPECS: Readonly<Record<LlmProvider, ProviderSpec>> = {
  liara: {
    format: 'openai',
    auth: 'none',
    chatModel: '',
    pingModel: 'nha-v1',
    openAiToolCompat: true,
    // baseUrl runtime = gateway portal (MEDEA_LIARA_BASE_URL); il chiamante lo passa.
    endpoint: {
      kind: 'self-host',
      defaultBaseUrl: 'https://liara.nothumanallowed.com',
      chatPath: OPENAI_PATH,
      toolPath: OPENAI_PATH,
    },
  },
  openai: {
    format: 'openai',
    auth: 'bearer',
    chatModel: 'gpt-4o-mini',
    pingModel: 'gpt-4o-mini',
    openAiToolCompat: true,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.openai.com/v1/chat/completions' },
  },
  anthropic: {
    format: 'anthropic',
    auth: 'anthropic',
    chatModel: 'claude-3-5-haiku-latest',
    pingModel: 'claude-3-5-haiku-latest',
    openAiToolCompat: false,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.anthropic.com/v1/messages' },
  },
  gemini: {
    // Wire NATIVO Google (generateContent) per la chat semplice; per il tool-calling
    // c'è l'endpoint OpenAI-compat di Google (toolUrl, auth Bearer).
    format: 'gemini',
    auth: 'gemini-query',
    chatModel: 'gemini-2.0-flash',
    pingModel: 'gemini-2.0-flash',
    openAiToolCompat: true,
    endpoint: {
      kind: 'fixed',
      chatUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
      toolUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    },
  },
  mistral: {
    format: 'openai',
    auth: 'bearer',
    chatModel: 'mistral-large-latest',
    pingModel: 'mistral-small-latest',
    openAiToolCompat: true,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.mistral.ai/v1/chat/completions' },
  },
  groq: {
    format: 'openai',
    auth: 'bearer',
    chatModel: 'llama-3.3-70b-versatile',
    pingModel: 'llama-3.3-70b-versatile',
    openAiToolCompat: true,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.groq.com/openai/v1/chat/completions' },
  },
  grok: {
    format: 'openai',
    auth: 'bearer',
    chatModel: 'grok-2-latest',
    pingModel: 'grok-2-latest',
    openAiToolCompat: true,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.x.ai/v1/chat/completions' },
  },
  deepseek: {
    format: 'openai',
    auth: 'bearer',
    chatModel: 'deepseek-chat',
    pingModel: 'deepseek-chat',
    openAiToolCompat: true,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.deepseek.com/v1/chat/completions' },
  },
  perplexity: {
    // OpenAI-compat (api.perplexity.ai, Bearer). Sonar = chat search-augmented con
    // citazioni live. openAiToolCompat=false: Perplexity NON espone function-calling
    // → non instradabile al DB-agent (resolveToolEndpoint ritorna null = errore chiaro).
    format: 'openai',
    auth: 'bearer',
    chatModel: 'sonar',
    pingModel: 'sonar',
    openAiToolCompat: false,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.perplexity.ai/chat/completions' },
  },
  openrouter: {
    // Gateway multi-modello: NESSUN default vendor-specifico per la chat (model
    // obbligatorio "vendor/name"); il ping usa un modello economico noto.
    format: 'openai',
    auth: 'bearer',
    chatModel: '',
    pingModel: 'anthropic/claude-3-5-haiku',
    openAiToolCompat: true,
    extraHeaders: {
      'X-Title': 'FlowForge',
      'HTTP-Referer': 'https://flowforge.automazionezeli.com',
    },
    endpoint: { kind: 'fixed', chatUrl: 'https://openrouter.ai/api/v1/chat/completions' },
  },
  ollama: {
    format: 'ollama',
    auth: 'none',
    chatModel: 'llama3.2',
    pingModel: 'llama3.2',
    openAiToolCompat: true,
    // Ollama nativo: /api/chat per la chat; /v1/chat/completions (OpenAI-compat) per i tool.
    endpoint: {
      kind: 'self-host',
      defaultBaseUrl: 'http://localhost:11434',
      chatPath: '/api/chat',
      toolPath: '/v1/chat/completions',
    },
  },
  voyage: {
    format: 'embeddings',
    auth: 'bearer',
    chatModel: 'voyage-3',
    pingModel: 'voyage-3',
    openAiToolCompat: false,
    endpoint: { kind: 'fixed', chatUrl: 'https://api.voyageai.com/v1/embeddings' },
  },
};

/** Spec del provider (alias risolti; lancia su sconosciuto — fail-fast, non silenzioso). */
export function getProviderSpec(provider: string): ProviderSpec {
  const canonical = canonicalProvider(provider);
  if (!isKnownProvider(canonical)) throw new Error(`Unknown LLM provider: ${provider}`);
  return SPECS[canonical as LlmProvider];
}

/** Tutti i provider che possono fare CHAT (esclude gli embeddings-only come Voyage). */
export function chatCapableProviders(): LlmProvider[] {
  return (Object.keys(SPECS) as LlmProvider[]).filter((p) => SPECS[p].format !== 'embeddings');
}

/** Alias storici → nome canonico (es. "xai" è l'alias legacy di Grok by X.AI). */
const ALIASES: Readonly<Record<string, LlmProvider>> = { xai: 'grok' };

/** Normalizza un eventuale alias al nome canonico del provider. */
export function canonicalProvider(p: string): string {
  return ALIASES[p] ?? p;
}

/** true se l'identificatore (alias inclusi) è un provider noto al registry. */
export function isKnownProvider(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECS, canonicalProvider(p));
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

export interface ToolEndpointTarget {
  url: string;
  /** Modello da usare (richiesto dal chiamante o default del provider). */
  model: string;
  extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * Endpoint OpenAI-compat per il TOOL-CALLING (DB-agent). Ritorna `null` se il
 * provider NON è tool-compatible (anthropic nativo, voyage) → il chiamante deve
 * rispondere con un errore chiaro invece di instradare a un endpoint sbagliato.
 *
 * @param requestedModel modello scelto dal tenant ('' → default del provider)
 * @param baseUrl        per i self-host (liara/ollama); ignorato per i fixed
 */
export function resolveToolEndpoint(
  provider: LlmProvider,
  requestedModel: string,
  baseUrl?: string,
): ToolEndpointTarget | null {
  const spec = getProviderSpec(provider);
  if (!spec.openAiToolCompat) return null;
  const model = requestedModel.trim() || spec.chatModel;
  const base: ToolEndpointTarget = {
    url: '',
    model,
    ...(spec.extraHeaders ? { extraHeaders: spec.extraHeaders } : {}),
  };
  if (spec.endpoint.kind === 'self-host') {
    return {
      ...base,
      url: joinBaseUrl(baseUrl ?? spec.endpoint.defaultBaseUrl, spec.endpoint.toolPath),
    };
  }
  // fixed: gemini ha un toolUrl dedicato (OpenAI-compat di Google); gli altri usano chatUrl.
  return { ...base, url: spec.endpoint.toolUrl ?? spec.endpoint.chatUrl };
}

/**
 * Target per la CHAT/ping di un provider a endpoint FISSO con wire OpenAI-compat
 * (openai, mistral, groq, grok, deepseek, openrouter). Lo usano llm-chat e
 * llm-test per un UNICO ramo generico al posto di un case duplicato per provider.
 *
 * @param usePingModel true → modello economico del "Test connection" (pingModel)
 * @throws se il provider non ha endpoint fisso o non è wire 'openai'
 */
export function fixedOpenAiCompatTarget(
  provider: string,
  requestedModel: string,
  usePingModel = false,
): ToolEndpointTarget {
  const spec = getProviderSpec(provider); // canonicalizza alias (xai→grok) + fail-fast
  if (spec.endpoint.kind !== 'fixed' || spec.format !== 'openai') {
    throw new Error(`${provider} non è un provider OpenAI-compat a endpoint fisso`);
  }
  const model = requestedModel.trim() || (usePingModel ? spec.pingModel : spec.chatModel);
  return {
    url: spec.endpoint.chatUrl,
    model,
    ...(spec.extraHeaders ? { extraHeaders: spec.extraHeaders } : {}),
  };
}

/** I provider a endpoint fisso con wire OpenAI-compat — il ramo generico dei consumer.
 *  Alias risolti (xai→grok). Safe sugli sconosciuti (→ false). */
export function isFixedOpenAiCompat(provider: string): boolean {
  if (!isKnownProvider(provider)) return false;
  const spec = getProviderSpec(provider);
  return spec.endpoint.kind === 'fixed' && spec.format === 'openai';
}
