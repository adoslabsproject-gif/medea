/**
 * ExecutionItem — l'unità CANONICA di dato che fluisce su ogni edge del workflow
 * (data-model "array-of-items" stile n8n). Sostituisce il vecchio modello
 * "blob per nodo": ogni nodo riceve e produce `ExecutionItem[]`, e ogni item
 * porta il proprio lineage (`pairedItem`) verso l'item di input da cui deriva.
 *
 * Vive in core-schema (non nell'app runtime) perché è il CONTRATTO condiviso tra
 * il motore (apps/engine) e gli executor dei nodi
 * (@medea/engine-nodes-*): port&adapter — gli executor non possono dipendere
 * dall'app, ma entrambi dipendono da questo schema.
 *
 * Il lineage (`pairedItem`) è ciò che rende possibile `$('NodoA').item`: sapere,
 * dato l'item corrente, quale item di NodoA gli corrisponde anche dopo
 * branch/filter/merge/map 1→N/aggregate N→1. La risoluzione vera (camminata a
 * ritroso sul grafo della run) è engine-interna; qui stanno il TIPO e gli helper
 * PURI di costruzione che gli executor usano per dichiarare il proprio lineage.
 */
import { z } from 'zod';
import { BinaryDataSchema } from './binary.js';

/**
 * Riferimento di lineage: da quale item (e, sui merge multi-input, da quale nodo
 * sorgente) deriva un item di output.
 */
export const PairedItemRefSchema = z.object({
  /** Indice (>=0) dell'item nell'output del nodo sorgente da cui questo deriva. */
  item: z.number().int().nonnegative(),
  /**
   * Nodo sorgente. Se assente si assume l'UNICO predecessore del nodo (caso
   * lineare 1-input). Obbligatorio sui merge multi-input per disambiguare il ramo.
   */
  sourceNodeId: z.string().min(1).optional(),
});
export type PairedItemRef = z.infer<typeof PairedItemRefSchema>;

/** Lineage di un item: singolo ref (1→1, 1→N) o array (merge/aggregate N→1). */
export const PairedItemSchema = z.union([PairedItemRefSchema, z.array(PairedItemRefSchema)]);

/** Un singolo item: json (sempre un oggetto) + binari opzionali + lineage opzionale. */
export const ExecutionItemSchema = z.object({
  /** Payload dati dell'item. SEMPRE un oggetto (mai scalare/array) — invariante n8n. */
  json: z.record(z.string(), z.unknown()),
  /** Allegati binari content-addressed, keyed per nome (es. 'data', 'attachment'). */
  binary: z.record(z.string(), BinaryDataSchema).optional(),
  /** Lineage verso l'input. Assente = nessun lineage (trigger / dato generato ex-novo). */
  pairedItem: PairedItemSchema.optional(),
});
export type ExecutionItem = z.infer<typeof ExecutionItemSchema>;

/** Type guard: true se `v` è un ExecutionItem ben formato (json oggetto non-array). */
export function isExecutionItem(v: unknown): v is ExecutionItem {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const json = (v as { json?: unknown }).json;
  return json !== null && typeof json === 'object' && !Array.isArray(json);
}

/** Type guard per un singolo PairedItemRef (item intero >=0). */
export function isPairedItemRef(v: unknown): v is PairedItemRef {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const item = (v as { item?: unknown }).item;
  return typeof item === 'number' && Number.isInteger(item) && item >= 0;
}

/** Normalizza `pairedItem` (singolo | array | assente) in array di ref. */
export function pairedRefs(pi: PairedItemRef | PairedItemRef[] | undefined): PairedItemRef[] {
  if (pi === undefined) return [];
  return Array.isArray(pi) ? pi : [pi];
}

/**
 * Normalizza un output grezzo in `ExecutionItem[]`. Usato al boundary quando un
 * dato non-item entra nel modello (trigger payload, valore generato):
 *   - già `ExecutionItem[]`        → invariato (preserva pairedItem)
 *   - array di oggetti            → un item per elemento (`{ json }`)
 *   - array con scalari           → ogni elemento wrappato (`{ json: { value } }`)
 *   - oggetto singolo             → `[{ json }]`
 *   - scalare/null/undefined      → `[{ json: { value } }]` (gli item sono oggetti)
 */
export function normalizeToItems(raw: unknown): ExecutionItem[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (raw.every(isExecutionItem)) return raw;
    return raw.map(toExecutionItem);
  }
  if (raw === null || raw === undefined) return [{ json: { value: raw } }];
  if (isExecutionItem(raw)) return [raw];
  return [toExecutionItem(raw)];
}

/**
 * Wrappa UN valore in UN singolo ExecutionItem (un array resta UN item
 * `{ json: { value: [...] } }` — NON viene splittato: per quello c'è
 * `normalizeToItems`). Usato dall'engine al fan-out, dove ogni risultato
 * per-item deve restare un item, qualunque sia la sua shape.
 */
export function toExecutionItem(value: unknown): ExecutionItem {
  if (isExecutionItem(value)) return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { json: value as Record<string, unknown> };
  }
  return { json: { value } };
}

/**
 * Helper PURI di costruzione lineage per gli executor:
 *   - passthrough/map 1:1     → `lineage.oneToOne(i)`
 *   - map 1→N / filter        → ogni output usa `lineage.from(inputIndex)`
 *   - aggregate/merge N→1     → `lineage.fromMany(indices)`
 * `sourceNodeId` va passato SOLO sui nodi multi-input (merge) per disambiguare.
 */
export const lineage = {
  oneToOne(index: number, sourceNodeId?: string): PairedItemRef {
    return sourceNodeId !== undefined ? { item: index, sourceNodeId } : { item: index };
  },
  from(inputIndex: number, sourceNodeId?: string): PairedItemRef {
    return sourceNodeId !== undefined ? { item: inputIndex, sourceNodeId } : { item: inputIndex };
  },
  fromMany(inputIndices: number[], sourceNodeId?: string): PairedItemRef[] {
    return inputIndices.map((i) =>
      sourceNodeId !== undefined ? { item: i, sourceNodeId } : { item: i },
    );
  },
};
