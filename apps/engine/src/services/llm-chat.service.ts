/**
 * Multi-provider chat dispatcher with history (used by the AI Assistant).
 * Different from llm-test.service.ts (1-token ping) and the node executor
 * (single user prompt). Here we forward conversation history so the assistant
 * can answer follow-ups.
 *
 * Every provider call is wrapped in a per-provider circuit breaker — if one
 * provider goes down, calls to it fail fast for 60s instead of consuming
 * worker threads in fetch timeout. Other providers stay unaffected.
 */

import { CircuitBreaker, CircuitBreakerRegistry } from '@medea/engine-shared';
import { isFixedOpenAiCompat, fixedOpenAiCompatTarget } from './llm/provider-registry.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { assertUrlSafe } from '@medea/engine-safe-fetch';

/**
 * Difesa-in-profondità SSRF. Il `baseUrl` CUSTOM (BYOK Ollama / proxy
 * OpenAI-compat) è input utente e qui diventa il target `fetch` → lo validiamo
 * (host pubblico) PRIMA di usarlo.
 *
 * `assertUrlSafe` lancia (RFC1918/loopback/link-local/localhost) senza
 * `allowDockerNet`. Gate primario: validazione all'upsert
 * (routes/llm-providers.ts).
 */
function guardCustomBaseUrl(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  assertUrlSafe(baseUrl);
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Immagine allegata a un messaggio, per i modelli che leggono i pixel. */
export interface ChatImage {
  base64: string;
  mimeType: string;
}

/**
 * Il budget di contesto (in token) su cui si regolano le chat del motore.
 *
 * È una soglia unica e prudente, non la finestra reale di ogni modello: la
 * usano il contatore di contesto del chatter (`used / window`) e i tagli alla
 * storia delle conversazioni. Per i provider con finestra più ampia resta
 * conservativa, mai in eccesso. Si alza da `MEDEA_LLM_CONTEXT_WINDOW`.
 */
export function getContextWindowBudget(): number {
  const v = Number(process.env.MEDEA_LLM_CONTEXT_WINDOW ?? '40960');
  return Number.isFinite(v) && v > 0 ? v : 40960;
}

/**
 * Il prompt (system + history + user) supera il context window del modello.
 * Tipizzato per dare un messaggio CHIARO all'utente (413) invece del 400
 * criptico del modello mascherato da 500 'Errore interno' (incidente owner
 * 2026-06-12: chat editor → 'context length 92408 > 40960').
 */
export class LlmContextOverflowError extends Error {
  readonly estimatedTokens: number;
  readonly contextWindow: number;
  constructor(estimatedTokens: number, contextWindow: number) {
    super(
      `La conversazione è troppo lunga per il modello (${estimatedTokens.toLocaleString('it-IT')} token stimati ` +
        `su un massimo di ${contextWindow.toLocaleString('it-IT')}). Inizia una nuova chat oppure semplifica il ` +
        `workflow: spesso un singolo nodo con un testo/codice molto lungo gonfia il contesto.`,
    );
    this.name = 'LlmContextOverflowError';
    this.estimatedTokens = estimatedTokens;
    this.contextWindow = contextWindow;
  }
}

/**
 * Il provider LLM selezionato NON è al momento raggiungibile: rete giù, 5xx a
 * monte, circuit breaker aperto.
 *
 * Tipizzato per dare all'utente un messaggio CHIARO (503) invece di un 500
 * 'Errore interno' opaco — e, soprattutto, per NON ripiegare MAI in silenzio su
 * un altro provider/una chiave a pagamento (decisione owner 2026-06-18:
 * "rispetta la scelta + errore chiaro"). Chi ha scelto un provider e lo trova
 * giù deve saperlo e scegliere lui un'alternativa, non ritrovarsi addebiti
 * su un'altra chiave.
 */
export class LlmProviderUnavailableError extends Error {
  readonly provider: string;
  constructor(provider: string, detail?: string) {
    const label = chatProviderLabel(provider);
    super(
      `${label} non è al momento raggiungibile${detail ? ` (${detail})` : ''}. ` +
        'Riprova tra poco, oppure seleziona un altro provider in Settings → AI Providers.',
    );
    this.name = 'LlmProviderUnavailableError';
    this.provider = provider;
  }
}

/** Tipo di quota esaurita (codici 429 del gateway portal). */
export type LlmQuotaKind = 'token' | 'calls' | 'daily';

/**
 * Quota LLM del tenant esaurita (429 dal gateway portal). DISTINTA dagli altri
 * 429/5xx perché l'engine la gestisce in modo speciale (fallback BYOK → pausa
 * su rinnovo → errore CHIARO), invece di un fallimento opaco "429: …".
 */
export class LlmQuotaExceededError extends Error {
  readonly provider: string;
  readonly kind: LlmQuotaKind;
  readonly used: number | null;
  readonly limit: number | null;
  readonly planCode: string | null;
  /** 'YYYY-MM-DD' del prossimo reset (giorno di abbonamento), se noto. */
  readonly periodEndIso: string | null;
  constructor(opts: {
    provider: string;
    kind: LlmQuotaKind;
    used?: number | null;
    limit?: number | null;
    planCode?: string | null;
    periodEndIso?: string | null;
  }) {
    const kindTxt =
      opts.kind === 'token'
        ? 'token'
        : opts.kind === 'calls'
          ? 'chiamate LLM mensili'
          : 'chiamate giornaliere';
    const usage = opts.used != null && opts.limit != null ? ` (${opts.used}/${opts.limit})` : '';
    const reset = opts.periodEndIso
      ? ` Si rinnova il ${formatQuotaResetDate(opts.periodEndIso)}.`
      : '';
    super(
      `Quota ${kindTxt}${opts.planCode ? ` del piano ${opts.planCode}` : ''} esaurita${usage}.${reset} ` +
        'Passa a un piano superiore o configura una tua chiave LLM (BYOK) per continuare.',
    );
    this.name = 'LlmQuotaExceededError';
    this.provider = opts.provider;
    this.kind = opts.kind;
    this.used = opts.used ?? null;
    this.limit = opts.limit ?? null;
    this.planCode = opts.planCode ?? null;
    this.periodEndIso = opts.periodEndIso ?? null;
  }
}

function formatQuotaResetDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/** Mappa codice 429 del gateway → tipo di quota. */
const QUOTA_CODE_KIND: Readonly<Record<string, LlmQuotaKind>> = {
  MONTHLY_TOKEN_QUOTA_EXCEEDED: 'token',
  MONTHLY_CALLS_QUOTA_EXCEEDED: 'calls',
  QUOTA_EXCEEDED: 'daily',
};

/**
 * Riconosce un body 429 di quota dal gateway e lo trasforma in
 * `LlmQuotaExceededError` tipizzato. Ritorna `null` se il body non è un 429 di
 * quota noto (così il chiamante ricade sull'errore generico).
 */
export function parseQuotaError(body: string, provider: string): LlmQuotaExceededError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const err = (
    parsed as {
      error?: {
        code?: string;
        tokensUsed?: number;
        callsUsed?: number;
        monthlyLimit?: number | null;
        planCode?: string;
        periodEndIso?: string;
      };
    }
  ).error;
  if (!err?.code) return null;
  const kind = QUOTA_CODE_KIND[err.code];
  if (!kind) return null;
  return new LlmQuotaExceededError({
    provider,
    kind,
    used: err.tokensUsed ?? err.callsUsed ?? null,
    limit: err.monthlyLimit ?? null,
    planCode: err.planCode ?? null,
    periodEndIso: err.periodEndIso ?? null,
  });
}

