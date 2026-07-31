/**
 * Riparazioni deterministiche, prima di coinvolgere il modello.
 *
 * Principio: al modello si chiedono solo le scelte che richiedono giudizio.
 * Un `defId` inventato per aggiunta di suffisso, un enum con le maiuscole
 * sbagliate, un default mancante o una posizione assente non sono decisioni:
 * sono rumore, e si correggono qui.
 *
 * Meno cose restano da correggere al modello, meno round servono — ed è così
 * che un provider generico raggiunge lo stesso risultato del fine-tuned.
 */

import type { NodeDef } from '../types';

import type { ScaffoldOutput } from './schema';
import { isPickerField, PICKER_PLACEHOLDER } from './validate';

export interface RepairLog {
  /** Descrizione leggibile di ogni correzione applicata. */
  applied: string[];
}

/**
 * `action_http_clearbit` → `action_http`: il modello tende a specializzare i
 * defId aggiungendo il nome del servizio. Si tolgono i suffissi finché non si
 * incontra un defId vero.
 */
export function fixInventedDefIds(
  output: ScaffoldOutput,
  catalog: Map<string, NodeDef>,
  log: RepairLog,
): void {
  for (const node of output.nodes) {
    if (catalog.has(node.defId)) continue;
    const parts = node.defId.split('_');
    for (let cut = parts.length - 1; cut >= 2; cut--) {
      const candidate = parts.slice(0, cut).join('_');
      if (catalog.has(candidate)) {
        log.applied.push(`defId "${node.defId}" ricondotto a "${candidate}" sul nodo ${node.id}`);
        node.defId = candidate;
        break;
      }
    }
  }
}

/** Enum con maiuscole sbagliate (`"get"` → `"GET"`) e default mancanti. */
export function applyDefaultsAndNormalize(
  output: ScaffoldOutput,
  catalog: Map<string, NodeDef>,
  log: RepairLog,
): void {
  for (const node of output.nodes) {
    const def = catalog.get(node.defId);
    if (!def) continue;

    for (const field of def.configFields ?? []) {
      const value = node.config[field.key];

      if (field.options && typeof value === 'string') {
        const match = field.options.find((o) => o.toLowerCase() === value.toLowerCase());
        if (match && match !== value) {
          log.applied.push(`${node.id}.${field.key}: "${value}" normalizzato in "${match}"`);
          node.config[field.key] = match;
        }
      }

      const missing = value === undefined || value === '';
      if (missing && field.defaultValue !== undefined) {
        node.config[field.key] = field.defaultValue;
        log.applied.push(`${node.id}.${field.key}: applicato il default "${field.defaultValue}"`);
      } else if (missing && field.required && isPickerField(field.type)) {
        // L'utente lo sceglierà dal menu: segnaposto esplicito, non un valore
        // inventato che sembrerebbe valido.
        node.config[field.key] = PICKER_PLACEHOLDER;
        log.applied.push(`${node.id}.${field.key}: da scegliere nell'editor`);
      }
    }
  }
}

/** Id duplicati resi univoci, aggiornando anche i collegamenti. */
export function dedupeNodeIds(output: ScaffoldOutput, log: RepairLog): void {
  const seen = new Set<string>();
  for (const node of output.nodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      continue;
    }
    let n = 2;
    while (seen.has(`${node.id}_${n}`)) n++;
    const fresh = `${node.id}_${n}`;
    for (const edge of output.edges) {
      if (edge.from === node.id) edge.from = fresh;
      if (edge.to === node.id) edge.to = fresh;
    }
    log.applied.push(`id duplicato "${node.id}" rinominato in "${fresh}"`);
    node.id = fresh;
    seen.add(fresh);
  }
}

/** Collegamenti doppi e verso il nulla. */
export function pruneEdges(output: ScaffoldOutput, log: RepairLog): void {
  const ids = new Set(output.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const kept = output.edges.filter((e) => {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    const key = `${e.from}→${e.to}:${e.fromPort ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const removed = output.edges.length - kept.length;
  if (removed > 0) {
    log.applied.push(`${removed} collegamenti rimossi perché duplicati o verso nodi inesistenti`);
    output.edges = kept;
  }
}

/** Coordinate mancanti: griglia in cascata, poi il layout automatico rifinisce. */
export function fillPositions(output: ScaffoldOutput): void {
  output.nodes.forEach((node, idx) => {
    if (typeof node.x !== 'number') node.x = idx * 220;
    if (typeof node.y !== 'number') node.y = 200;
  });
}

/** Tutte le riparazioni, nell'ordine in cui hanno senso. */
export function repairScaffold(output: ScaffoldOutput, catalog: Map<string, NodeDef>): RepairLog {
  const log: RepairLog = { applied: [] };
  fixInventedDefIds(output, catalog, log);
  dedupeNodeIds(output, log);
  applyDefaultsAndNormalize(output, catalog, log);
  pruneEdges(output, log);
  fillPositions(output);
  return log;
}
