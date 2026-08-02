/**
 * Multi-provider chat dispatcher with history (used by the AI Assistant).
 * Different from llm-test.service.ts (1-token ping) and the node executor
 * (single user prompt). Here we forward conversation history so the assistant
 * can answer follow-ups.
 *
 * Every provider call is wrapped in a per-provider circuit breaker — if
 * Liara goes down, calls to Liara fail fast for 60s instead of consuming
 * worker threads in fetch timeout. Other providers stay unaffected.
 */

import { isLiaraEnabled, liaraBaseUrl } from '@/config.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '@medea/engine-shared';
import { isFixedOpenAiCompat, fixedOpenAiCompatTarget } from './llm/provider-registry.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { assertUrlSafe } from '@medea/engine-safe-fetch';

/**
 * Difesa-in-profondità SSRF. Il `baseUrl` CUSTOM (BYOK Ollama / proxy
 * OpenAI-compat) è input utente e qui diventa il target `fetch` → lo validiamo
 * (host pubblico) PRIMA di usarlo.
 *
 * ⚠️ ECCEZIONE OBBLIGATORIA — il GATEWAY INTERNO di default (`liaraBaseUrl()` =
 * MEDEA_LIARA_BASE_URL) è un IP PRIVATO PER DESIGN (docker bridge verso il
 * portal-gateway con licenza, es. 172.20.0.1:3006). Il resolver Liara lo passa
 * SEMPRE come `baseUrl` (provider-registry: "il chiamante lo passa"), quindi NON è
 * `undefined` come assumeva il commento precedente: senza questa esenzione
 * `assertUrlSafe` lo blocca (BLOCKED_PRIVATE_IP) → la chat Liara default e il
 * gateway /api/v1/liara/chat (NHA) crashano con 500 'Errore interno'. Il guard SSRF
 * deve colpire SOLO i baseUrl CUSTOM, non il gateway interno legittimo.
 *
 * `assertUrlSafe` lancia (RFC1918/loopback/link-local/localhost) senza
 * `allowDockerNet` → blocca la flowforge-net per i baseUrl custom. Gate primario:
 * validazione all'upsert (routes/llm-providers.ts).
 */
function guardCustomBaseUrl(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  // Esente: coincide (per origin) col gateway interno di default → traffico interno
  // legittimo e autenticato (licenza), non un target SSRF attacker-controlled.
  try {
    if (new URL(baseUrl).origin === new URL(liaraBaseUrl()).origin) return;
  } catch { /* baseUrl malformato → lo rifiuta assertUrlSafe qui sotto */ }
  assertUrlSafe(baseUrl);
}

interface ChatMessage { role: 'user' | 'assistant'; content: string }

/**
 * Immagine allegata da passare DIRETTAMENTE al modello multimodale (Liara
 * Qwen3-VL legge i pixel nativamente — niente più pre-descrizione in testo).
 */
export interface ChatImage { base64: string; mimeType: string }

/** Content di un messaggio: testo semplice o array multimodale OpenAI-compat. */
type LlmContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type LlmMessageContent = string | LlmContentPart[];

