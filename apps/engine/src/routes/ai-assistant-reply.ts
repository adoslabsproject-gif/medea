/**
 * STRATO 2 della robustezza chat Liara — estrazione + fallback grazioso dell'envelope.
 *
 * Il constrained decoding (guided_json, strato 1) garantisce JSON valido SOLO con
 * Liara/vLLM. Per provider BYOK o edge (proxy che tronca, prosa attorno al JSON,
 * fence ```json), l'output può comunque non essere conforme. Questo modulo PURO
 * estrae l'envelope nel modo più tollerante possibile e, in ultima istanza, degrada
 * a `{ message: <testo> }`. Non lancia MAI e non restituisce MAI 502: la chat di
 * Liara risponde in OGNI caso (incident 2026-06-16: Qwen3 tornava prosa → 502).
 *
 * PURE → testabile in isolamento (la route fa solo il wiring + la normalizzazione
 * della patch vuota + la capture).
 */

import { z } from 'zod';

/**
 * Schemi del reply dell'assistant — PURI (solo Zod), così sono testabili e
 * importabili senza tirarsi dietro i service della route (DB, conversazioni…).
 */
export const NodeRefSchema = z.object({
  id: z.string(),
  defId: z.string(),
  label: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const EdgeRefSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  fromPort: z.string().optional(),
});

export const AssistantReplySchema = z.object({
  message: z.string(),
  patch: z
    .object({
      addNodes: z.array(NodeRefSchema).optional(),
      removeNodeIds: z.array(z.string()).optional(),
      addEdges: z.array(EdgeRefSchema).optional(),
      removeEdgeIds: z.array(z.string()).optional(),
      updateNodes: z.array(z.object({ id: z.string(), patch: z.record(z.unknown()) })).optional(),
    })
    .optional(),
});

/**
 * Schema JSON per il CONSTRAINED DECODING (guided_json / xgrammar su vLLM).
 *
 * Mirror strutturale di `AssistantReplySchema`: forza Liara a emettere SEMPRE un
 * envelope JSON valido `{ message, patch? }` — è il decoder a garantirlo, non il
 * prompt. La forma fine dei nodi/edge resta `object` libero (config arbitraria);
 * la validazione semantica fine la fa comunque Zod a valle, col fallback grazioso.
 *
 * ⚠️ ANTI-DRIFT: un contract test asserisce che le chiavi di `patch` qui coincidono
 * con quelle Zod — se aggiungi un campo a uno, il test rompe finché non allinei l'altro.
 */
export const ASSISTANT_REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    patch: {
      type: 'object',
      properties: {
        addNodes: { type: 'array', items: { type: 'object' } },
        removeNodeIds: { type: 'array', items: { type: 'string' } },
        addEdges: { type: 'array', items: { type: 'object' } },
        removeEdgeIds: { type: 'array', items: { type: 'string' } },
        updateNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, patch: { type: 'object' } },
            required: ['id', 'patch'],
          },
        },
      },
    },
  },
  required: ['message'],
} as const;

/**
 * Vincolo strutturale minimo del reply: il `message` è sempre presente. Il tipo
 * concreto (con `patch` tipizzata) è preservato come generico `T` dal safeParse,
 * così la route lo riceve tipato — niente widening a `Record<string, unknown>`.
 */
export interface AssistantReplyLike {
  message: string;
}

/** safeParse-like generico: disaccoppia il modulo dall'import Zod della route. */
export type SafeParseFn<T extends AssistantReplyLike> = (
  value: unknown,
) => { success: true; data: T } | { success: false };

const EMPTY_REPLY_MESSAGE =
  'Non sono riuscita a formulare una risposta valida. Riprova o riformula la richiesta.';

/** Toglie i fence ```json … ``` se presenti, altrimenti ritorna il testo trimmato. */
export function stripCodeFences(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```(?:json)?\n?/u, '')
    .replace(/```$/u, '')
    .trim();
}

/**
 * Primo oggetto JSON BILANCIATO nel testo (gestisce prosa prima/dopo, e ignora le
 * graffe dentro le stringhe rispettando l'escaping). Ritorna l'oggetto parsato o
 * `undefined` se non c'è un oggetto bilanciato valido. Non lancia.
 */
export function extractFirstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Coerce dell'output LLM grezzo in un reply SEMPRE valido secondo `safeParse`.
 *
 * Cascata: (1) parse diretto del testo de-fenced → se conforme, usalo. (2) primo
 * oggetto JSON bilanciato annidato nella prosa → se conforme, usalo. (3) se un JSON
 * c'è ma non è conforme allo schema ma ha un `message` stringa, tieni SOLO il
 * messaggio (scarta la patch malformata). (4) ultimo fallback: l'intero testo come
 * messaggio. `conformed=false` segnala una degradazione (per warn/telemetria).
 */
export function coerceAssistantReply<T extends AssistantReplyLike>(
  raw: string,
  safeParse: SafeParseFn<T>,
): { reply: T; conformed: true } | { reply: { message: string }; conformed: false } {
  const stripped = stripCodeFences(raw);

  const direct = tryParse(stripped);
  const candidate = direct !== undefined ? direct : extractFirstJsonObject(stripped);

  if (candidate !== undefined) {
    const parsed = safeParse(candidate);
    if (parsed.success) return { reply: parsed.data, conformed: true };
    // JSON c'è ma non conforme: salva almeno il messaggio se è una stringa.
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as { message?: unknown }).message === 'string'
    ) {
      const msg = ((candidate as { message: string }).message).trim();
      return { reply: { message: msg || EMPTY_REPLY_MESSAGE }, conformed: false };
    }
  }

  return { reply: { message: stripped || EMPTY_REPLY_MESSAGE }, conformed: false };
}
