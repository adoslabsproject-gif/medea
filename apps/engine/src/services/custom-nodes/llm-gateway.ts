/**
 * LLM gateway helper — UNICO punto di routing verso il gateway portal per i
 * servizi custom-node (ai-assist, ai-inline).
 *
 * ⛔ I container tenant raggiungono SOLO il gateway portal (MEDEA_LIARA_BASE_URL
 * = http://<bridge>:3006/api/v1/llm), MAI `liara:3003` (liara è PM2 sull'host,
 * fuori dalla rete Docker del tenant). Fetch RAW (NON safeOutboundFetch: il
 * gateway è un IP privato trusted da env → niente SSRF; safeOutboundFetch lo
 * bloccherebbe come IP privato). license Bearer + /chat/completions + model
 * OMESSO (il gateway inietta UPSTREAM_MODEL).
 *
 * Centralizzare qui evita il ricorrere del bug "liara:3003 irraggiungibile" che
 * ha rotto in prod sia ai-assist sia ai-inline (ghost-text).
 *
 * @module services/custom-nodes/llm-gateway
 */

import { readJsonCapped } from '@/lib/capped-response.js';

export interface GatewayChatRequest {
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  /** Timeout della singola chiamata (ms). */
  timeoutMs: number;
  /** Scope tenant (header X-FF-Workspace per audit/usage). */
  workspaceId: string;
  /** Stop sequences (es. inline-completion). */
  stop?: string[];
  /** Marca la feature (header X-FF-Feature). */
  feature?: string;
  /** Override esplicito del model (BYOK). Default: gateway inietta UPSTREAM_MODEL. */
  modelOverride?: string;
}

export interface GatewayChatResult {
  ok: boolean;
  status: number;
  content: string;
  usage: { input: number; output: number };
}

/** Risolve la base del gateway portal (mai liara:3003 in prod). */
export function gatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEDEA_LIARA_BASE_URL ?? env.LLM_API_BASE ?? 'http://liara:3003';
}

/**
 * Chiamata chat-completions al gateway portal. THROW solo su errore di
 * rete/timeout (fetch); su risposta non-2xx ritorna `{ ok:false }` (il chiamante
 * decide se rilanciare o fallback). Non lancia su 4xx/5xx.
 */
export async function gatewayChatCompletions(req: GatewayChatRequest): Promise<GatewayChatResult> {
  const base = gatewayBaseUrl();
  const licenseKey = process.env.MEDEA_LICENSE_KEY ?? process.env.LLM_API_KEY ?? '';

  const body: Record<string, unknown> = {
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  if (req.modelOverride && req.modelOverride !== 'liara') body.model = req.modelOverride;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-FF-Workspace': req.workspaceId,
      ...(req.feature ? { 'X-FF-Feature': req.feature } : {}),
      ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs),
  });

  if (!res.ok) {
    return { ok: false, status: res.status, content: '', usage: { input: 0, output: 0 } };
  }
  const json = await readJsonCapped<{
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>(res);
  return {
    ok: true,
    status: res.status,
    content: json.choices?.[0]?.message?.content ?? '',
    usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
  };
}
