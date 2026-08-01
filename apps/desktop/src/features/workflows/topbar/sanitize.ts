/**
 * Ripulire un workflow prima di darlo via.
 *
 * Un workflow esportato finisce in una chat, in un repository, in un
 * allegato. Se dentro c'è una password SMTP scritta in un campo, quella
 * password è appena diventata pubblica — e chi ha premuto «Esporta» non
 * pensava di condividerla, pensava di condividere l'automazione.
 *
 * Il valore sospetto non si cancella e basta: si sostituisce con
 * `{{secrets.NOME}}`. Così il documento resta eseguibile su un'altra
 * installazione, che dovrà solo definire quel segreto — e il file dice da sé
 * cosa gli manca, invece di fallire con un campo vuoto.
 */

import type { CanvasNode, Workflow } from '../types';

/** I nomi di campo che contengono qualcosa da non condividere. */
const SENSITIVE = /pass(word)?|secret|token|api[_-]?key|credential|private[_-]?key|auth|bearer/i;

/** Quello che non è un segreto anche se il nome lo somiglia. */
const ALLOWED = /passthrough|password_field|authorized|author\b/i;

/**
 * Un valore già scritto come riferimento non va toccato: `{{secrets.X}}` è
 * esattamente ciò che vogliamo ottenere.
 */
const ALREADY_REFERENCE = /^\s*\{\{\s*secrets\./;

/** Il nome del segreto che prende il posto del valore. */
function secretNameFor(nodeId: string, field: string): string {
  return `${nodeId}_${field}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface SanitizeReport {
  workflow: Workflow;
  /** I campi sostituiti, in forma leggibile: serve a dirlo a chi esporta. */
  replaced: string[];
}

function sanitizeNode(node: CanvasNode, replaced: string[]): CanvasNode {
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node.config)) {
    const sensitive = SENSITIVE.test(key) && !ALLOWED.test(key);
    if (!sensitive || typeof value !== 'string' || !value || ALREADY_REFERENCE.test(value)) {
      config[key] = value;
      continue;
    }
    const name = secretNameFor(node.id, key);
    config[key] = `{{secrets.${name}}}`;
    replaced.push(`${node.id}.${key} → ${name}`);
  }

  return { ...node, config };
}

/**
 * Il workflow senza credenziali, e l'elenco di cosa è stato sostituito.
 *
 * Non tocca niente che non sia una stringa: un `false` in un campo che si
 * chiama `auth` è una scelta di configurazione, non una credenziale.
 */
export function sanitizeWorkflow(workflow: Workflow): SanitizeReport {
  const replaced: string[] = [];
  return {
    workflow: { ...workflow, nodes: workflow.nodes.map((n) => sanitizeNode(n, replaced)) },
    replaced,
  };
}
