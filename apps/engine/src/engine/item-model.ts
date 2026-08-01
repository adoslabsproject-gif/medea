/**
 * Paired-item lineage resolver — parte ENGINE-INTERNA del data-model
 * array-of-items (GAP #2). I TIPI canonici (`ExecutionItem`, `PairedItemRef`) e
 * gli helper puri (`normalizeToItems`, `lineage`) vivono in `@flowforge/core-schema`
 * perché sono il contratto condiviso engine↔executor (port&adapter). Qui sta solo
 * ciò che richiede la conoscenza dell'INTERA run: il grafo degli output per nodo e
 * l'algoritmo di risoluzione che cammina a ritroso la catena dei pairedItem.
 *
 * Algoritmo (come n8n): per risolvere `$('A').item` partendo dall'item `i` del
 * nodo corrente `C`, si risale la catena dei pairedItem — C→…→A — finché si
 * raggiunge A, e si ritorna l'item risolto di A. Disambigua i merge multi-input
 * via `sourceNodeId`; sugli aggregate N→1 segue il primo percorso che raggiunge
 * il target; guardia anti-ciclo/runaway.
 */
import {
  pairedRefs,
  normalizeToItems,
  toExecutionItem,
  type ExecutionItem,
  type PairedItemRef,
} from '@flowforge/core-schema';

export type { ExecutionItem, PairedItemRef } from '@flowforge/core-schema';
export { normalizeToItems, lineage } from '@flowforge/core-schema';

/** Output items per nodo della run corrente: `nodeId → ExecutionItem[]`. */
export type RunItemGraph = Map<string, ExecutionItem[]>;

/**
 * Lineage bits che il BFS passa a `executeNode` (fase 4.2). L'ancora della
 * semantica PAIRED è l'item di INPUT corrente `(sourceNodeId, itemIndex)`:
 * `sourceNodeId` = nodo che ha PRODOTTO l'input (provenienza dell'edge
 * percorso, assente sulle root), `itemIndex` = `loop.index` dentro un
 * fan-out (0 fuori). L'output del nodo in esecuzione NON è ancora nel grafo,
 * quindi ancorarsi al predecessore è l'unica scelta corretta.
 */
export interface NodeLineageArgs {
  graph: RunItemGraph;
  sourceNodeId?: string;
  predecessorOf: (nodeId: string) => string | undefined;
}

/** Aggiunge `sourceNodeId` ai ref che non lo dichiarano (enrichment engine-side). */
function enrichRefs(
  pi: PairedItemRef | PairedItemRef[],
  sourceNodeId: string,
): PairedItemRef | PairedItemRef[] {
  const one = (r: PairedItemRef): PairedItemRef =>
    r.sourceNodeId === undefined ? { ...r, sourceNodeId } : r;
  return Array.isArray(pi) ? pi.map(one) : one(pi);
}

/**
 * Costruisce la vista item-native dell'output di un nodo per il RunItemGraph.
 *
 * Precedenza:
 *   1. `declared` (NodeExecutionResult.items, executor item-native) → usata
 *      as-is, con enrichment del `sourceNodeId` runtime sui ref che non lo
 *      dichiarano (l'executor non conosce il nodeId della sorgente; l'engine
 *      sì — i ref espliciti restano risolvibili anche senza predecessor-map).
 *   2. Euristica conservativa (parità n8n "automatic item linking"), MAI
 *      applicata a item che dichiarano già un proprio `pairedItem`:
 *        • sorgente con 1 item   → ogni output deriva da quello (`{item:0}`)
 *        • stessa cardinalità    → pairing posizionale 1:1 (`{item:i}`)
 *        • N→1 (aggregazione)    → l'unico output deriva da TUTTI (fromMany)
 *        • altrimenti            → NESSUN pairing (onesto: l'engine non sa;
 *          i nodi che scartano/riordinano DEVONO dichiarare — vedi filter)
 *   3. Sorgente assente (root/trigger input) → item senza lineage.
 */
