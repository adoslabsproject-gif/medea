/**
 * llm-exchange-log — Fase 3 (#15): ogni nodo AI logga il prompt COMPLETO
 * (system incluso — è la parte nascosta all'utente) + la risposta testuale
 * come StepLog `source:'llm'` nel run record.
 *
 * Il collector per-step viaggia nel context come `__logCollector` (stesso
 * precedente di custom-node.ts). Qui lo si usa in modo STRUTTURALE (duck
 * typing su `info(msg, fields, source)`) → nessuna dipendenza dal runtime,
 * il modulo è importabile da nodes-ai-agents e dagli executor runtime.
 *
 * Vincoli StepLog (log-collector): fields ≤ 4KB/entry, 256 entry / 64KB per
 * step → i testi vengono CHUNKATI in entry ordinate (part/of) e cappati con
 * marker di troncamento ONESTO. Il system prompt ha priorità: va loggato
 * SEMPRE integro (entro il suo cap) — è quello che l'owner vuole vedere.
 */

/** Cap per singolo chunk: sotto i 4KB di fields JSON-serializzati (overhead incluso). */
const CHUNK_CHARS = 3200;
/** Cap totale del testo prompt (system+user) per nodo. */
const PROMPT_CAP = 12_000;
/** Cap totale della risposta. */
const RESPONSE_CAP = 8_000;

/** Vista strutturale del LogCollector (runtime) — solo ciò che serve qui. */
export interface LlmLogSink {
  info(msg: string, fields?: Record<string, unknown>, source?: string): void;
}

/** Estrae il collector dal context se presente (engine reale); no-op nei test/context minimi. */
export function llmLogSinkFrom(context: unknown): LlmLogSink | undefined {
  const c = (context as { __logCollector?: unknown }).__logCollector;
  if (c !== null && typeof c === 'object' && typeof (c as { info?: unknown }).info === 'function') {
    return c as LlmLogSink;
  }
  return undefined;
}

function capped(text: string, cap: number): { text: string; truncatedChars: number } {
  if (text.length <= cap) return { text, truncatedChars: 0 };
  return { text: text.slice(0, cap), truncatedChars: text.length - cap };
}

function emitChunks(sink: LlmLogSink, kind: 'llm_prompt' | 'llm_response', label: string, raw: string, cap: number): void {
  const { text, truncatedChars } = capped(raw, cap);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
  if (parts.length === 0) parts.push('');
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    sink.info(
      `${label} (${String(i + 1)}/${String(parts.length)})`,
      {
        kind,
        part: i + 1,
        of: parts.length,
        text: parts[i],
        ...(isLast && truncatedChars > 0 ? { truncatedChars } : {}),
      },
      'llm',
    );
  }
}

export interface LlmExchange {
  provider: string;
  model: string;
  /** System prompt COMPLETO come inviato (per gli agent_* è la parte nascosta). */
  system: string;
  /** User prompt/payload come inviato. */
  user: string;
  /** Risposta testuale del modello (vuota se errore prima della risposta). */
  response: string;
  /** Etichetta della chiamata quando il nodo ne fa più d'una (es. 'repair', 'chunk 2/3', 'iterazione 1'). */
  phase?: string;
}

/**
 * Logga uno scambio LLM completo sul canale `llm` dello step corrente.
 * No-op se il context non porta un collector (test/context minimi): il
 * logging non deve MAI rompere l'esecuzione del nodo.
 */
export function logLlmExchange(context: unknown, ex: LlmExchange): void {
  const sink = llmLogSinkFrom(context);
  if (!sink) return;
  try {
    const phase = ex.phase ? ` [${ex.phase}]` : '';
    sink.info(
      `LLM exchange${phase} — ${ex.provider}/${ex.model || 'default'}`,
      {
        kind: 'llm_exchange',
        provider: ex.provider,
        model: ex.model || 'default',
        ...(ex.phase ? { phase: ex.phase } : {}),
        systemChars: ex.system.length,
        userChars: ex.user.length,
        responseChars: ex.response.length,
      },
      'llm',
    );
    // System prompt con PRIORITÀ di budget: integro fin dove il cap consente,
    // poi lo user col budget residuo. Mai user integro + system troncato.
    const sys = capped(ex.system, PROMPT_CAP);
    emitChunks(sink, 'llm_prompt', `prompt·system${phase}`, ex.system, PROMPT_CAP);
    const userBudget = Math.max(1000, PROMPT_CAP - sys.text.length);
    emitChunks(sink, 'llm_prompt', `prompt·user${phase}`, ex.user, userBudget);
    emitChunks(sink, 'llm_response', `risposta${phase}`, ex.response, RESPONSE_CAP);
  } catch {
    // logging best-effort: mai propagare
  }
}
