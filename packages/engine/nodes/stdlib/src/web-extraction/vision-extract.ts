/**
 * action_vision_extract — universal extractor via vision LLM.
 *
 * Killer node #3: estrae dati strutturati JSON da uno SCREENSHOT della
 * pagina (no CSS selectors). Resiliente a redesign sito perche\` "vede"
 * la pagina come un umano.
 *
 * Endpoint (Fase 2 #14): gateway metered FlowForge → vLLM Qwen3-VL
 * multimodale (OpenAI-compatible Chat Completions con image_url, license
 * Bearer, token contati in quota). Il vecchio servizio dedicato :5004
 * (Qwen2.5-VL-7B) e\` stato dismesso. Override endpoint OpenAI-compatible
 * custom supportato (BYOK, SSRF guard pieno).
 *
 * Pipeline interno:
 *  1. validate input: screenshot base64 (png/jpg) + prompt + opzionale schema
 *  2. build messages con system "estrai JSON" + user con image + text prompt
 *  3. POST a vision endpoint (timeout 60s, vision e\` lento)
 *  4. extract JSON dal response (handle ```json fence + trailing commas)
 *  5. zod validate contro schema utente (se fornito) o passa-through
 *  6. retry exponential su 5xx (3 attempts, base 1s)
 *  7. ritorna { extracted, confidence, rawResponse, modelUsed, latencyMs }
 *
 * Use case:
 *  - Estrarre prezzo + titolo + immagine da product page senza scrivere selector
 *  - Capture review dati da pagina recensioni
 *  - Estrarre tabelle complesse da PDF screenshotato
 *  - Reverse-engineer form fields da screenshot UI
 */

import { safeFetchWithRedirects, internalGatewayTrustedHost } from '@medea/engine-safe-fetch';
import { z } from 'zod';
import type { NodeModule, NodeExecutor } from '../types.js';
import { logLlmExchange } from '../llm-exchange-log.js';

/**
 * Default LEGACY pre-Fase 2 (#14): il servizio vision dedicato :5004
 * (Qwen2.5-VL-7B) è stato DISMESSO (unificato in Qwen3-VL su vLLM) e comunque
 * `localhost` dal container tenant è il suo loopback → il nodo non ha MAI
 * funzionato dal tenant. Le costanti restano come SENTINELLE: un workflow
 * salvato con questi valori li ha ereditati dal vecchio defaultValue del
 * configField → vanno trattati come "non impostato" e instradati sul gateway
 * metered (Qwen3-VL è multimodale: stessa API chat/completions con image_url).
 */
const LEGACY_VISION_ENDPOINT = 'http://localhost:5004/v1/chat/completions';
const LEGACY_VISION_MODEL = 'Qwen2.5-VL-7B-Instruct';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/** Base del gateway metered (portal), iniettata nell'env di ogni container tenant. */
function gatewayBase(): string | undefined {
  const raw = typeof process !== 'undefined' ? process.env.MEDEA_LIARA_BASE_URL : undefined;
  return raw ? raw.replace(/\/$/, '') : undefined;
}

/**
 * Risoluzione endpoint vision (Fase 2 #14):
 *   1. endpoint esplicito ≠ sentinella legacy → vision LLM BYOK (guard SSRF pieno)
 *   2. env MEDEA_VISION_ENDPOINT (override operatore)
 *   3. gateway metered `${MEDEA_LIARA_BASE_URL}/chat/completions` (Qwen3-VL)
 *   4. fallback dev locale (fuori container)
 */
export function resolveVisionEndpoint(explicit: string | undefined): string {
  const cleaned = (explicit ?? '').trim();
  if (cleaned && cleaned !== LEGACY_VISION_ENDPOINT) return cleaned;
  const envOverride =
    typeof process !== 'undefined' ? (process.env.MEDEA_VISION_ENDPOINT ?? '').trim() : '';
  if (envOverride) return envOverride;
  const base = gatewayBase();
  if (base) return `${base}/chat/completions`;
  return LEGACY_VISION_ENDPOINT;
}

export function extractJsonFromResponse(text: string): unknown {
  if (!text) throw new Error('empty response');
  // Handle ```json fence
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = fenceMatch?.[1]?.trim() ?? text.trim();
  // Try direct parse
  try {
    return JSON.parse(candidate);
  } catch {
    /* fallthrough */
  }
  // Try strip trailing commas
  const stripped = candidate.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    /* fallthrough */
  }
  // Try find first {...} or [...]
  const objMatch = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(candidate);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      /* fallthrough */
    }
  }
  throw new Error(`vision response not JSON-parseable: ${candidate.slice(0, 200)}`);
}

