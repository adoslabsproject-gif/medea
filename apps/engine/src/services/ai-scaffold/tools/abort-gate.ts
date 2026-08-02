/**
 * abort-gate — guard contro aborts hallucinati.
 *
 * Bug osservato (2026-05-30): l'agente ha abortito con messaggio
 * "Necessario nodo Telegram non disponibile. Installare community_telegram
 * o abilitare http_request per notifiche Telegram." MENTRE community_telegram
 * ERA installato per il tenant. L'agente ha hallucinato l'unavailability +
 * suggerito un defId inesistente (http_request).
 *
 * Strategia del gate:
 *   - Estrai dal reason TUTTI i token che assomigliano a un defId
 *     (snake_case, prefix tipico: action_, trigger_, community_, agent_,
 *      logic_, db_, ai_).
 *   - Per ciascun token, verifica se IS nel catalogo del tenant.
 *   - Se ANCHE UNO dei nodi citati come "non disponibile" IS in catalog,
 *     rifiuta l'abort: l'agente sta hallucinando.
 *
 * Inoltre rifiutiamo OGNI abort la cui ragione matcha pattern noti di
 * "node non installato" / "feature non disponibile" — REGOLA 12 del
 * prompt vieta esplicitamente questi abort.
 */

export interface AbortGateInput {
  reason: string;
  installedDefIds: string[];
}

export type AbortGateDecision =
  | { reject: false }
  | { reject: true; replyToAgent: string; hallucinatedDefIds: string[] };

/**
 * Token pattern conservativo: cattura defId "noti" della platform.
 * Prefissi: action_, trigger_, community_, agent_, ai_, logic_, db_.
 */
const DEFID_TOKEN_RE =
  /\b(?:action|trigger|community|agent|ai|logic|db|integration)_[a-z][a-z0-9_]*\b/gi;

/**
 * Pattern "ho deciso che la feature non è disponibile / non installata".
 * Triggera la REGOLA 12 anche se nessun defId specifico viene citato.
 */
const NODE_UNAVAILABLE_PATTERNS = [
  /non\s+(?:è|e'|è|esiste|disponibile|installat|presente)/i,
  /not\s+(?:installed|available|present|in\s+the\s+catalog)/i,
  /missing\s+(?:node|tool|integration|adapter)/i,
  /nodo\s+(?:\w+\s+)?(?:non|mancante|mancanti)/i,
  /(?:installare|install)\s+(?:community|action|trigger|agent|integration)_/i,
  /(?:abilitare|enable)\s+(?:community|http|action)_?\w+/i,
];

export function evaluateAbort(input: AbortGateInput): AbortGateDecision {
  const reason = input.reason.trim();
  if (!reason) return { reject: false };

  const lowerInstalled = new Set(input.installedDefIds.map((d) => d.toLowerCase()));

  // 1. Trova tutti i defId-like token citati nel reason.
  const citedTokens = new Set<string>();
  for (const m of reason.matchAll(DEFID_TOKEN_RE)) {
    if (m[0]) citedTokens.add(m[0].toLowerCase());
  }

  // 2. Distingue tra: citati MA IN catalog (hallucinated) vs citati e NOT in catalog (legit).
  const hallucinatedDefIds: string[] = [];
  for (const tok of citedTokens) {
    if (lowerInstalled.has(tok)) hallucinatedDefIds.push(tok);
  }

  // 3. Se citi defId presenti in catalog dicendo che non lo sono → reject.
  if (hallucinatedDefIds.length > 0) {
    const replyToAgent =
      `Abort RIFIUTATO. Hai detto che ${hallucinatedDefIds.join(', ')} non è disponibile, ` +
      `ma ${hallucinatedDefIds.length > 1 ? 'sono tutti presenti' : 'è presente'} nel catalogo del tenant. ` +
      `Chiama list_node_catalog(defId:"${hallucinatedDefIds[0] ?? ''}") per leggere actions+configFields, ` +
      `poi add_node per usarlo. NIENTE abort.`;
    return { reject: true, replyToAgent, hallucinatedDefIds };
  }

  // 4. Se non cita defId concreti ma matcha pattern "node non installato",
  //    bocca REGOLA 12. L'agente deve fare fallback con action_http, non abort.
  const isUnavailableExcuse = NODE_UNAVAILABLE_PATTERNS.some((re) => re.test(reason));
  if (isUnavailableExcuse) {
    const replyToAgent =
      `Abort RIFIUTATO (REGOLA 12). Ragione "${reason.slice(0, 200)}" ` +
      `descrive un nodo non installato. La regola è chiara: MAI abort per nodo non installato. ` +
      `Fallback: usa action_http (defId esatto) con URL del vendor + Authorization da secrets. ` +
      `Per integrazioni con secrets: {{secrets.TELEGRAM_BOT_TOKEN}}, {{secrets.SLACK_WEBHOOK}}, ecc. ` +
      `Continua a costruire il workflow.`;
    return { reject: true, replyToAgent, hallucinatedDefIds: [] };
  }

  return { reject: false };
}
