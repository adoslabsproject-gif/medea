/**
 * Gli strumenti che il modello ha usato per costruire il workflow.
 *
 * Non è decorazione: è l'unico modo per capire *come* ci è arrivato — se ha
 * cercato il nodo giusto, se ha letto lo schema prima di configurarlo, se ha
 * validato prima di chiudere. Quando il risultato non convince, la risposta è
 * quasi sempre in questa lista.
 *
 * Mentre lavora si vedono gli ultimi passi; a cose fatte l'elenco si chiude,
 * perché interessa mentre succede.
 */

import type { AgentStep } from '../scaffold';

import styles from './ToolTrace.module.css';

/** Cosa fa ciascuno strumento, in una parola. */
const TOOL_LABEL: Record<string, string> = {
  search_nodes: 'cerca',
  get_node_schema: 'legge',
  add_node: 'aggiunge',
  connect: 'collega',
  set_config: 'configura',
  delete_node: 'rimuove',
  disconnect: 'scollega',
  validate_workflow: 'valida',
  finish: 'conclude',
};

interface Props {
  steps: readonly AgentStep[];
  /** Vero mentre l'agente sta ancora lavorando: l'elenco resta aperto. */
  live?: boolean;
}

export function ToolTrace({ steps, live }: Props) {
  if (steps.length === 0) return null;

  const list = (
    <ol className={styles.steps}>
      {steps.map((s) => (
        <li key={s.step} className={styles.step} data-tool={s.tool}>
          <span className={styles.verb}>{TOOL_LABEL[s.tool] ?? s.tool}</span>
          <span className={styles.subject}>{subjectOf(s)}</span>
          {outcomeOf(s) && <span className={styles.outcome}>{outcomeOf(s)}</span>}
        </li>
      ))}
    </ol>
  );

  if (live) return list;

  return (
    <details className={styles.trace}>
      <summary className={styles.summary}>
        {steps.length} {steps.length === 1 ? 'passo' : 'passi'} dell’assistente
      </summary>
      {list}
    </details>
  );
}

/** Su cosa ha agito il passo: il nodo, il collegamento, la ricerca. */
function subjectOf(step: AgentStep): string {
  const a = step.args;
  const from = typeof a.from === 'string' ? a.from : '';
  const to = typeof a.to === 'string' ? a.to : '';
  if (from && to) return `${from} → ${to}`;
  for (const key of ['defId', 'nodeId', 'query', 'id']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** L'esito, quando dice qualcosa: quanti nodi trovati, cosa manca ancora. */
function outcomeOf(step: AgentStep): string {
  const r = step.result;
  if (!r || typeof r !== 'object') return '';
  const data = r as Record<string, unknown>;

  if (data.ok === false && typeof data.error === 'string') return 'non riuscito';
  if (Array.isArray(data.hits)) {
    return `${String(data.hits.length)} ${data.hits.length === 1 ? 'risultato' : 'risultati'}`;
  }
  if (Array.isArray(data.missingRequired) && data.missingRequired.length > 0) {
    return `mancano ${data.missingRequired.length} campi`;
  }
  if (data.valid === true) return 'tutto a posto';
  if (Array.isArray(data.issues) && data.issues.length > 0) {
    return `${String(data.issues.length)} da sistemare`;
  }
  return '';
}
