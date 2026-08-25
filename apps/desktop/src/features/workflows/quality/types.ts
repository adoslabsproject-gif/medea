/**
 * Tipi del quality gate — le regole semantiche che girano DOPO la validazione
 * strutturale.
 *
 * La differenza conta: `validate.ts` risponde a «questo workflow è ben
 * formato?» (defId esistenti, campi obbligatori, edge che puntano a nodi
 * veri). Qui si risponde a «questo workflow FUNZIONERÀ?». Un workflow può
 * essere perfettamente ben formato e comunque essere inutile: un trigger che
 * non porta a nulla, un `example.com` lasciato lì dal modello, un riferimento
 * a un nodo che a runtime non è ancora stato eseguito.
 *
 * Le regole sono il port di quelle del server: gli stessi codici, la stessa
 * severità, gli stessi messaggi. Un workflow bocciato qui deve essere bocciato
 * anche là, altrimenti l'utente vedrebbe due giudizi diversi sullo stesso
 * file.
 */

export type QualitySeverity = 'critical' | 'medium' | 'info';

export type QualityCode =
  | 'CIRCULAR_REFERENCE'
  | 'MOCK_PLACEHOLDER'
  | 'SWITCH_NO_DEFAULT'
  | 'DEAD_END_BRANCH'
  | 'ORPHAN_TRIGGER'
  | 'DUPLICATE_NODES'
  | 'SUSPICIOUS_RESOURCE_ID'
  | 'SWITCH_INVALID_CASE_KEY'
  | 'AGGREGATION_INSIDE_LOOP'
  | 'ARRAY_TO_SCALAR_WITHOUT_LOOP'
  | 'FAN_IN_WITHOUT_MERGE'
  | 'DB_TABLE_NOT_IN_SCHEMA'
  | 'DB_COLUMN_NOT_IN_SCHEMA'
  | 'CODE_NODE_LANG_MISMATCH'
  | 'OBSOLETE_MODEL'
  | 'ERROR_BRANCH_INVERTED'
  | 'ERROR_HANDLER_NO_SINK'
  | 'LOOKUP_WITHOUT_BRANCH'
  | 'TRIGGER_WITHOUT_ACTION'
  | 'AUDIT_NOT_TERMINAL'
  | 'CAMPO_OBBLIGATORIO_VUOTO'
  | 'DATI_INVENTATI'
  | 'ESPRESSIONE_NON_RISOLVIBILE'
  | 'SENSITIVE_HARDCODED'
  | 'NODE_NOT_INSTALLED'
  | 'NIENTE_DA_ELABORARE'
  | 'LISTA_CHE_NON_ARRIVA'
  | 'CONSENSO_MANCANTE';

export interface QualityIssue {
  severity: QualitySeverity;
  code: QualityCode;
  nodeId?: string;
  field?: string;
  message: string;
}

/** Il nodo come lo vede il gate: id, definizione e configurazione. Posizione
 *  ed etichette non contano per la qualità. */
export interface QualityNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}

export interface QualityEdge {
  from: string;
  to: string;
  fromPort?: string;
}

/** Catalogo dei database disponibili: abilita i controlli su tabelle e
 *  colonne. Quando manca, quelle regole si limitano a non girare. */
export interface QualityDatabase {
  id: string;
  tables: readonly string[];
  columns?: Readonly<Record<string, readonly string[]>>;
}

export interface QualityGateInput {
  nodes: readonly QualityNode[];
  edges: readonly QualityEdge[];
  databases?: readonly QualityDatabase[];
  /**
   * Le definizioni dei nodi presenti, per `defId`.
   *
   * Servono a sapere cosa un nodo pretende per funzionare — quali campi sono
   * obbligatori. Senza, il controllo può guardare solo la forma del disegno,
   * ed è così che un trigger senza casella risultava «a posto».
   */
  defs?: ReadonlyMap<string, QualityNodeDef>;
}

/** Quel poco che serve sapere di un nodo per giudicare la sua configurazione. */
export interface QualityNodeDef {
  /** A quale famiglia appartiene: trigger, action, logic o ai. */
  type?: string;
  configFields?: readonly { key: string; label?: string; required?: boolean }[];
  /**
   * Cosa il nodo produce, campo per campo.
   *
   * Serve a giudicare le espressioni che LEGGONO da lui. Fino al 2026-08-06
   * questo dato non esisteva per quasi nessun nodo, e senza non si poteva
   * distinguere `{{tldr}}` — un campo vero, riferito male — da una qualunque
   * parola dentro le graffe. Vedi ADR 0010.
   */
  outputContract?: { fields: readonly { name: string; type?: string }[] };
}

export interface QualityGateResult {
  ok: boolean;
  issues: QualityIssue[];
  /** Vero se almeno un problema è `critical`: il workflow non si importa. */
  shouldReject: boolean;
}

/** Una regola: riceve il workflow, restituisce i problemi che vede. */
export type QualityRule = (input: QualityGateInput) => QualityIssue[];
