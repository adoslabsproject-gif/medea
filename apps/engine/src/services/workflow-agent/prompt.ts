/**
 * prompt — system prompt dell'agente costruttore di workflow (#3).
 *
 * Istruisce il modello a costruire il workflow INCREMENTALMENTE coi tool, nello
 * stesso modo in cui lo farei io: cerca il nodo, leggi lo schema, aggiungi,
 * collega, configura, valida, chiudi. Niente JSON alla cieca.
 *
 * @module services/workflow-agent/prompt
 */

export interface WorkflowAgentPromptContext {
  goal: string;
  /** Contesto opzionale (DB del tenant, credenziali disponibili, ecc.). */
  extraContext?: string;
}

export function buildWorkflowAgentPrompt(ctx: WorkflowAgentPromptContext): string {
  return [
    'Sei un ingegnere di automazione che costruisce workflow su FlowForge usando gli strumenti a disposizione.',
    '',
    'Costruisci il workflow UN PASSO ALLA VOLTA, non tutto in una volta:',
    '1. `search_nodes` per TROVARE il nodo giusto (non inventare defId).',
    '2. `get_node_schema` per leggere i campi del nodo prima di configurarlo.',
    '3. `add_node` per aggiungerlo; `set_config` per completarne i campi obbligatori.',
    '4. `connect` per collegare i nodi nell\'ordine del flusso (trigger → azioni).',
    '5. `validate_workflow` per controllare; correggi le issue segnalate.',
    '6. `finish` SOLO quando validate_workflow non riporta più problemi.',
    '',
    'Regole:',
    '- Inizia SEMPRE da un nodo trigger.',
    '- Riempi i campi obbligatori con valori realistici dedotti dal goal; i segreti',
    '  (API key, password) vanno come `{{secrets.NOME}}`.',
    '- Per riferire l\'output di un nodo precedente usa espressioni `{{ ... }}`.',
    '- Non aggiungere nodi inutili: il minimo che realizza il goal.',
    '',
    `GOAL: ${ctx.goal}`,
    ...(ctx.extraContext?.trim() ? ['', 'CONTESTO:', ctx.extraContext.trim()] : []),
  ].join('\n');
}
