/**
 * GAP 1 (e) — euristica Auto-Map per lo scaffold AI.
 *
 * Quando la LLM genera un edge da un nodo che produce una LISTA (db_query,
 * rag_search, xlsx_parse, harvest…) verso un nodo che lavora su UN item
 * (agent_summarizer, lead_score, email_personalize…), l'engine senza map
 * passerebbe l'array intero al consumatore — il classico workflow "girato
 * una volta sola sull'intera lista" che l'utente non voleva. L'euristica
 * setta `mapMode:'auto'` sull'edge: per-item se array, pass-through se no
 * (la modalità TOLLERANTE: mai un errore su dati legittimi non-array).
 *
 * FILOSOFIA CONSERVATIVA (bug-bounty): un falso positivo = N side-effect
 * invece di 1 (es. N email). Quindi:
 *  - whitelist ESPLICITE produttore/consumatore, mai pattern-matching sul nome;
 *  - nodi con side-effect esterni (email_send, http, db_insert, pdf) NON sono
 *    consumatori auto-mappabili: il fan-out lì lo decide l'UTENTE dal badge;
 *  - trasformatori array→array (group_by, distinct, aggregate) NON sono
 *    produttori-trigger: il consumatore a valle di solito vuole la lista intera;
 *  - branchable (intent_router, validator in modalità branch, if/switch) MAI:
 *    l'engine li rifiuta comunque (branch per-item ambiguo);
 *  - un mapMode GIÀ presente sull'edge non viene mai sovrascritto;
 *  - gli error-edge non trasportano liste di lavoro → skip.
 *
 * Modulo PURO (zero deps runtime) — testabile in isolamento, chiamato dal
 * collante singleshot prima dell'assemble.
 */

/** Nodi il cui output PRINCIPALE è una lista di item di lavoro. */
export const ARRAY_PRODUCER_DEFIDS: ReadonlySet<string> = new Set([
  'db_query', // rows
  'rag_search', // results
  'action_xlsx_parse', // rows
  'action_contact_discovery', // contatti
  'action_email_harvest', // email trovate
  'action_company_search', // aziende
]);

/** Nodi che semanticamente lavorano su UN item (per-item è l'intento ovvio). */
export const SINGLE_ITEM_CONSUMER_DEFIDS: ReadonlySet<string> = new Set([
  'agent_summarizer',
  'agent_translator',
  'agent_classifier',
  'agent_extractor',
  'action_lead_score',
  'action_email_personalize',
]);

export interface AutoMapNode {
  id: string;
  defId: string;
}
export interface AutoMapEdge {
  from: string;
  to: string;
  fromPort?: string | undefined;
  mapMode?: 'off' | 'auto' | 'each' | undefined;
}

/**
 * Applica l'euristica MUTANDO gli edge qualificati (mapMode='auto').
 * Ritorna le note umane (una per edge toccato) per log/osservabilità.
 */
export function applyAutoMapHeuristic(wf: {
  nodes: AutoMapNode[];
  edges: AutoMapEdge[];
}): string[] {
  const defById = new Map(wf.nodes.map((n) => [n.id, n.defId]));
  const notes: string[] = [];
  for (const edge of wf.edges) {
    if (edge.mapMode !== undefined) continue; // scelta esistente: intoccabile
    if (edge.fromPort === 'error') continue; // error-edge: mai liste di lavoro
    const producer = defById.get(edge.from);
    const consumer = defById.get(edge.to);
    if (producer === undefined || consumer === undefined) continue;
    if (!ARRAY_PRODUCER_DEFIDS.has(producer) || !SINGLE_ITEM_CONSUMER_DEFIDS.has(consumer))
      continue;
    edge.mapMode = 'auto';
    notes.push(
      `Auto-Map attivato su ${edge.from}(${producer}) → ${edge.to}(${consumer}): lista per-item`,
    );
  }
  return notes;
}
