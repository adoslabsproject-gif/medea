/**
 * complexity-gate — stima il numero MINIMO di nodi che un workflow
 * dovrebbe avere data la descrizione del goal utente, e blocca la
 * finalizzazione prematura.
 *
 * Motivazione (bug osservato 2026-05-30): l'agente Liara talvolta finalizza
 * con 2 nodi un goal Enterprise che ne richiede 14+ (es. "Document
 * intelligence pipeline: S3 → OCR → classify → branch per tipo → ERP/CRM
 * push → Slack notification → daily summary"). Senza un gate, il workflow
 * viene consegnato monco e l'utente vede solo l'inizio del flusso.
 *
 * Algoritmo:
 *   - Conta VERBI di azione distinti (estrai, classifica, valida, notifica, ...)
 *   - Conta INTEGRAZIONI distinte (Slack, Telegram, S3, ERP, CRM, ...)
 *   - Conta SEGNALI DI BRANCHING (se/branch/switch/caso/low confidence/...)
 *   - Conta TIPI DOCUMENTO esplicitamente elencati (contratto/fattura/preventivo)
 *
 * minNodes = max(3, 1 + ⌈verbi × 0.8⌉ + integrazioni + branch × 2 + tipi)
 *
 * NB: e\` una STIMA conservativa — preferiamo richiedere troppi nodi e farlo
 * dire all'agente "fatto" che lasciar passare workflow incompleti. Cap = 25
 * per evitare richieste irrealistiche per goal vaghi ma verbosi.
 */

export interface ComplexityEstimate {
  minNodes: number;
  signals: {
    actionVerbs: number;
    integrations: number;
    branches: number;
    documentTypes: number;
  };
  /** Token specifici matchati nel goal — usati per messaggi di rejection
   *  enumeranti (Liara vede COSA le manca, non solo quanti). */
  matched: {
    actionVerbs: string[];
    integrations: string[];
    branches: string[];
    documentTypes: string[];
  };
  tier: 'basic' | 'intermediate' | 'enterprise';
}

// Regex sono case-insensitive + match parole intere via \b boundary.
// Lista non esaustiva, ma copre i pattern frequenti nei prompt utente IT+EN.
const ACTION_VERBS_RE =
  /\b(?:classifica|classify|categoriz|valid[ai]|valida|estrai|extract|ocr|vision|analizz|analyz|notific|notify|archivi|archive|invi(?:are|a)|send|aggiung|insert|aggiorn|update|filtra|filter|trasform|transform|calcol|comput|gener|inoltr|forward|push|sincronizz|sync|routing|route|process|elabor|persist|salva|store|fetch|recuper|enrich|arricchisc|create|crea|delete|cancell|summary|summariz|riassum)\w*\b/gi;

const INTEGRATIONS_RE =
  /\b(?:slack|telegram|discord|gmail|email|imap|smtp|webhook|s3|aws|drive|stripe|paypal|github|notion|linear|salesforce|hubspot|erp|crm|sigla|pec|api|database|db|sqlite|postgres|mysql|http|rest|graphql|kafka|rabbitmq|sentry|datadog|elasticsearch)\b/gi;

const BRANCHES_RE =
  /\b(?:se\b|if\b|else|altrimenti|switch|branch|caso|case|when|quando|hot\b|warm\b|cold\b|low confidence|alta priorit|bassa priorit|priorit[aà]|tipo|type|categoria|threshold|soglia|condition|condizione|in caso di|in case of)\b/gi;

// Tipi documento elencati (lista IT/EN frequente): contratto, fattura, ecc.
const DOCUMENT_TYPES_RE =
  /\b(?:contratt|fattur|preventiv|ddt|ordine|order|invoice|contract|quote|proposal|receipt|ricevuta|nota credito|credit note|estratto conto|bank statement)\w*\b/gi;

/** Estrae distinct matches (case-insensitive) come Set. */
function distinctMatches(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    if (m[0]) out.add(m[0].toLowerCase());
  }
  return out;
}

export function estimateComplexity(goal: string): ComplexityEstimate {
  const actionVerbsSet = distinctMatches(goal, ACTION_VERBS_RE);
  const integrationsSet = distinctMatches(goal, INTEGRATIONS_RE);
  const branchesSet = distinctMatches(goal, BRANCHES_RE);
  const documentTypesSet = distinctMatches(goal, DOCUMENT_TYPES_RE);

  const minNodes = Math.min(
    25,
    Math.max(
      3,
      1 +
        Math.ceil(actionVerbsSet.size * 0.8) +
        integrationsSet.size +
        branchesSet.size * 2 +
        documentTypesSet.size,
    ),
  );

  const tier: ComplexityEstimate['tier'] =
    minNodes <= 5 ? 'basic' : minNodes <= 9 ? 'intermediate' : 'enterprise';

  return {
    minNodes,
    signals: {
      actionVerbs: actionVerbsSet.size,
      integrations: integrationsSet.size,
      branches: branchesSet.size,
      documentTypes: documentTypesSet.size,
    },
    matched: {
      actionVerbs: [...actionVerbsSet].sort(),
      integrations: [...integrationsSet].sort(),
      branches: [...branchesSet].sort(),
      documentTypes: [...documentTypesSet].sort(),
    },
    tier,
  };
}

/**
 * Decide se il finalize deve essere bloccato e ritorna il messaggio di
 * errore da rinviare all'agente (forzandolo a continuare). Ritorna null
 * se il finalize puo\` procedere.
 */
export function shouldRejectFinalize(
  goal: string,
  currentNodeCount: number,
): { reject: false } | { reject: true; reason: string; estimate: ComplexityEstimate } {
  if (!goal || goal.trim().length < 20) {
    // Goal cortissimo (es. "ciao") — non bloccare, lascia stand still l'agente.
    return { reject: false };
  }
  const estimate = estimateComplexity(goal);
  if (currentNodeCount >= estimate.minNodes) return { reject: false };

  // Messaggio di errore prescrittivo: dice all'agente cosa fare.
  const missing = estimate.minNodes - currentNodeCount;
  const reason =
    `Finalize PREMATURO. Goal classificato come tier "${estimate.tier}" ` +
    `(verbi: ${estimate.signals.actionVerbs.toString()}, ` +
    `integrazioni: ${estimate.signals.integrations.toString()}, ` +
    `branch: ${estimate.signals.branches.toString()}, ` +
    `tipi documento: ${estimate.signals.documentTypes.toString()}) ` +
    `— stima ${estimate.minNodes.toString()} nodi minimi, hai solo ${currentNodeCount.toString()}. ` +
    `Mancano ~${missing.toString()} nodi. ` +
    `Rileggi il GOAL e per OGNI verbo/integrazione/branch elencato AGGIUNGI un nodo corrispondente prima di richiamare finalize_workflow. ` +
    `Se un defId non e\` nel catalogo, chiama list_node_catalog() SENZA defId per vedere TUTTI i ${'81'} nodi installati e scegli il piu\` vicino (es. action_http per integrazioni HTTP custom).`;

  return { reject: true, reason, estimate };
}
