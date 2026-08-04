/**
 * Validazione contro il catalogo — il livello che rende lo scaffold
 * indipendente dal modello.
 *
 * Nessun workflow non valido può essere salvato: se il modello sbaglia riceve
 * queste violazioni in forma leggibile e riprova. È qui che sta la garanzia,
 * non nella bravura del provider.
 *
 * Tre livelli, come sul server:
 *   1. nodo e configurazione — il `defId` esiste, i campi sono quelli veri,
 *      gli enum contengono il valore, i campi obbligatori ci sono;
 *   2. azioni — l'azione citata esiste in quel nodo;
 *   3. grafo — id univoci, edge che puntano a nodi esistenti, porte valide.
 */

import type { NodeDef } from '../types';

import type { ScaffoldOutput } from './schema';
import { validateTables } from './validate-tables';

export type ViolationKind =
  | 'unknown_def'
  | 'unknown_config_key'
  | 'invalid_enum'
  | 'missing_required'
  | 'invalid_action'
  | 'duplicate_id'
  | 'dangling_edge'
  | 'invalid_port'
  | 'self_loop'
  | 'invalid_table'
  | 'invalid_column';

export interface Violation {
  kind: ViolationKind;
  nodeId?: string;
  defId?: string;
  field?: string;
  /** Frase pronta per il modello: dice cosa non va e cosa è ammesso. */
  message: string;
}

export { PICKER_PLACEHOLDER } from '../constants';

/**
 * Campi che l'utente sceglierà da un menu: il modello non può conoscerne il
 * valore, quindi non è colpa sua se manca. Vengono riempiti dopo.
 *
 * Riconosciuti dal suffisso, non da un elenco. L'elenco c'era — cinque nomi
 * scritti a mano — e si era staccato dal catalogo senza che nessuno se ne
 * accorgesse: conteneva `account-picker` e `credential-picker`, che nel
 * catalogo non esistono, e ignorava `email-account-picker` (cinque campi),
 * `timezone-picker`, `workflow-picker`, `directory-picker` e
 * `db-collection-picker`. Il 2026-08-04 è per questo che un
 * `systemAccountId` valorizzato «email-account-picker» attraversava
 * indisturbato le riparazioni e finiva per bocciare il workflow.
 *
 * Il suffisso è la convenzione vera del catalogo — ogni selettore la rispetta
 * — e non richiede di ricordarsi di aggiornare un elenco quando se ne
 * aggiunge uno. Un elenco che va tenuto allineato a mano prima o poi non lo è.
 */
export function isPickerField(type: string): boolean {
  return type.endsWith('-picker');
}

