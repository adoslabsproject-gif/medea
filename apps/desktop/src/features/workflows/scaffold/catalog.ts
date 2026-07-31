/**
 * Catalogo dei nodi nella forma che vede il modello.
 *
 * Il formato è **identico** a quello del server (`formatScaffoldEntry`): righe
 * compatte, una per nodo, con vincoli inline. È deliberatamente denso — niente
 * label, niente descrizioni — perché deve stare nel contesto insieme al resto.
 *
 *   db_insert (action): databaseId:db-picker(REQUIRED), table:db-table-picker(REQUIRED), rowJson:json
 *
 * Cambiare questo formato significa divergere dal prompt su cui il modello
 * fine-tuned è stato addestrato: non si tocca senza aggiornare entrambi.
 */

import type { NodeDef } from '../types';

/** Quante azioni elencare per nodo: alcuni ne hanno decine. */
const MAX_ACTIONS_LISTED = 30;

/**
 * Sotto questa soglia conviene passare il catalogo intero: con pochi nodi il
 * recupero semantico peggiora la scelta invece di migliorarla (stessa
 * conclusione del server, dove vincolare sul catalogo completo da 185 voci
 * faceva collassare il modello su un nodo sbagliato).
 */
export const FULL_CATALOG_THRESHOLD = 50;

/** Una riga di catalogo per un nodo. */
export function formatCatalogEntry(def: NodeDef): string {
  const fields = (def.configFields ?? [])
    .map((f) => {
      const constraints: string[] = [];
      if (f.required) constraints.push('REQUIRED');
      if (f.options && f.options.length > 0) constraints.push(`enum[${f.options.join('|')}]`);
      if (f.pattern) constraints.push(`regex:${f.pattern}`);
      if (f.defaultValue) constraints.push(`default="${f.defaultValue}"`);
      return `${f.key}:${f.type}${constraints.length > 0 ? `(${constraints.join(',')})` : ''}`;
    })
    .join(', ');

  const actions = def.actions ?? [];
  const actionsLine =
    actions.length > 0
      ? ` actions[${actions
          .slice(0, MAX_ACTIONS_LISTED)
          .map((a) => a.id)
          .join(',')}${actions.length > MAX_ACTIONS_LISTED ? ',…' : ''}]`
      : '';

  return `${def.defId} (${def.type}): ${fields || '(no config)'}${actionsLine}`;
}

/** Il catalogo completo, una riga per nodo. */
export function formatCatalog(defs: NodeDef[]): string {
  return defs.map(formatCatalogEntry).join('\n');
}

/**
 * Sottoinsieme del catalogo per un obiettivo: i nodi fondamentali sempre, più
 * quelli che somigliano alla richiesta. Puramente lessicale, zero dipendenze
 * di rete — l'embedder è un miglioramento, non un requisito.
 */
export function selectCatalog(
  defs: NodeDef[],
  goal: string,
  coreDefIds: string[],
  limit = 45,
): NodeDef[] {
  if (defs.length <= FULL_CATALOG_THRESHOLD) return defs;

  const core = new Set(coreDefIds);
  const selected = defs.filter((d) => core.has(d.defId));
  const rest = defs.filter((d) => !core.has(d.defId));

  const terms = tokenize(goal);
  const scored = rest
    .map((def) => ({ def, score: lexicalScore(def, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - selected.length))
    .map((s) => s.def);

  return [...selected, ...scored];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

/** Punteggio grezzo: quante parole della richiesta compaiono nel nodo. */
function lexicalScore(def: NodeDef, terms: string[]): number {
  const haystack = tokenize(
    [def.defId, def.label, def.description ?? '', (def.searchAliases ?? []).join(' ')].join(' '),
  );
  const bag = new Set(haystack);
  let score = 0;
  for (const t of terms) {
    if (bag.has(t)) score += 2;
    else if (haystack.some((h) => h.startsWith(t) || t.startsWith(h))) score += 1;
  }
  return score;
}

/** Indice per lookup rapido in validazione e riparazione. */
export function indexByDefId(defs: NodeDef[]): Map<string, NodeDef> {
  return new Map(defs.map((d) => [d.defId, d]));
}
