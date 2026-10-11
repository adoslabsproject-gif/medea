/**
 * extractWithLlm — chiama un LLM con HTML + prompt naturale → JSON.
 *
 * Estrazione text-based (no vision). Per estrazione visiva usa vision-extract.
 *
 * Approccio: passa HTML SANITIZED (no script/style, no inline event handlers)
 * + prompt naturale + schema target. LLM ritorna JSON puro grazie a
 * response_format: json_object.
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';

/**
 * Il vecchio valore predefinito del campo endpoint: puntava al loopback, dove
 * non ascolta nulla. Un workflow salvato con questo valore lo ha ereditato dal
 * configField, NON lo ha scelto → vale "non impostato".
 */
const LEGACY_ENDPOINT_DEFAULT = 'http://localhost:3003/v1/chat/completions';

const MAX_HTML_CHARS = 60_000;

/** Manca l'endpoint del modello: il messaggio dice dove indicarlo. */
export class LlmEndpointMissingError extends Error {
  constructor() {
    super(
      'Endpoint LLM non configurato: indica sul nodo un endpoint OpenAI-compatibile ' +
        '(es. https://api.openai.com/v1/chat/completions) con la sua API key e il modello.',
    );
    this.name = 'LlmEndpointMissingError';
  }
}

/**
 * Risoluzione endpoint:
 *   1. endpoint esplicito sul nodo (OpenAI-compat, guard SSRF pieno)
 *   2. env MEDEA_LLM_ENDPOINT (override di chi gestisce l'installazione)
 *   3. nessuno → errore che dice cosa manca. Non esiste un modello di ripiego.
 */
export function resolveLlmEndpoint(explicit: string | undefined): string {
  const cleaned = (explicit ?? '').trim();
  if (cleaned && cleaned !== LEGACY_ENDPOINT_DEFAULT) return cleaned;
  const envOverride =
    typeof process !== 'undefined' ? (process.env.MEDEA_LLM_ENDPOINT ?? '').trim() : '';
  if (envOverride) return envOverride;
  throw new LlmEndpointMissingError();
}

export function sanitizeHtmlForLlm(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+on[a-z]+="[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HTML_CHARS);
}

export interface ExtractWithLlmArgs {
  html: string;
  prompt: string;
  schemaJson?: string | undefined;
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ExtractWithLlmResult {
  extracted: unknown;
  rawResponse: string;
  modelUsed: string;
  latencyMs: number;
  parseError: string | null;
  htmlCharsUsed: number;
  /** Token della chiamata (Fase 2 #14) — dai campi usage della risposta OpenAI-compat quando presenti, stima ~3.5 char/token altrimenti. */
  usage: { input: number; output: number; fromApi: boolean };
  /** Sempre 'custom': l'endpoint OpenAI-compat è quello indicato dall'utente. */
  provider: 'custom';
  /** Prompt come inviati (Fase 3 #15) — il CHIAMANTE (scrape-smart) li logga su StepLog 'llm'. */
  sentSystem: string;
  sentUser: string;
}

export function extractJsonLoose(text: string): unknown {
  if (!text) throw new Error('empty');
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = fence?.[1]?.trim() ?? text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall */
  }
  const stripped = candidate.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall */
  }
  const obj = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(candidate);
  if (obj) {
    try {
      return JSON.parse(obj[0]);
    } catch {
      /* fall */
    }
  }
  throw new Error('not parseable');
}

export async function extractWithLlm(args: ExtractWithLlmArgs): Promise<ExtractWithLlmResult> {
  const start = Date.now();
  const sanitized = sanitizeHtmlForLlm(args.html);
  if (!sanitized) throw new Error('html empty after sanitize');

  const endpoint = resolveLlmEndpoint(args.endpoint);
  // Auth: apiKey esplicita sul nodo → env dedicata. Catena su `||`, NON `??`:
  // un campo secret VUOTO salvato in config deve cadere sull'env, non
  // silenziare l'auth → 401.
  const envKey = typeof process !== 'undefined' ? (process.env.MEDEA_LLM_API_KEY ?? '').trim() : '';
  const apiKey = (args.apiKey ?? '').trim() || envKey;
  const model = (args.model ?? '').trim();
  const maxTokens = Math.max(64, Math.min(args.maxTokens ?? 2048, 8192));
  const timeoutMs = Math.max(5000, Math.min(args.timeoutMs ?? 45_000, 180_000));

  const schemaHint = args.schemaJson
    ? `\n\nSCHEMA JSON TARGET (rispetta esatta shape):\n\`\`\`json\n${args.schemaJson}\n\`\`\``
    : '\n\nRitorna oggetto JSON ben formato.';

  const systemPrompt =
    'Sei un estrattore di dati strutturati da HTML. ' +
    'OUTPUT: SOLO JSON valido, niente markdown, niente prefazione, niente commento. ' +
    'Campi non trovati = null. Non inventare. Non allucinare.';

  const userPrompt = `${args.prompt}${schemaHint}\n\nHTML:\n${sanitized}`;

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;

  // SSRF: l'endpoint è scelto dall'utente → guard pieno, nessun host esente.
  const res = await safeFetchWithRedirects(endpoint, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      ...(model ? { model } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
    timeoutMs,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM extract failed: ${res.status.toString()} ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? '';

  let extracted: unknown = null;
  let parseError: string | null = null;
  try {
    extracted = extractJsonLoose(content);
  } catch (err) {
    parseError = String(err);
  }

  // Usage: dai campi API quando ENTRAMBI presenti e finiti, stima altrimenti
  // (stessa costante ~3.5 char/token di llm-chat.service / nodes-ai-agents).
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
  const usage = {
    input: fromApi ? apiIn : estimate(systemPrompt) + estimate(userPrompt),
    output: fromApi ? apiOut : estimate(content),
    fromApi,
  };

  return {
    extracted,
    rawResponse: content,
    // Modello EFFETTIVO: la risposta OpenAI-compat lo riporta (l'endpoint può
    // aver scelto il suo default quando il campo era omesso).
    modelUsed: data.model ?? (model || 'endpoint-default'),
    latencyMs: Date.now() - start,
    parseError,
    htmlCharsUsed: sanitized.length,
    usage,
    provider: 'custom',
    sentSystem: systemPrompt,
    sentUser: userPrompt,
  };
}