/** One breaker per LLM provider — singletons keyed on provider name. */
function getBreaker(provider: string): CircuitBreaker<string> {
  const name = `llm:${provider}`;
  const existing = CircuitBreakerRegistry.getInstance().get(name);
  if (existing) return existing;
  return new CircuitBreaker<string>(name, {
    failureThreshold: 5, // 5 fail in 30s → open
    windowMs: 30_000,
    cooldownMs: 60_000, // 60s before half-open probe
    // No fallback — callers should catch CircuitBreakerOpenError and
    // either retry later (queued workflow) or surface "AI temporarily
    // unavailable" to the user.
  });
}

export interface LlmTokenUsage {
  /** Token estimati IN (system prompt + history + user message). Da response API o stima ~3.5 char/token. */
  input: number;
  /** Token estimati OUT (assistant message generata). Da response API o stima ~3.5 char/token. */
  output: number;
  /** True se i numeri vengono dalla API del provider (precisi). False se sono stime locali. */
  fromApi: boolean;
}

/**
 * Listener opzionale per ricevere telemetria token usage immediatamente
 * dopo ogni risposta LLM. Non blocca il return (fire-and-forget).
 * Vedi scaffold-runner per emit verso SSE → UI scaffold timer panel.
 */
export type TokenUsageListener = (usage: LlmTokenUsage) => void;