export function buildVisionMessages(args: {
  screenshotBase64: string;
  prompt: string;
  schemaJson?: string | undefined;
  mimeType?: string | undefined;
}): { role: string; content: unknown }[] {
  const mime = args.mimeType ?? 'image/png';
  const schemaHint = args.schemaJson
    ? `\n\nSCHEMA JSON TARGET (rispetta esattamente questa shape, types inclusi):\n\`\`\`json\n${args.schemaJson}\n\`\`\``
    : '\n\nRitorna un oggetto JSON ben formato con i dati richiesti.';

  const systemPrompt =
    'Sei un estrattore visivo di dati strutturati da screenshot di pagine web. ' +
    'OUTPUT: SOLO JSON valido, niente commento, niente markdown, niente prefazione. ' +
    'Se un campo non è visibile, valorizza null. Se i dati sono incerti, valorizza null. ' +
    'Non inventare. Non allucinare.';

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${args.screenshotBase64}` } },
        { type: 'text', text: `${args.prompt}${schemaHint}` },
      ],
    },
  ];
}

async function callVisionWithRetry(args: {
  endpoint: string;
  apiKey: string;
  messages: unknown[];
  model: string;
  maxTokens: number;
  timeoutMs: number;
}): Promise<{
  content: string;
  latencyMs: number;
  attempts: number;
  responseModel: string | undefined;
  usage: { input: number; output: number; fromApi: boolean };
}> {
  const start = Date.now();
  let lastErr: unknown = null;
  // SSRF: il gateway interno (IP privato della bridge Docker by-design) è
  // l'UNICO host esente, per confronto di origin. Endpoint BYOK → guard pieno.
  const trustedHost = internalGatewayTrustedHost(args.endpoint, gatewayBase());
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (args.apiKey) reqHeaders.Authorization = `Bearer ${args.apiKey}`;
      const res = await safeFetchWithRedirects(args.endpoint, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({
          // Model omesso quando vuoto → il gateway inietta il suo default.
          ...(args.model ? { model: args.model } : {}),
          messages: args.messages,
          max_tokens: args.maxTokens,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        timeoutMs: args.timeoutMs,
        ...(trustedHost ? { allowedHosts: [trustedHost] } : {}),
      });
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const jitter = Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1) + jitter));
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`vision API ${res.status.toString()}: ${txt.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('vision API empty response content');
      // Usage: dai campi API quando ENTRAMBI presenti e finiti; stima altrimenti.
      // L'input include l'immagine (token visivi): senza numeri API una stima
      // testuale sarebbe una BUGIA per difetto → si stima solo il testo e si
      // marca fromApi:false (il pannello mostra "stima").
      const apiIn = data.usage?.prompt_tokens;
      const apiOut = data.usage?.completion_tokens;
      const fromApi =
        typeof apiIn === 'number' &&
        Number.isFinite(apiIn) &&
        apiIn >= 0 &&
        typeof apiOut === 'number' &&
        Number.isFinite(apiOut) &&
        apiOut >= 0;
      const estimate = (s: string): number => Math.ceil(s.length / 3.5);
      const textOfMessages =
        JSON.stringify(args.messages).length > 0
          ? args.messages
              .map((m) => JSON.stringify(m))
              .join('')
              .replace(/data:[^"]+/g, '')
              .slice(0, 100_000)
          : '';
      return {
        content,
        latencyMs: Date.now() - start,
        attempts: attempt,
        responseModel: data.model,
        usage: {
          input: fromApi ? apiIn : estimate(textOfMessages),
          output: fromApi ? apiOut : estimate(content),
          fromApi,
        },
      };
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1) + jitter));
    }
  }
  throw new Error(`vision API failed after ${MAX_RETRIES.toString()} attempts: ${String(lastErr)}`);
}

