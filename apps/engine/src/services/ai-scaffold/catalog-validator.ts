/**
 * catalog-validator — vincolo "config valida per il nodo" a VALIDATE-TIME.
 *
 * Mentre constrained-schema.ts vincola la generazione a decode-time (solo
 * Liara/vLLM via guided_json), questo validatore controlla l'output GIÀ PARSATO
 * contro il catalog → vale per QUALSIASI provider (anche BYOK OpenAI/Anthropic
 * che ignorano guided_json) e produce errori tipizzati azionabili che alimentano
 * il loop di riparazione (rigenera solo i nodi rotti).
 *
 * Coerente by-construction con la grammatica: entrambi leggono lo stesso
 * `NodeConfigSpec` (catalog-spec.ts). Le espressioni `{{ }}` sono SEMPRE
 * ammesse (valore risolto a runtime) → enum/tipo non si applicano ad esse.
 *
 * @module services/ai-scaffold/catalog-validator
 */
import {
  buildCatalogSpec,
  isExpressionValue,
  type NodeConfigSpec,
} from '@/services/ai-scaffold/catalog-spec.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

/** Chiavi di config "meta" gestite dall'engine, sempre ammesse sui multi-azione. */
const META_KEYS = new Set<string>(['__action', '__resource']);

/** Nodo come emesso dallo scaffold (shape minima necessaria alla validazione). */
export interface ScaffoldNodeLike {
  id: string;
  defId: string;
  config?: Record<string, unknown>;
}

export type CatalogViolation =
  | { kind: 'unknown_def'; nodeId: string; defId: string }
  | { kind: 'unknown_config_key'; nodeId: string; defId: string; key: string }
  | {
      kind: 'invalid_enum';
      nodeId: string;
      defId: string;
      key: string;
      value: unknown;
      allowed: string[];
    }
  | { kind: 'invalid_action'; nodeId: string; defId: string; action: string; allowed: string[] }
  | { kind: 'missing_required'; nodeId: string; defId: string; key: string };

/**
 * Un campo che chiede il CONSENSO di una persona, non una configurazione.
 *
 * Il prefisso è la convenzione: oggi c'è solo `confirmDelete`, e chi ne
 * aggiungerà un secondo lo chiamerà allo stesso modo.
 */
export function eConsensoUmano(key: string): boolean {
  return /^confirm/i.test(key);
}

/** Un valore di config "presente"? (assente/null/'' = mancante per i required). */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Valida UN nodo contro la sua spec, accumulando le violazioni in `out`. */
function validateNode(node: ScaffoldNodeLike, spec: NodeConfigSpec, out: CatalogViolation[]): void {
  const config = node.config ?? {};

  // 1. Action selezionata (solo multi-azione): __action ∈ actionIds.
  if (spec.multiAction) {
    const action = config.__action;
    if (typeof action === 'string' && action.length > 0 && !isExpressionValue(action)) {
      const allowed = spec.actionIds ?? [];
      if (!allowed.includes(action)) {
        out.push({ kind: 'invalid_action', nodeId: node.id, defId: node.defId, action, allowed });
      }
    }
  }

  // 2. Chiavi di config: nessuna chiave fuori da quelle dichiarate (o meta).
  for (const key of Object.keys(config)) {
    if (META_KEYS.has(key)) continue;
    const keySpec = spec.keys.get(key);
    if (!keySpec) {
      out.push({ kind: 'unknown_config_key', nodeId: node.id, defId: node.defId, key });
      continue;
    }
    // 3. Enum: il valore (se non espressione) deve essere tra le options.
    if (keySpec.kind === 'enum' && keySpec.options) {
      const value = config[key];
      if (
        typeof value === 'string' &&
        !isExpressionValue(value) &&
        !keySpec.options.includes(value)
      ) {
        out.push({
          kind: 'invalid_enum',
          nodeId: node.id,
          defId: node.defId,
          key,
          value,
          allowed: keySpec.options,
        });
      }
    }
  }

  // 4. Required: ogni campo required (mai i secret) deve essere presente.
  //
  // Tranne le CONFERME UMANE. `db_delete.confirmDelete` è una spunta che dice
  // «so che questo cancella dei dati»: non è un valore che si deduca dal goal,
  // è un'assunzione di responsabilità, e un generatore non ha il diritto di
  // darla al posto di chi userà il workflow.
  //
  // Pretenderla rendeva `db_delete` IMPOSSIBILE da generare: il 2026-08-06
  // «ogni primo del mese cancella dalla tabella log le righe più vecchie di
  // novanta giorni» ha bruciato tutti i tentativi lì, con tutto il resto già a
  // posto. Una pulizia periodica è una richiesta ordinaria, e il wizard non
  // poteva soddisfarla in nessun caso. La conferma la chiede l'editor a chi
  // legge, e senza non si attiva niente.
  for (const keySpec of spec.keys.values()) {
    if (keySpec.required && isMissing(config[keySpec.key]) && !eConsensoUmano(keySpec.key)) {
      out.push({ kind: 'missing_required', nodeId: node.id, defId: node.defId, key: keySpec.key });
    }
  }
}

/**
 * Valida i nodi di un workflow scaffold contro la spec del catalog.
 * Ritorna TUTTE le violazioni (lista vuota = nessuna). Non lancia.
 */
export function validateNodesAgainstCatalog(
  nodes: ScaffoldNodeLike[],
  spec: Map<string, NodeConfigSpec>,
): CatalogViolation[] {
  const out: CatalogViolation[] = [];
  for (const node of nodes) {
    const nodeSpec = spec.get(node.defId);
    if (!nodeSpec) {
      out.push({ kind: 'unknown_def', nodeId: node.id, defId: node.defId });
      continue; // senza spec non possiamo dire altro su questo nodo
    }
    validateNode(node, nodeSpec, out);
  }
  return out;
}

/** Convenience: costruisce la spec dal catalog e valida in un colpo. */
export function validateNodesAgainstCatalogEntries(
  nodes: ScaffoldNodeLike[],
  catalog: NodeCatalogEntry[],
): CatalogViolation[] {
  return validateNodesAgainstCatalog(nodes, buildCatalogSpec(catalog));
}

/** Messaggio leggibile (per il prompt di riparazione / log). */
export function describeViolation(v: CatalogViolation): string {
  switch (v.kind) {
    case 'unknown_def':
      return `Nodo "${v.nodeId}": defId "${v.defId}" non esiste nel catalogo.`;
    case 'unknown_config_key':
      return `Nodo "${v.nodeId}" (${v.defId}): la chiave di config "${v.key}" non è valida per questo nodo.`;
    case 'invalid_enum':
      return `Nodo "${v.nodeId}" (${v.defId}): "${v.key}"=${JSON.stringify(v.value)} non è tra i valori ammessi [${v.allowed.join(', ')}].`;
    case 'invalid_action':
      return `Nodo "${v.nodeId}" (${v.defId}): action "${v.action}" non valida; ammesse [${v.allowed.join(', ')}].`;
    case 'missing_required':
      return `Nodo "${v.nodeId}" (${v.defId}): manca il campo obbligatorio "${v.key}".`;
  }
}
