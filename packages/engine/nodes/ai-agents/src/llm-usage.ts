/**
 * Fase 1a (#12) — usage token per-nodo per gli agent_*.
 *
 * Campo standard `_llm` nell'output di ogni agent: token in/out + modello +
 * provider + provenienza del conteggio. I numeri vengono dalla API del
 * provider quando la risposta li include (fromApi:true, precisi); altrimenti
 * stima locale ~3.5 char/token (fromApi:false) — stessa costante di
 * llm-chat.service.ts (CHARS_PER_TOKEN) per coerenza chat ↔ nodi.
 *
 * Modulo separato da index.ts (regola no-monoliti) e browser-safe come il
 * resto del package: nessun import node:*.
 */

/** Metadata usage esposto in `output._llm` (contratto Fase 1a, letto dalla card del pannello nodo in Fase 4). */
export interface AgentLlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Modello EFFETTIVO inviato al provider (default del case incluso), non il config grezzo. */
  model: string;
  provider: string;
  /** true = conteggi dalla API del provider (precisi); false = stima locale ~3.5 char/token. */
  fromApi: boolean;
}

/** Conteggi grezzi come riportati dalla risposta API del provider, già mappati input/output. */
export interface ApiTokenCounts {
  input?: number | undefined;
  output?: number | undefined;
}

// Allineata a apps/flowforge-runtime/src/services/llm-chat.service.ts:
// ~3.5 char/token medio per testo IT/EN misto + JSON.
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Un conteggio API è usabile solo se è un numero finito ≥ 0 (NaN/negativi/assenti → stima). */
function toFiniteCount(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Costruisce l'usage di UNA chiamata LLM. `sentSystem`/`sentUser` sono i testi
 * COME INVIATI (es. liara: system già prefissato /no_think); `receivedText` è
 * il testo COME RICEVUTO (pre strip <think>): la stima deve avvicinarsi ai
 * token realmente generati, non a quelli sopravvissuti al post-processing.
 * fromApi è true solo se il provider riporta ENTRAMBI i conteggi: un numero
 * solo non basta a dichiarare "preciso" l'intero oggetto.
 */
export function buildAgentUsage(args: {
  provider: string;
  model: string;
  sentSystem: string;
  sentUser: string;
  receivedText: string;
  api?: ApiTokenCounts | undefined;
}): AgentLlmUsage {
  const apiIn = toFiniteCount(args.api?.input);
  const apiOut = toFiniteCount(args.api?.output);
  const fromApi = apiIn !== undefined && apiOut !== undefined;
  return {
    inputTokens: fromApi ? apiIn : estimateTokens(args.sentSystem) + estimateTokens(args.sentUser),
    outputTokens: fromApi ? apiOut : estimateTokens(args.receivedText),
    model: args.model,
    provider: args.provider,
    fromApi,
  };
}

/**
 * Somma l'usage di più chiamate dello STESSO nodo (repair pass JSON = 2ª
 * chiamata, stesso provider/model). fromApi resta true solo se TUTTE le
 * chiamate erano precise: un totale misto API+stima è una stima.
 */
export function sumAgentUsage(a: AgentLlmUsage, b: AgentLlmUsage): AgentLlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    model: a.model,
    provider: a.provider,
    fromApi: a.fromApi && b.fromApi,
  };
}

/**
 * Attacca `_llm` all'output SENZA cambiarne la forma dati:
 *   • oggetto plain → copia con `_llm` (i campi dati restano byte-identici;
 *     un eventuale `_llm` echeggiato dal modello viene sovrascritto: è metadata
 *     nostro, non contenuto);
 *   • stringa (translator), array (extractor con schema-array), primitivi →
 *     INVARIATI: incartarli in un oggetto romperebbe le chain downstream che
 *     consumano il valore nudo. Limite noto della Fase 1a, documentato: per
 *     queste forme l'usage arriverà dal canale log per-step (Fase 3).
 */
export function attachAgentUsage(output: unknown, usage: AgentLlmUsage): unknown {
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    return { ...(output as Record<string, unknown>), _llm: usage };
  }
  return output;
}