/** Costruisce il content dell'ultimo messaggio utente: multimodale se ci sono immagini. */
function buildUserContent(userMessage: string, images?: ChatImage[]): LlmMessageContent {
  if (!images || images.length === 0) return userMessage;
  return [
    { type: 'text', text: userMessage },
    ...images.map((img) => ({
      type: 'image_url' as const,
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

/** Token ~ stimati per immagine (tile Qwen-VL) — solo per il budget max_tokens. */
const TOKENS_PER_IMAGE_ESTIMATE = 800;

/**
 * Context window (in token) del modello Liara self-hosted. Single source of
 * truth: era duplicato in 3 punti del file (dynamic max_tokens calc) → la
 * divergenza avrebbe rotto il calcolo dell'output cap. Esportata anche per il
 * contatore di contesto del chatter (mostra `used / window`).
 *
 * NB: oggi FlowForge usa la stessa finestra anche per i provider BYOK — il
 * budget dinamico è tarato su Liara; per i BYOK con finestra più ampia (Claude
 * 200k, GPT 128k) resta conservativo, mai overrun.
 */
export function getLiaraContextWindow(): number {
  const v = Number(process.env.MEDEA_LIARA_CONTEXT_WINDOW ?? '40960');
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
 * Il provider LLM selezionato NON è al momento raggiungibile: rete giù, gateway
 * 5xx, vLLM fermo (es. GPU in gen-mode), circuit breaker aperto.
 *
 * Tipizzato per dare all'utente un messaggio CHIARO (503) invece di un 500
 * 'Errore interno' opaco — e, soprattutto, per NON ripiegare MAI in silenzio su
 * un altro provider/una chiave a pagamento (decisione owner 2026-06-18:
 * "rispetta la scelta + errore chiaro"). Chi ha scelto Liara e la trova giù
 * deve saperlo e scegliere lui un alternativa, non ritrovarsi addebiti BYOK.
 */
export class LlmProviderUnavailableError extends Error {
  readonly provider: string;
  constructor(provider: string, detail?: string) {
    const label = chatProviderLabel(provider);
    super(
      `${label} non è al momento raggiungibile${detail ? ` (${detail})` : ''}. ` +
        (provider === 'liara'
          ? 'Liara potrebbe essere offline (manutenzione o GPU occupata). Riprova tra poco, '
            + 'oppure seleziona un altro provider in Settings → AI Providers.'
          : 'Riprova tra poco, oppure seleziona un altro provider in Settings → AI Providers.'),
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
 * su rinnovo → errore CHIARO), invece di un fallimento opaco "Liara 429: …".
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
    const kindTxt = opts.kind === 'token' ? 'token'
      : opts.kind === 'calls' ? 'chiamate LLM mensili' : 'chiamate giornaliere';
    const usage = opts.used != null && opts.limit != null ? ` (${opts.used}/${opts.limit})` : '';
    const reset = opts.periodEndIso ? ` Si rinnova il ${formatQuotaResetDate(opts.periodEndIso)}.` : '';
    super(
      `Quota ${kindTxt}${opts.planCode ? ` del piano ${opts.planCode}` : ''} esaurita${usage}.${reset} `
      + 'Passa a un piano superiore o configura una tua chiave LLM (BYOK) per continuare.',
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
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
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
  const err = (parsed as {
    error?: {
      code?: string;
      tokensUsed?: number;
      callsUsed?: number;
      monthlyLimit?: number | null;
      planCode?: string;
      periodEndIso?: string;
    };
  }).error;
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

/** Errore di fetch da rete (connessione rifiutata / DNS / reset) — non un AbortError. */
function isNetworkError(err: unknown): boolean {
  return err instanceof Error && err.name !== 'AbortError'
    && (err.name === 'TypeError' || /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(err.message));
}

/** One breaker per LLM provider — singletons keyed on provider name. */
function getBreaker(provider: string): CircuitBreaker<string> {
  const name = `llm:${provider}`;
  const existing = CircuitBreakerRegistry.getInstance().get(name);
  if (existing) return existing;
  return new CircuitBreaker<string>(name, {
    failureThreshold: 5,       // 5 fail in 30s → open
    windowMs: 30_000,
    cooldownMs: 60_000,        // 60s before half-open probe
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

export async function dispatchLLMChat(
  provider: string,
  apiKey: string,
  model: string,
  system: string,
  userMessage: string,
  baseUrl: string | undefined,
  history: ChatMessage[],
  tokenUsageListener?: TokenUsageListener,
  /** Id correlato dal client (editor) → propagato al gateway portal come
   *  X-FF-Request-Id per il canale-posizione della coda LLM (vedi admission). */
  requestId?: string,
  /** Override PER-CHIAMATA di max_tokens/timeout/temperature. Passati ESPLICITAMENTE
   *  per evitare la mutazione di `process.env` globale attorno a un await (race tra run
   *  concorrenti nello stesso container). `temperature` assente → default per-ramo
   *  invariato (0.2 Liara, 0.1 openai-compat); presente → rispettata (il nodo
   *  action_llm_complete la espone all'utente). maxTokens/timeout assenti → fallback env. */
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
): Promise<string> {
  guardCustomBaseUrl(baseUrl);
  const msgs = [...history, { role: 'user' as const, content: userMessage }];

  return getBreaker(provider).execute(async () => {
  // ── Ramo generico: provider OpenAI-compat a endpoint fisso ──────────────────
  // (openai, mistral, groq, grok, deepseek, openrouter). Url/model/header = SSOT
  // provider-registry. Un solo ramo al posto di 6 case duplicati.
  if (isFixedOpenAiCompat(provider)) {
    const target = fixedOpenAiCompatTarget(provider, model);
    if (provider === 'openrouter' && !target.model) {
      throw new Error('OpenRouter: model required (es. "openai/gpt-4o", "google/gemini-pro", "x-ai/grok-2")');
    }
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(target.extraHeaders ?? {}), Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: target.model, messages: [{ role: 'system', content: system }, ...msgs], temperature: opts?.temperature ?? 0.1 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`${chatProviderLabel(provider)} ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
    const data = await readJsonCapped<{ choices?: { message: { content: string } }[] }>(res);
    return data.choices?.[0]?.message.content ?? '';
  }
  switch (provider) {
    case 'liara': {
      if (!isLiaraEnabled()) {
        throw new Error('Liara è disabilitata su questa istanza (MEDEA_DISABLE_LIARA=true).');
      }
      // Route to portal gateway (path is the OpenAI-compatible endpoint
      // exposed by the zeliai portal which forwards to the internal Liara
      // service after Sentinel + license + quota checks).
      const url = `${baseUrl ?? liaraBaseUrl()}/chat/completions`;
      const licenseKey = process.env.MEDEA_LICENSE_KEY ?? '';

      // Liara = Qwen3 32B FP8 self-hosted on Hetzner GPU. Pieno potere:
      //  - Thinking mode ON (Qwen3 ragiona via <think>...</think> prima di emettere)
      //  - max_tokens DINAMICO (FIX 2026-05-30 user-segnalato Liara 400 "too large"):
      //    Qwen3 32B context window = 40960 tokens. Pre-fix: 24000 hardcoded →
      //    quando input scaffold scala (~17K con SYSTEM_PROMPT esempi ADV + catalog
      //    multi-action), input+max_tokens > 40960 → vLLM rifiuta. Ora calcoliamo
      //    output cap come (context_window - input_tokens - safety_margin).
      //  - model omesso: Liara backend usa il suo MODEL_NAME (qwen3-32b) di default.
      const thinkingDisabled = process.env.MEDEA_LIARA_THINKING === 'false';
      const systemPrefix = thinkingDisabled ? '/no_think\n' : '';
      const fullSystem = `${systemPrefix}${system}`;
      // Token estimation: ~3.5 char/token medio per testo IT/EN misto + JSON.
      // Conservativo (overestimate) per evitare overrun. Pattern industriale
      // (Anthropic SDK usa ~4 char/token, OpenAI tiktoken precisa ma overhead).
      const CHARS_PER_TOKEN = 3.5;
      const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);
      const inputTokensEstimated =
        estimateTokens(fullSystem) +
        msgs.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
        msgs.length * 4; // overhead role markers per message
      const contextWindow = getLiaraContextWindow();
      const safetyMargin = 512;
      // Guard input-overflow: se l'input da solo non lascia spazio nemmeno per
      // una risposta minima, NON mandare la richiesta (il modello la rifiuta
      // con un 400 criptico → 500). Falliamo PRESTO con un errore chiaro.
      const MIN_OUTPUT_TOKENS = 512;
      if (inputTokensEstimated > contextWindow - MIN_OUTPUT_TOKENS - safetyMargin) {
        throw new LlmContextOverflowError(inputTokensEstimated, contextWindow);
      }
      const rawCeiling = opts?.maxTokens ?? Number(process.env.MEDEA_LIARA_MAX_TOKENS ?? '24000');
      const maxTokensCeiling = Number.isFinite(rawCeiling) && rawCeiling > 0 ? rawCeiling : 24000;
      const dynamicMax = Math.max(
        1024,
        Math.min(maxTokensCeiling, contextWindow - inputTokensEstimated - safetyMargin),
      );
      const body: Record<string, unknown> = {
        messages: [{ role: 'system', content: fullSystem }, ...msgs],
        temperature: opts?.temperature ?? 0.2,
        max_tokens: dynamicMax,
        chat_template_kwargs: { enable_thinking: !thinkingDisabled },
      };
      // Permetti override del model SOLO se esplicito (BYOK enterprise).
      // Default = lasciar decidere a Liara backend (MODEL_NAME env).
      if (model && model.trim().length > 0) body.model = model;

      // FIX 2026-05-31 (rev 2): timeout 240s per call. Qwen3 thinking + propose_plan
      // Enterprise (22 nodi) supera 60s e a volte 90s. Portal gateway ha
      // LIARA_TIMEOUT_MS_SYNC=240s, e il client (qui) deve essere >= per non
      // tagliare prima di lui. Oltre 240s consideriamo hang vero.
      const liaraTimeoutMs = opts?.timeoutMs ?? Number(process.env.MEDEA_LIARA_TIMEOUT_MS ?? '240000');
      const liaraCtrl = new AbortController();
      const liaraTimeoutId = setTimeout(() => liaraCtrl.abort(), liaraTimeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // License key carried as Bearer so portal can validate + apply
            // quota/tier. Absent header → portal will 401.
            ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
            // Correlazione coda LLM → canale-posizione (l'editor apre
            // /ai-assistant/queue-status?rid=<requestId> in parallelo).
            ...(requestId ? { 'X-FF-Request-Id': requestId } : {}),
          },
          body: JSON.stringify(body),
          signal: liaraCtrl.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Liara timeout dopo ${liaraTimeoutMs.toString()}ms — modello in stallo. Riprova o aumenta MEDEA_LIARA_TIMEOUT_MS.`);
        }
        // Connessione rifiutata/reset → Liara giù (es. GPU in gen-mode): errore chiaro.
        if (isNetworkError(err)) throw new LlmProviderUnavailableError('liara', 'connessione fallita');
        throw err;
      } finally {
        clearTimeout(liaraTimeoutId);
      }
      if (!res.ok) {
        const errBody = (await readTextTruncated(res, 65_536)).text.slice(0, 300);
        // Difesa in profondità: se la stima locale ha sbagliato e il modello
        // rifiuta per context length, traduci nel nostro errore chiaro (413)
        // invece del 400 grezzo che diventerebbe 500 'Errore interno'.
        if (res.status === 400 && /context length|maximum context|input.?tokens/i.test(errBody)) {
          throw new LlmContextOverflowError(inputTokensEstimated, contextWindow);
        }
        // 429 di QUOTA (token/chiamate/giorno) → errore TIPIZZATO così l'engine
        // può degradare con grazia (fallback BYOK / pausa / errore chiaro) invece
        // di un fallimento opaco. Altri 429 (rate-limit upstream) restano generici.
        if (res.status === 429) {
          const quotaErr = parseQuotaError(errBody, 'liara');
          if (quotaErr) throw quotaErr;
        }
        // 5xx dal gateway = Liara/backend non disponibile a monte → errore chiaro (503).
        if (res.status >= 500) throw new LlmProviderUnavailableError('liara', `gateway ${res.status.toString()}`);
        throw new Error(`Liara ${res.status.toString()}: ${errBody.slice(0, 200)}`);
      }
      const data = await readJsonCapped<{
        choices?: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(res);
      const content = (data.choices?.[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      // Liara (Qwen3) backend espone usage in formato OpenAI-compat.
      if (tokenUsageListener) {
        const apiInput = data.usage?.prompt_tokens;
        const apiOutput = data.usage?.completion_tokens;
        if (typeof apiInput === 'number' && typeof apiOutput === 'number') {
          tokenUsageListener({ input: apiInput, output: apiOutput, fromApi: true });
        } else {
          tokenUsageListener({ input: inputTokensEstimated, output: estimateTokens(content), fromApi: false });
        }
      }
      return content;
    }
    case 'gemini': {
      const m = model || 'gemini-2.0-flash';
      const contents = msgs.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
      signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>(res);
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    }
    case 'anthropic': {
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
          max_tokens: 8000,
          temperature: 0.1,
        }),
      signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ content?: { type: string; text?: string }[] }>(res);
      return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    }
    case 'ollama': {
      const url = `${baseUrl ?? 'http://localhost:11434'}/api/chat`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'llama3.2', stream: false, messages: [{ role: 'system', content: system }, ...msgs] }),
      signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
      const data = await readJsonCapped<{ message?: { content?: string } }>(res);
      return data.message?.content ?? '';
    }
    default:
      throw new Error(`Unknown provider for chat: ${provider}`);
  }
  });
}

/** Etichetta leggibile per i messaggi d'errore del ramo OpenAI-compat generico. */
function chatProviderLabel(p: string): string {
  const map: Record<string, string> = {
    liara: 'Liara', anthropic: 'Anthropic', gemini: 'Gemini', ollama: 'Ollama',
    openai: 'OpenAI', mistral: 'Mistral', groq: 'Groq', grok: 'Grok', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
  };
  return map[p] ?? p;
}

/**
 * dispatchLLMChatStructured — single-shot generation con JSON schema constraint.
 *
 * Per Liara/vLLM: passa `guided_json` param che FORZA l'output JSON-valid e
 * schema-compliant. UNA chiamata sola, output garantito parseable, niente loop
 * iter o retry. Stack 2026-grade per wizard / scaffold.
 *
 * Per altri provider (OpenAI / Anthropic): fallback usando `response_format`
 * JSON-only. Schema constraint best-effort (i provider gestiscono diverso).
 *
 * Disabilita THINKING su Liara per output piu\` veloce (il guided_json gia\`
 * forza struttura, niente bisogno di reasoning textuale lungo).
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
  /** Id correlato dal client → X-FF-Request-Id per il canale-posizione coda LLM
   *  (parità con dispatchLLMChat: la chat strutturata non perde la "posizione in coda"). */
  requestId?: string,
  /** Immagini allegate → passate DIRETTE a Liara come content multimodale (pixel,
   *  1 call, fedeltà piena). Vuoto/assente → comportamento testuale identico a prima. */
  images?: ChatImage[],
): Promise<string> {
  guardCustomBaseUrl(baseUrl);
  if (provider !== 'liara') {
    // Per BYOK non-Liara, usiamo response_format json_object (loose) +
    // schema embed nel system prompt. Funziona con OpenAI, Anthropic recente.
    const systemWithSchema = `${system}\n\nOUTPUT JSON SCHEMA (rispetta esattamente):\n${JSON.stringify(jsonSchema)}\n\nRispondi SOLO con JSON valido secondo lo schema sopra.`;
    return dispatchLLMChat(provider, apiKey, model, systemWithSchema, userMessage, baseUrl, history, tokenUsageListener, requestId);
  }

  if (!isLiaraEnabled()) {
    throw new Error('Liara è disabilitata su questa istanza (MEDEA_DISABLE_LIARA=true).');
  }

  const msgs: { role: 'user' | 'assistant'; content: LlmMessageContent }[] = [
    ...history,
    { role: 'user' as const, content: buildUserContent(userMessage, images) },
  ];
  const url = `${baseUrl ?? liaraBaseUrl()}/chat/completions`;
  const licenseKey = process.env.MEDEA_LICENSE_KEY ?? '';

  // SINGLE-SHOT: niente thinking mode (guided_json fa il lavoro strutturale).
  // Risparmia 30-60% del tempo elaborazione.
  const fullSystem = `/no_think\n${system}`;
  const CHARS_PER_TOKEN = 3.5;
  const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);
  // Stima testo (history string + nuovo userMessage) + budget fisso per immagine.
  const inputTokensEstimated =
    estimateTokens(fullSystem) +
    estimateTokens(userMessage) +
    history.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
    msgs.length * 4 +
    (images?.length ?? 0) * TOKENS_PER_IMAGE_ESTIMATE;
  const contextWindow = getLiaraContextWindow();
  const safetyMargin = 1024;
  const rawCeiling = Number(process.env.MEDEA_LIARA_SINGLESHOT_MAX_TOKENS ?? '16000');
  const maxTokensCeiling = Number.isFinite(rawCeiling) && rawCeiling > 0 ? rawCeiling : 16000;
  const dynamicMax = Math.max(
    2048,
    Math.min(maxTokensCeiling, contextWindow - inputTokensEstimated - safetyMargin),
  );

  const body: Record<string, unknown> = {
    messages: [{ role: 'system', content: fullSystem }, ...msgs],
    temperature: 0.1,
    max_tokens: dynamicMax,
    chat_template_kwargs: { enable_thinking: false },
    // vLLM 0.15+ structured outputs — OpenAI-compat response_format json_schema.
    // Forza output conforme allo schema JSON. xgrammar backend auto-selected.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'workflow_scaffold',
        strict: true,
        schema: jsonSchema,
      },
    },
  };
  if (model && model.trim().length > 0) body.model = model;

  const liaraTimeoutMs = Number(process.env.MEDEA_LIARA_TIMEOUT_MS ?? '240000');
  const liaraCtrl = new AbortController();
  const liaraTimeoutId = setTimeout(() => liaraCtrl.abort(), liaraTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
        // Correlazione coda LLM → canale-posizione (parità con dispatchLLMChat).
        ...(requestId ? { 'X-FF-Request-Id': requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: liaraCtrl.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Liara single-shot timeout dopo ${liaraTimeoutMs.toString()}ms.`);
    }
    // Connessione rifiutata/reset → Liara è giù (es. GPU in gen-mode). Errore
    // CHIARO, niente swap silenzioso su altri provider.
    if (isNetworkError(err)) throw new LlmProviderUnavailableError('liara', 'connessione fallita');
    throw err;
  } finally {
    clearTimeout(liaraTimeoutId);
  }
  if (!res.ok) {
    const errBody = (await readTextTruncated(res, 65_536)).text.slice(0, 300);
    // 5xx dal gateway = Liara/backend non disponibile a monte → errore chiaro (503).
    if (res.status >= 500) throw new LlmProviderUnavailableError('liara', `gateway ${res.status.toString()}`);
    throw new Error(`Liara structured ${res.status.toString()}: ${errBody}`);
  }
  const data = await readJsonCapped<{
    choices?: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>(res);
  const content = (data.choices?.[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  if (tokenUsageListener) {
    const apiInput = data.usage?.prompt_tokens;
    const apiOutput = data.usage?.completion_tokens;
    if (typeof apiInput === 'number' && typeof apiOutput === 'number') {
      tokenUsageListener({ input: apiInput, output: apiOutput, fromApi: true });
    } else {
      tokenUsageListener({ input: inputTokensEstimated, output: estimateTokens(content), fromApi: false });
    }
  }
  return content;
}

/**
 * Consuma uno stream SSE OpenAI-compat (vLLM/Liara): per ogni `delta.content`
 * invoca `onDelta`, e cattura l'oggetto `usage` finale. Gestisce le righe
 * spezzate su più read (buffer del residuo) e ignora le righe malformate o
 * `[DONE]`. Non lancia mai per errori del callback (best-effort: lo stream non
 * si interrompe). Estratto da `dispatchLLMChatStructuredStreaming` per essere
 * condiviso con la variante PLAIN (`dispatchLLMChatStreaming`).
 */
async function consumeOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<{ promptTokens?: number; completionTokens?: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let sseBuffer = '';
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    // Ogni evento è delimitato da \n\n; teniamo l'ultima riga parziale nel buffer.
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed?.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          try { onDelta(delta); } catch { /* never fail stream on cb error */ }
        }
        if (parsed.usage) {
          if (typeof parsed.usage.prompt_tokens === 'number') promptTokens = parsed.usage.prompt_tokens;
          if (typeof parsed.usage.completion_tokens === 'number') completionTokens = parsed.usage.completion_tokens;
        }
      } catch {
        // skip malformed SSE line
      }
    }
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
}

/**
 * Plumbing condiviso per lo streaming Liara/vLLM (single-shot, no_think).
 * `jsonSchema` opzionale: presente → `response_format` json_schema (output
 * vincolato, usato dallo scaffold); assente → streaming PLAIN (node-generator).
 * Ritorna il content FINALE accumulato (ripulito dei tag <think>).
 */
async function streamLiaraChat(opts: {
  model: string;
  system: string;
  msgs: ChatMessage[];
  baseUrl: string | undefined;
  jsonSchema?: object;
  onChunk: (delta: string) => void;
  tokenUsageListener?: TokenUsageListener;
}): Promise<string> {
  if (!isLiaraEnabled()) {
    throw new Error('Liara è disabilitata su questa istanza (MEDEA_DISABLE_LIARA=true).');
  }
  const { model, msgs, baseUrl, jsonSchema, onChunk, tokenUsageListener } = opts;
  const url = `${baseUrl ?? liaraBaseUrl()}/chat/completions`;
  const licenseKey = process.env.MEDEA_LICENSE_KEY ?? '';
  const fullSystem = `/no_think\n${opts.system}`;
  const CHARS_PER_TOKEN = 3.5;
  const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);
  const inputTokensEstimated =
    estimateTokens(fullSystem) +
    msgs.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
    msgs.length * 4;
  const contextWindow = getLiaraContextWindow();
  const safetyMargin = 1024;
  const rawCeiling = Number(process.env.MEDEA_LIARA_SINGLESHOT_MAX_TOKENS ?? '16000');
  const maxTokensCeiling = Number.isFinite(rawCeiling) && rawCeiling > 0 ? rawCeiling : 16000;
  const dynamicMax = Math.max(
    2048,
    Math.min(maxTokensCeiling, contextWindow - inputTokensEstimated - safetyMargin),
  );

  const body: Record<string, unknown> = {
    messages: [{ role: 'system', content: fullSystem }, ...msgs],
    temperature: 0.1,
    max_tokens: dynamicMax,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  };
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'workflow_scaffold', strict: true, schema: jsonSchema },
    };
  }
  if (model && model.trim().length > 0) body.model = model;

  const liaraTimeoutMs = Number(process.env.MEDEA_LIARA_TIMEOUT_MS ?? '240000');
  const liaraCtrl = new AbortController();
  const liaraTimeoutId = setTimeout(() => liaraCtrl.abort(), liaraTimeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: liaraCtrl.signal,
    });
  } catch (err) {
    clearTimeout(liaraTimeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Liara single-shot streaming timeout dopo ${liaraTimeoutMs.toString()}ms.`);
    }
    throw err;
  }
  if (!res.ok) {
    clearTimeout(liaraTimeoutId);
    throw new Error(`Liara streaming ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 300)}`);
  }
  if (!res.body) {
    clearTimeout(liaraTimeoutId);
    throw new Error('Liara streaming: response.body missing');
  }

  let accumulated = '';
  let usage: { promptTokens?: number; completionTokens?: number };
  try {
    usage = await consumeOpenAiSseStream(res.body, (delta) => {
      accumulated += delta;
      onChunk(delta);
    });
  } finally {
    clearTimeout(liaraTimeoutId);
  }

  // Strip residual <think> tags (no_think dovrebbe averli evitati)
  const cleaned = accumulated.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  if (tokenUsageListener) {
    if (typeof usage.promptTokens === 'number' && typeof usage.completionTokens === 'number') {
      tokenUsageListener({ input: usage.promptTokens, output: usage.completionTokens, fromApi: true });
    } else {
      tokenUsageListener({ input: inputTokensEstimated, output: estimateTokens(cleaned), fromApi: false });
    }
  }
  return cleaned;
}

/**
 * Streaming version of dispatchLLMChatStructured.
 *
 * vLLM SSE stream:true + onChunk callback per ogni delta.content.
 * Il caller (singleshot.service) usa SingleshotStreamParser per parsare
 * incrementalmente e emettere SSE per ogni nodo completato.
 *
 * Ritorna il content FINALE accumulato (per Zod parse downstream).
 * Funziona SOLO con Liara (vLLM). Per altri provider, fallback a non-stream
 * version (dispatchLLMChatStructured).
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
  // Fallback non-streaming per non-Liara
  if (provider !== 'liara') {
    const full = await dispatchLLMChatStructured(
      provider, apiKey, model, system, userMessage, baseUrl, history, jsonSchema, tokenUsageListener,
    );
    // Emit pseudo-chunks per coerenza UX (no streaming reale ma UI same flow)
    onChunk(full);
    return full;
  }

  const msgs = [...history, { role: 'user' as const, content: userMessage }];
  return streamLiaraChat({
    model, system, msgs, baseUrl, jsonSchema, onChunk,
    ...(tokenUsageListener ? { tokenUsageListener } : {}),
  });
}

/**
 * dispatchLLMChatStreaming — streaming token-by-token PLAIN (senza JSON-schema
 * constraint). È il gemello streaming di `dispatchLLMChat`: pensato per le
 * superfici che vogliono progressione live del testo (es. node-generator AI).
 *
 * Liara/vLLM: SSE stream:true + onChunk per ogni delta (no_think per output
 * pulito e first-token rapido). Altri provider: fallback non-streaming via
 * `dispatchLLMChat` + un singolo pseudo-chunk col testo intero (UX coerente).
 * Ritorna il content finale accumulato (ripulito dei tag <think>).
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
  if (provider !== 'liara') {
    const full = await dispatchLLMChat(
      provider, apiKey, model, system, userMessage, baseUrl, history, tokenUsageListener,
    );
    onChunk(full);
    return full;
  }

  const msgs = [...history, { role: 'user' as const, content: userMessage }];
  return streamLiaraChat({
    model, system, msgs, baseUrl, onChunk,
    ...(tokenUsageListener ? { tokenUsageListener } : {}),
  });
}
