/**
 * I segreti che un workflow nomina ma che non esistono.
 *
 * `{{secrets.API_KEY}}` in un campo è una promessa: quel nome dovrà trovare
 * qualcosa nel portachiavi. Se non c'è, il workflow parte, arriva a quel
 * nodo, e fallisce con un errore del servizio esterno — «401», «chiave non
 * valida» — che manda a cercare il problema dalla parte sbagliata.
 *
 * Trovarlo prima costa una scorsa dei campi.
 */

import type { Workflow } from './types';

/** Come si scrive un riferimento a un segreto. */
const RIFERIMENTO = /\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;

/** I nomi dei segreti nominati da un valore, qualunque forma abbia. */
function nomiIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...value.matchAll(RIFERIMENTO)].map((m) => m[1] ?? '').filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(nomiIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(nomiIn);
  return [];
}

/** Tutti i segreti che questo workflow dà per definiti. */
export function secretsUsed(workflow: Pick<Workflow, 'nodes'>): string[] {
  const nomi = new Set<string>();
  for (const node of workflow.nodes) {
    for (const nome of nomiIn(node.config)) nomi.add(nome);
  }
  return [...nomi].sort();
}

/**
 * Quelli che mancano.
 *
 * Il confronto è coi nomi definiti, non coi valori: leggere i valori per
 * sapere se un segreto esiste vorrebbe dire tirarli fuori dal portachiavi
 * per niente.
 */
export function missingSecrets(
  workflow: Pick<Workflow, 'nodes'>,
  defined: readonly string[],
): string[] {
  const conosciuti = new Set(defined);
  return secretsUsed(workflow).filter((nome) => !conosciuti.has(nome));
}