export function deriveOutputItems(args: {
  output: unknown;
  declared?: ExecutionItem[];
  sourceNodeId?: string;
  /** Cardinalità della vista item della SORGENTE nel grafo (`graph.get(S).length`). */
  sourceItemCount?: number;
}): ExecutionItem[] {
  const { output, declared, sourceNodeId, sourceItemCount } = args;
  if (declared !== undefined) {
    if (sourceNodeId === undefined) return declared;
    return declared.map((it) =>
      it.pairedItem === undefined ? it : { ...it, pairedItem: enrichRefs(it.pairedItem, sourceNodeId) });
  }
  const items = normalizeToItems(output);
  if (sourceNodeId === undefined || sourceItemCount === undefined || sourceItemCount === 0) {
    return items;
  }
  const pairTo = (it: ExecutionItem, pi: PairedItemRef | PairedItemRef[]): ExecutionItem =>
    it.pairedItem !== undefined ? it : { ...it, pairedItem: pi };
  if (sourceItemCount === 1) {
    return items.map((it) => pairTo(it, { item: 0, sourceNodeId }));
  }
  if (items.length === sourceItemCount) {
    return items.map((it, i) => pairTo(it, { item: i, sourceNodeId }));
  }
  if (items.length === 1 && items[0] !== undefined) {
    const all = Array.from({ length: sourceItemCount }, (_, i): PairedItemRef => ({ item: i, sourceNodeId }));
    return [pairTo(items[0], all)];
  }
  return items;
}

/**
 * Vista item-native dei risultati di un fan-out (GAP 1, edge.mapMode): il
 * risultato `i` deriva BY-CONSTRUCTION dall'item `i` dell'array prodotto
 * dalla sorgente — è l'unico punto dove l'engine conosce il mapping esatto
 * senza interrogare l'executor. Ogni result resta UN item (un array non
 * viene splittato). Sorgente assente (fan-out su trigger input) → niente
 * lineage: non c'è alcun nodo a monte da risolvere.
 */
export function deriveFanOutItems(
  results: readonly unknown[],
  sourceNodeId: string | undefined,
): ExecutionItem[] {
  return results.map((r, i) => {
    const it = toExecutionItem(r);
    if (sourceNodeId === undefined || it.pairedItem !== undefined) return it;
    return { ...it, pairedItem: { item: i, sourceNodeId } };
  });
}

const MAX_LINEAGE_HOPS = 1000;

/**
 * Risolve l'item accoppiato di `targetNodeId` partendo dall'item `fromItemIndex`
 * del nodo `fromNodeId`, camminando a ritroso la catena dei `pairedItem`.
 *
 * @param predecessorOf  dato un nodeId, ritorna l'UNICO predecessore lineare
 *   (usato quando `pairedItem.sourceNodeId` è assente). Per i nodi multi-input
 *   il lineage DEVE specificare `sourceNodeId`, altrimenti la risoluzione fallisce.
 * @returns l'`ExecutionItem` risolto di `targetNodeId`, o `undefined` se il
 *   lineage si interrompe (item generato ex-novo, ref rotto, target irraggiungibile).
 */
export function resolvePairedItem(
  graph: RunItemGraph,
  fromNodeId: string,
  fromItemIndex: number,
  targetNodeId: string,
  predecessorOf: (nodeId: string) => string | undefined,
): ExecutionItem | undefined {
  if (fromNodeId === targetNodeId) {
    return graph.get(targetNodeId)?.[fromItemIndex];
  }

  const visited = new Set<string>();
  const walk = (nodeId: string, itemIndex: number, hops: number): ExecutionItem | undefined => {
    if (hops > MAX_LINEAGE_HOPS) return undefined;
    const item = graph.get(nodeId)?.[itemIndex];
    if (!item) return undefined;

    const refs = pairedRefs(item.pairedItem);
    if (refs.length === 0) return undefined; // lineage interrotto

    for (const ref of refs) {
      const sourceNode = ref.sourceNodeId ?? predecessorOf(nodeId);
      if (sourceNode === undefined) continue;

      if (sourceNode === targetNodeId) {
        return graph.get(targetNodeId)?.[ref.item];
      }

      const visitKey = `${sourceNode}#${String(ref.item)}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const resolved = walk(sourceNode, ref.item, hops + 1);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  };

  return walk(fromNodeId, fromItemIndex, 0);
}