/** Livello 1 e 2: ogni nodo contro la sua definizione. */
export function validateNodes(output: ScaffoldOutput, catalog: Map<string, NodeDef>): Violation[] {
  const violations: Violation[] = [];

  for (const node of output.nodes) {
    const def = catalog.get(node.defId);
    if (!def) {
      violations.push({
        kind: 'unknown_def',
        nodeId: node.id,
        defId: node.defId,
        message: `Il nodo "${node.id}" usa defId "${node.defId}", che non esiste nel catalogo. Scegli un defId fra quelli elencati.`,
      });
      continue;
    }

    const fields = def.configFields ?? [];
    const byKey = new Map(fields.map((f) => [f.key, f]));

    for (const [key, value] of Object.entries(node.config)) {
      const field = byKey.get(key);
      if (!field) {
        violations.push({
          kind: 'unknown_config_key',
          nodeId: node.id,
          defId: node.defId,
          field: key,
          message: `"${key}" non è un campo di ${node.defId}. Campi ammessi: ${fields.map((f) => f.key).join(', ') || '(nessuno)'}.`,
        });
        continue;
      }
      if (field.options && field.options.length > 0 && value !== undefined && value !== null) {
        // Confronto senza distinzione di maiuscole: la normalizzazione
        // avviene dopo, qui interessa solo che il valore sia fra quelli veri.
        // Un valore non-stringa (oggetto, array) non può mai essere un enum.
        const ok =
          typeof value === 'string' &&
          field.options.some((o) => o.toLowerCase() === value.toLowerCase());
        if (!ok) {
          violations.push({
            kind: 'invalid_enum',
            nodeId: node.id,
            defId: node.defId,
            field: key,
            message: `"${key}" di ${node.defId} vale ${JSON.stringify(value)}, ma sono ammessi solo: ${field.options.join(' | ')}.`,
          });
        }
      }
    }

    for (const field of fields) {
      // `null` è assenza quanto `undefined`: i modelli lo usano spesso per
      // dire "non lo so", e non deve contare come valore fornito.
      const raw = node.config[field.key];
      const present = raw !== undefined && raw !== null && raw !== '';
      if (field.required && !present && !isPickerField(field.type)) {
        violations.push({
          kind: 'missing_required',
          nodeId: node.id,
          defId: node.defId,
          field: field.key,
          message: `Al nodo "${node.id}" (${node.defId}) manca il campo obbligatorio "${field.key}" (${field.type}).`,
        });
      }
    }

    const action = node.config.action;
    if (typeof action === 'string' && def.actions && def.actions.length > 0) {
      if (!def.actions.some((a) => a.id === action)) {
        violations.push({
          kind: 'invalid_action',
          nodeId: node.id,
          defId: node.defId,
          field: 'action',
          message: `L'azione "${action}" non esiste in ${node.defId}. Azioni disponibili: ${def.actions
            .map((a) => a.id)
            .slice(0, 20)
            .join(', ')}.`,
        });
      }
    }
  }

  return violations;
}

/** Livello 3: il grafo sta in piedi. */
export function validateGraph(output: ScaffoldOutput, catalog: Map<string, NodeDef>): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const node of output.nodes) {
    if (seen.has(node.id)) {
      violations.push({
        kind: 'duplicate_id',
        nodeId: node.id,
        message: `L'id "${node.id}" è usato da più nodi: gli id devono essere univoci.`,
      });
    }
    seen.add(node.id);
  }

  for (const edge of output.edges) {
    if (!seen.has(edge.from)) {
      violations.push({
        kind: 'dangling_edge',
        message: `Un collegamento parte da "${edge.from}", che non è un nodo del workflow.`,
      });
    }
    if (!seen.has(edge.to)) {
      violations.push({
        kind: 'dangling_edge',
        message: `Un collegamento arriva a "${edge.to}", che non è un nodo del workflow.`,
      });
    }
    if (edge.from === edge.to) {
      violations.push({
        kind: 'self_loop',
        nodeId: edge.from,
        message: `Il nodo "${edge.from}" è collegato a sé stesso.`,
      });
    }
    if (edge.fromPort) {
      const source = output.nodes.find((n) => n.id === edge.from);
      const ports = source ? (catalog.get(source.defId)?.outputPorts ?? []) : [];
      if (ports.length > 0 && !ports.includes(edge.fromPort)) {
        violations.push({
          kind: 'invalid_port',
          nodeId: edge.from,
          message: `La porta "${edge.fromPort}" non esiste su "${edge.from}". Porte valide: ${ports.join(' | ')}.`,
        });
      }
    }
  }

  return violations;
}

export function validateScaffold(
  output: ScaffoldOutput,
  catalog: Map<string, NodeDef>,
): Violation[] {
  return [
    ...validateNodes(output, catalog),
    ...validateGraph(output, catalog),
    ...validateTables(output),
  ];
}

/** Le violazioni come le rilegge il modello nel tentativo successivo. */
export function describeViolations(violations: Violation[], limit = 12): string {
  const shown = violations.slice(0, limit);
  const lines = shown.map((v, i) => `${i + 1}. ${v.message}`);
  if (violations.length > limit) {
    lines.push(`…e altri ${violations.length - limit} problemi dello stesso tipo.`);
  }
  return lines.join('\n');
}
