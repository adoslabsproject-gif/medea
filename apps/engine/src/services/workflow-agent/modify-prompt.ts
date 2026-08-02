/**
 * modify-prompt — system prompt dell'agente quando MODIFICA un workflow esistente
 * (parità chatter↔creazione, GAP #1).
 *
 * Differenza dalla creazione: il builder è SEEDATO col workflow corrente
 * (read-before-edit), quindi il prompt deve (a) mostrare al modello lo stato
 * attuale — nodi (id+defId+config) ed edge — così non lo deve riscoprire; (b)
 * abilitare i tool di rimozione (delete_node/disconnect); (c) imporre la regola
 * architetturale: i nodi CUSTOM si creano SOLO nell'IDE → se nel catalogo non
 * esiste un nodo adatto, il modello lo COMUNICA all'utente, NON improvvisa.
 *
 * Puro: niente I/O. Lo stato è serializzato in modo compatto e cap-ato per non
 * esplodere il contesto su workflow grandi.
 *
 * @module services/workflow-agent/modify-prompt
 */
import type { WorkflowSnapshot } from '@/services/workflow-agent/state.js';

export interface WorkflowModifyPromptContext {
  /** Workflow ESISTENTE da modificare (già seedato nel builder). */
  currentWorkflow: WorkflowSnapshot;
  /** Richiesta dell'utente dal chatter (es. "aggiungi un nodo email e collegalo"). */
  request: string;
  /** Contesto opzionale (DB del tenant, credenziali disponibili, ecc.). */
  extraContext?: string;
}

const MAX_CONFIG_CHARS = 400;

/** Config compatta a una riga, troncata: dà al modello i valori senza esplodere. */
function compactConfig(config: Record<string, unknown>): string {
  const keys = Object.keys(config);
  if (keys.length === 0) return '(nessuna config)';
  let json: string;
  try {
    json = JSON.stringify(config);
  } catch {
    return `(${keys.length.toString()} campi)`;
  }
  return json.length > MAX_CONFIG_CHARS ? `${json.slice(0, MAX_CONFIG_CHARS)}… [troncato]` : json;
}

/** Descrive lo stato corrente del workflow per il read-before-edit del modello. */
export function describeCurrentWorkflow(wf: WorkflowSnapshot): string {
  const lines: string[] = [];
  lines.push(`Nodi (${wf.nodes.length.toString()}):`);
  if (wf.nodes.length === 0) {
    lines.push('  (workflow vuoto)');
  } else {
    for (const n of wf.nodes) {
      lines.push(`  - ${n.id} [${n.defId}] config=${compactConfig(n.config)}`);
    }
  }
  lines.push(`Collegamenti (${wf.edges.length.toString()}):`);
  if (wf.edges.length === 0) {
    lines.push('  (nessun collegamento)');
  } else {
    for (const e of wf.edges) {
      lines.push(`  - ${e.from} → ${e.to}${e.fromPort ? ` [porta: ${e.fromPort}]` : ''}`);
    }
  }
  return lines.join('\n');
}

export function buildWorkflowModifyPrompt(ctx: WorkflowModifyPromptContext): string {
  return [
    'Sei un ingegnere di automazione che MODIFICA un workflow ESISTENTE su FlowForge usando gli strumenti a disposizione.',
    '',
    'Hai già davanti lo STATO CORRENTE del workflow (sotto). Applica SOLO le modifiche',
    "richieste dall'utente, UN PASSO ALLA VOLTA, riusando i nodi e i collegamenti che",
    "già esistono — non ricostruire da zero quello che c'è già.",
    '',
    'Strumenti:',
    '- `search_nodes` + `get_node_schema`: per scegliere e configurare un nodo NUOVO dal catalogo.',
    '- `add_node` / `set_config`: aggiungi un nodo o aggiornane la config.',
    '- `connect` / `disconnect`: aggiungi o rimuovi un collegamento (per i rami specifica fromPort).',
    '- `delete_node`: rimuovi un nodo (e i suoi collegamenti) che non serve più.',
    '- `validate_workflow`: controlla; correggi le issue prima di `finish`.',
    '- `finish`: SOLO quando le modifiche richieste sono complete e validate.',
    '',
    'Regole:',
    '- NON toccare nodi/collegamenti non coinvolti dalla richiesta.',
    '- Riempi i campi obbligatori dei nodi nuovi con valori realistici dedotti dal contesto;',
    "  i segreti (API key, password, token) vanno come `{{secrets.NOME}}` — l'utente li",
    '  compilerà a mano (verrà avvisato). Non inventare valori per i segreti.',
    "- Per riferire l'output di un nodo precedente usa espressioni `{{ ... }}`.",
    '- ⛔ I nodi CUSTOM si creano SOLO nell\'IDE (tab "I Miei Nodi"). Se per la richiesta',
    '  NON esiste un nodo adatto nel catalogo (search_nodes non trova nulla di pertinente),',
    "  NON improvvisare e NON inventare un defId: spiega all'utente che deve creare il nodo",
    '  nell\'IDE (tab "I Miei Nodi") e termina con una risposta testuale, senza `finish`.',
    '',
    'STATO CORRENTE DEL WORKFLOW:',
    describeCurrentWorkflow(ctx.currentWorkflow),
    '',
    `RICHIESTA DELL'UTENTE: ${ctx.request}`,
    ...(ctx.extraContext?.trim() ? ['', 'CONTESTO:', ctx.extraContext.trim()] : []),
  ].join('\n');
}