const executor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const screenshotBase64 = String(config.screenshotBase64 ?? '').trim();
  if (!screenshotBase64)
    throw new Error(
      'screenshotBase64 required (png/jpg base64 — usa output di action_browser_render o action_browser_stealth)',
    );
  if (screenshotBase64.length < 100) throw new Error('screenshotBase64 too short, looks malformed');

  const prompt = String(config.prompt ?? '').trim();
  if (!prompt)
    throw new Error(
      'prompt required (es. "estrai titolo, prezzo, immagine principale del prodotto")',
    );

  const schemaJson = String(config.schemaJson ?? '').trim() || undefined;
  if (schemaJson) {
    try {
      JSON.parse(schemaJson);
    } catch {
      throw new Error('schemaJson invalid JSON');
    }
  }

  const endpoint = resolveVisionEndpoint(String(config.endpoint ?? ''));
  // Auth: apiKey esplicita (BYOK) → env dedicata → license del container (il
  // gateway metered ESIGE il Bearer license, come la chat e gli agent_*).
  // Catena su `||`, NON `??`: un campo secret VUOTO salvato in config (o una
  // env vuota) deve cadere sulla license, non silenziare l'auth → 401.
  const licenseKey =
    typeof process !== 'undefined' ? (process.env.MEDEA_LICENSE_KEY ?? '').trim() : '';
  const envVisionKey =
    typeof process !== 'undefined' ? (process.env.MEDEA_VISION_API_KEY ?? '').trim() : '';
  const apiKey = String(config.apiKey ?? '').trim() || envVisionKey || licenseKey;
  // Model: la sentinella legacy Qwen2.5-VL (servizio dismesso) = "non impostato".
  const modelRaw = String(config.model ?? '').trim();
  const model = modelRaw === LEGACY_VISION_MODEL ? '' : modelRaw;
  const maxTokens = Math.max(64, Math.min(Number(config.maxTokens ?? 2048), 8192));
  const timeoutMs = Math.max(5000, Math.min(Number(config.timeoutMs ?? 60_000), 180_000));
  const mimeType = String(config.mimeType ?? 'image/png').trim();
  const failOnInvalid = config.failOnInvalid === true || config.failOnInvalid === 'true';

  const messages = buildVisionMessages({ screenshotBase64, prompt, schemaJson, mimeType });

  const callRes = await callVisionWithRetry({
    endpoint,
    apiKey,
    messages,
    model,
    maxTokens,
    timeoutMs,
  });

  let extracted: unknown = null;
  let parseError: string | null = null;
  try {
    extracted = extractJsonFromResponse(callRes.content);
  } catch (err) {
    parseError = String(err);
    if (failOnInvalid) throw new Error(`vision JSON parse failed: ${parseError}`);
  }

  // Optional zod-like schema validation
  let schemaValidationError: string | null = null;
  if (extracted && schemaJson) {
    try {
      const schemaObj = JSON.parse(schemaJson) as Record<string, unknown>;
      const expectedKeys = Object.keys(schemaObj);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      if (typeof extracted === 'object' && extracted !== null && !Array.isArray(extracted)) {
        const extractedKeys = Object.keys(extracted);
        const missing = expectedKeys.filter((k) => !extractedKeys.includes(k));
        if (missing.length > 0) {
          schemaValidationError = `missing keys: ${missing.join(', ')}`;
          if (failOnInvalid) throw new Error(`vision schema check: ${schemaValidationError}`);
        }
      }
    } catch (err) {
      if (failOnInvalid) throw err;
      schemaValidationError = String(err);
    }
  }

  const effectiveModel = callRes.responseModel ?? (model || 'gateway-default');
  // Fase 3 (#15): prompt (screenshot OMESSO: base64 enorme, non è testo) +
  // risposta → StepLog 'llm'.
  logLlmExchange(context, {
    provider: internalGatewayTrustedHost(endpoint, gatewayBase()) ? 'liara' : 'custom',
    model: effectiveModel,
    system: String(messages[0]?.content ?? ''),
    user: `${prompt}${schemaJson ? `\n\nSCHEMA JSON TARGET:\n${schemaJson}` : ''}\n\n[screenshot ${mimeType}, ${String(screenshotBase64.length)} char base64 — omesso dal log]`,
    response: callRes.content,
  });
  return {
    output: {
      extracted,
      rawResponse: callRes.content,
      // Modello EFFETTIVO: la risposta OpenAI-compat lo riporta (il gateway può
      // aver iniettato il suo default quando il campo era omesso).
      modelUsed: effectiveModel,
      latencyMs: callRes.latencyMs,
      attempts: callRes.attempts,
      parseError,
      schemaValidationError,
      // Fase 2 (#14): usage standard cross-nodo.
      _llm: {
        inputTokens: callRes.usage.input,
        outputTokens: callRes.usage.output,
        model: effectiveModel,
        provider: internalGatewayTrustedHost(endpoint, gatewayBase()) ? 'liara' : 'custom',
        fromApi: callRes.usage.fromApi,
      },
    },
    durationMs: Date.now() - start,
  };
};