/** Quanto si aspetta una risposta quando chi chiama non lo dice. */
const ATTESA_PREDEFINITA_MS = 60_000;

/**
 * Stima dei token di un testo: ~3,5 caratteri per token, media per testo
 * misto italiano/inglese e JSON. Volutamente in eccesso.
 */
function stimaToken(testo: string): number {
  return Math.ceil(testo.length / 3.5);
}

/** Il numero se è un valore utilizzabile, altrimenti niente. */
function positivo(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function dispatchLLMChat(
  provider: string,
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  baseUrl: string | undefined,
  history: ChatMessage[],
  tokenUsageListener?: TokenUsageListener,
  /** Override PER-CHIAMATA di max_tokens/timeout/temperature, passati
   *  ESPLICITAMENTE per evitare la mutazione di `process.env` globale attorno a
   *  un await (race tra run concorrenti). Valgono per ogni provider, ognuno col
   *  nome che il suo protocollo dà al limite di uscita. Assenti → i predefiniti
   *  del ramo (60s di attesa, temperature 0.1). `stop` elenca le sequenze a
   *  cui il modello deve fermarsi. */
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number; stop?: string[] },
): Promise<string> {
  guardCustomBaseUrl(baseUrl);
  const msgs = [...history, { role: 'user' as const, content: userMessage }];

  const timeoutMs = positivo(opts?.timeoutMs) ?? ATTESA_PREDEFINITA_MS;
  const maxTokens = positivo(opts?.maxTokens);
  const temperature = opts?.temperature ?? 0.1;
  const stop = opts?.stop && opts.stop.length > 0 ? opts.stop : undefined;

  /**
   * Dice al listener quanto è costata la risposta: i numeri del provider
   * quando li dichiara, una stima dichiarata come tale altrimenti. Un
   * contatore che resta a zero perché il provider tace è peggio di uno
   * approssimato e marcato.
   */
  const reportUsage = (content: string, input?: number, output?: number): void => {
    if (!tokenUsageListener) return;
    if (typeof input === 'number' && typeof output === 'number') {
      tokenUsageListener({ input, output, fromApi: true });
      return;
    }
    tokenUsageListener({
      input: stimaToken(system) + msgs.reduce((acc, m) => acc + stimaToken(m.content), 0),
      output: stimaToken(content),
      fromApi: false,
    });
  };

  return getBreaker(provider).execute(async () => {
    // ── Ramo generico: provider OpenAI-compat a endpoint fisso ──────────────────
    // (openai, mistral, groq, grok, deepseek, openrouter). Url/model/header = SSOT
    // provider-registry. Un solo ramo al posto di 6 case duplicati.
    if (isFixedOpenAiCompat(provider)) {
      const target = fixedOpenAiCompatTarget(provider, model);
      if (provider === 'openrouter' && !target.model) {
        throw new Error(
          'OpenRouter: model required (es. "openai/gpt-4o", "google/gemini-pro", "x-ai/grok-2")',
        );
      }
      const res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(target.extraHeaders ?? {}),
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: 'system', content: system }, ...msgs],
          temperature,
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(stop ? { stop } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        throw new Error(
          `${chatProviderLabel(provider)} ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`,
        );
      const data = await readJsonCapped<{
        choices?: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(res);
      const content = data.choices?.[0]?.message.content ?? '';
      reportUsage(content, data.usage?.prompt_tokens, data.usage?.completion_tokens);
      return content;
    }
    switch (provider) {
      case 'gemini': {
        const m = model || 'gemini-2.0-flash';
        const contents = msgs.map((x) => ({
          role: x.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: x.content }],
        }));
        // Solo ciò che è stato chiesto: senza richiesta Gemini usa i suoi
        // predefiniti, come ha sempre fatto.
        const generationConfig = {
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(stop ? { stopSequences: stop } : {}),
        };
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents,
              ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!res.ok)
          throw new Error(
            `Gemini ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`,
          );
        const data = await readJsonCapped<{
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        }>(res);
        const content =
          data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        reportUsage(
          content,
          data.usageMetadata?.promptTokenCount,
          data.usageMetadata?.candidatesTokenCount,
        );
        return content;
      }
      case 'anthropic': {
        // Una sequenza di soli spazi o a capo fa rifiutare l'intera richiesta
        // (400): si tolgono, perché un'opzione accessoria non deve costare la
        // risposta.
        const stopSequences = stop?.filter((s) => s.trim() !== '');
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-5-20250929',
            system,
            messages: msgs,
            // Qui il limite è obbligatorio: senza richiesta se ne dà uno ampio.
            max_tokens: maxTokens ?? 8000,
            temperature,
            ...(stopSequences && stopSequences.length > 0 ? { stop_sequences: stopSequences } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
          throw new Error(
            `Anthropic ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`,
          );
        const data = await readJsonCapped<{
          content?: { type: string; text?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        }>(res);
        const content = (data.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        reportUsage(content, data.usage?.input_tokens, data.usage?.output_tokens);
        return content;
      }
      case 'ollama': {
        const url = `${baseUrl ?? 'http://localhost:11434'}/api/chat`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'llama3.2',
            stream: false,
            messages: [{ role: 'system', content: system }, ...msgs],
            ...(maxTokens !== undefined || stop
              ? {
                  options: {
                    ...(maxTokens !== undefined ? { num_predict: maxTokens } : {}),
                    ...(stop ? { stop } : {}),
                  },
                }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
          throw new Error(
            `Ollama ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`,
          );
        const data = await readJsonCapped<{
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        }>(res);
        const content = data.message?.content ?? '';
        reportUsage(content, data.prompt_eval_count, data.eval_count);
        return content;
      }
      default:
        throw new Error(`Unknown provider for chat: ${provider}`);
    }
  });
}

/** Etichetta leggibile per i messaggi d'errore del ramo OpenAI-compat generico. */
function chatProviderLabel(p: string): string {
  const map: Record<string, string> = {
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    ollama: 'Ollama',
    openai: 'OpenAI',
    mistral: 'Mistral',
    groq: 'Groq',
    grok: 'Grok',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
  };
  return map[p] ?? p;
}

/**
 * dispatchLLMChatStructured — una generazione sola, con uno schema JSON come
 * forma attesa.
 *
 * Lo schema viaggia nel prompt di sistema, uguale per ogni provider: chi
 * riceve la risposta la valida comunque (i chiamanti passano da Zod e dalla
 * riparazione), quindi qui si chiede la forma e non la si dà per garantita.
 */
export async function dispatchLLMChatStructured(
  provider: string,
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  baseUrl: string | undefined,
  history: ChatMessage[],
  jsonSchema: object,
  tokenUsageListener?: TokenUsageListener,
): Promise<string> {
  const systemWithSchema = `${system}\n\nOUTPUT JSON SCHEMA (rispetta esattamente):\n${JSON.stringify(jsonSchema)}\n\nRispondi SOLO con JSON valido secondo lo schema sopra.`;
  return dispatchLLMChat(
    provider,
    apiKey,
    model,
    systemWithSchema,
    userMessage,
    baseUrl,
    history,
    tokenUsageListener,
  );
}

/**
 * Come `dispatchLLMChatStructured`, per chi segue l'avanzamento con un
 * callback.
 *
 * Nessun provider qui trasmette a pezzi: la risposta arriva intera e il
 * callback la riceve in una volta sola. Chi chiama (singleshot.service, col
 * suo parser incrementale) vede lo stesso flusso, con un solo passo.
 */
export async function dispatchLLMChatStructuredStreaming(
  provider: string,
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  baseUrl: string | undefined,
  history: ChatMessage[],
  jsonSchema: object,
  onChunk: (delta: string) => void,
  tokenUsageListener?: TokenUsageListener,
): Promise<string> {
  const full = await dispatchLLMChatStructured(
    provider,
    apiKey,
    model,
    system,
    userMessage,
    baseUrl,
    history,
    jsonSchema,
    tokenUsageListener,
  );
  onChunk(full);
  return full;
}

/**
 * Il gemello di `dispatchLLMChat` per le superfici che seguono l'avanzamento
 * con un callback (es. il generatore di nodi): la risposta arriva intera e il
 * callback la riceve in una volta sola.
 */
export async function dispatchLLMChatStreaming(
  provider: string,
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  baseUrl: string | undefined,
  history: ChatMessage[],
  onChunk: (delta: string) => void,
  tokenUsageListener?: TokenUsageListener,
): Promise<string> {
  const full = await dispatchLLMChat(
    provider,
    apiKey,
    model,
    system,
    userMessage,
    baseUrl,
    history,
    tokenUsageListener,
  );
  onChunk(full);
  return full;
}