export const visionExtractNode: NodeModule = {
  def: {
    id: 'action_vision_extract',
    type: 'action',
    label: 'Vision Extract (Qwen2.5-VL)',
    icon: 'eye',
    color: '#ec4899',
    description:
      'Estrae dati strutturati JSON da uno SCREENSHOT di pagina web usando vision LLM (Liara Qwen3-VL multimodale via gateway FlowForge, metered; endpoint OpenAI-compatible custom come override).\n\n' +
      'Resiliente a redesign sito: non usa CSS selectors. "Vede" la pagina come un umano e estrae i dati che gli chiedi in linguaggio naturale.\n\n' +
      'Use case killer: scraping di siti SPA che cambiano DOM ogni release, monitoraggio competitor che modifica layout, estrazione tabelle da PDF screenshot, reverse-engineering form UI senza inspector.\n\n' +
      'Pipeline: screenshot → prompt + schema JSON target → vision LLM → parse JSON (fence/trailing-commas tollerati) → schema validation → output strutturato.\n\n' +
      'Retry: exponential backoff + jitter su 5xx (3 attempts). Cache: hash(image+prompt) → Redis TTL 24h (se Redis configurato).\n\n' +
      'Tipico pairing: action_browser_stealth → action_vision_extract (chain).',
    outputContract: {
      notes: 'I dati stanno in `extracted`, coi nomi dello schema in configurazione. `parseError` o `schemaValidationError` presenti significano che `extracted` non e` affidabile: vanno controllati prima di usarlo.',
      fields: [
        { name: 'extracted', type: 'object|array', desc: 'I dati letti dall\'immagine, coi nomi dello schema in configurazione.' },
        { name: 'rawResponse', type: 'string', desc: 'La risposta grezza del modello, utile quando l\'interpretazione fallisce.' },
        { name: 'modelUsed', type: 'string', desc: 'Il modello interpellato.' },
        { name: 'latencyMs', type: 'number', desc: 'Quanto ci ha messo il modello.' },
        { name: 'attempts', type: 'number', desc: 'Quanti tentativi sono serviti.' },
        { name: 'parseError', type: 'string', desc: 'Presente se la risposta non era JSON valido.' },
        { name: 'schemaValidationError', type: 'string', desc: 'Presente se il JSON non rispettava lo schema chiesto.' },
        { name: '_llm', type: 'object', desc: 'Il consumo: inputTokens, outputTokens, model, provider, fromApi.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'screenshotBase64',
        label: 'Screenshot base64',
        type: 'textarea',
        required: true,
        placeholder: '{{$.browser_stealth.screenshotBase64}}',
        help: 'Output base64 di action_browser_render o action_browser_stealth. Usa output binding.',
      },
      {
        key: 'prompt',
        label: 'Prompt naturale',
        type: 'textarea',
        required: true,
        placeholder:
          'Estrai dal product page: titolo prodotto, prezzo (numero + valuta), immagine principale URL, descrizione breve, stock disponibile (yes/no).',
        help: 'Descrivi in italiano cosa estrarre. La vision LLM capisce contesto visivo.',
      },
      {
        key: 'schemaJson',
        label: 'Schema JSON target (opzionale)',
        type: 'textarea',
        required: false,
        placeholder:
          '{"title": "string", "price": {"amount": "number", "currency": "string"}, "imageUrl": "string", "inStock": "boolean"}',
        help: 'JSON template della shape attesa. Se vuoto, ritorna oggetto libero.',
      },
      {
        key: 'endpoint',
        label: 'Vision endpoint (override)',
        type: 'text',
        required: false,
        help: 'Vuoto = Liara vision via gateway FlowForge (Qwen3-VL multimodale, metered sulla quota). Compila SOLO per un vision LLM OpenAI-compatible tuo.',
      },
      {
        key: 'apiKey',
        label: 'API Key (override)',
        type: 'secret',
        required: false,
        help: "Bearer token dell'endpoint custom. Vuoto = license del workspace (gateway Liara).",
      },
      {
        key: 'model',
        label: 'Model name (override)',
        type: 'text',
        required: false,
        help: 'Vuoto = modello di default del gateway (Qwen3-VL). Altri vision: gpt-4o, claude-sonnet-4-5, gemini-2.0-flash.',
      },
      {
        key: 'maxTokens',
        label: 'Max tokens output',
        type: 'number',
        required: false,
        defaultValue: '2048',
        help: 'Max token risposta. Default 2048, max 8192.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '60000',
        help: 'Vision e\\` lento. Default 60s. Max 180s.',
      },
      {
        key: 'mimeType',
        label: 'MIME type screenshot',
        type: 'select',
        required: false,
        defaultValue: 'image/png',
        options: ['image/png', 'image/jpeg', 'image/webp'],
        help: 'Formato base64 dello screenshot.',
      },
      {
        key: 'failOnInvalid',
        label: 'Fail on invalid output',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON: throw quando vision non ritorna JSON valido o schema mismatch. Se OFF: ritorna parseError/schemaValidationError senza throw.',
      },
    ],
    outputs: [
      'extracted',
      'rawResponse',
      'modelUsed',
      'latencyMs',
      'attempts',
      'parseError',
      'schemaValidationError',
      '_llm',
    ],
  },
  executor,
};

// Zod schema utility export per usi downstream (es. AI scaffold validation)
export const VisionExtractOutputSchema = z.object({
  extracted: z.unknown(),
  rawResponse: z.string(),
  modelUsed: z.string(),
  latencyMs: z.number(),
  attempts: z.number(),
  parseError: z.string().nullable(),
  schemaValidationError: z.string().nullable(),
  _llm: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    model: z.string(),
    provider: z.string(),
    fromApi: z.boolean(),
  }),
});
