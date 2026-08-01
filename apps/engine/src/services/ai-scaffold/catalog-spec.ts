/**
 * catalog-spec — FONTE DI VERITÀ unica per "cosa è valido" in un nodo scaffold.
 *
 * Normalizza un `NodeCatalogEntry` (dal registry runtime, vedi node-catalog.ts)
 * in uno `NodeConfigSpec`: l'insieme delle chiavi di config ammesse, col loro
 * tipo, gli `enum` (per i select), required, secret, e le action ammesse (per i
 * nodi multi-azione `__action`).
 *
 * Questo modulo NON conosce né JSON-Schema né validazione: produce solo la
 * spec normalizzata. La consumano DUE moduli, garantendo coerenza by-construction:
 *   - constrained-schema.ts → grammatica guided_json (vincolo a decode-time, Liara/vLLM)
 *   - catalog-validator.ts   → validazione post-parse (vincolo per TUTTI i provider)
 *
 * Un solo punto interpreta il catalog → impossibile che grammatica e validatore
 * divergano (la classe di bug "lo schema permette X ma il validatore lo rifiuta").
 *
 * @module services/ai-scaffold/catalog-spec
 */
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

/** Tipi di config il cui VALORE è una stringa "semplice" (testo/segreto/picker). */
const STRING_VALUE_TYPES = new Set<string>([
  'text', 'textarea', 'secret', 'expression', 'code', 'rich-text',
  'file-picker', 'directory-picker', 'timezone-picker', 'cron-builder',
  'email-account-picker', 'db-picker', 'db-table-picker', 'db-collection-picker',
  'workflow-picker',
]);

/** Tipi il cui valore è strutturato (array/oggetto) → schema permissivo (no
 *  over-vincolo della forma annidata: li lasciamo liberi, il vincolo forte è
 *  sulle CHIAVI e sui select, non sulla forma interna di una tabella-filtri). */
const STRUCTURED_VALUE_TYPES = new Set<string>([
  'json', 'key-value', 'chip-list', 'form-fields', 'filter-rows', 'sort-rows',
  'invoice-lines', 'attachments', 'switch-cases', 'condition-rules',
]);

/** Categoria del valore di un config field, ai fini dello schema/validazione. */
export type ConfigValueKind = 'string' | 'number' | 'boolean' | 'enum' | 'structured';

export interface ConfigKeySpec {
  key: string;
  kind: ConfigValueKind;
  /** Valori ammessi quando kind === 'enum' (dai `options` del select). */
  options?: string[];
  required: boolean;
  /** I segreti sono "pending" (riempiti dopo dall'utente): MAI forzati come
   *  required nella generazione, MAI segnalati come missing dal validatore. */
  secret: boolean;
  /** Valore di default dichiarato dal NodeDef (se presente) — usato dall'auto-
   *  config deterministica per riempire i campi mancanti senza chiamare l'LLM. */
  defaultValue?: string;
}

export interface NodeConfigSpec {
  defId: string;
  /** Chiavi di config ammesse → spec. Per i multi-azione include lo UNION dei
   *  campi shared + tutti i campi delle action. */
  keys: Map<string, ConfigKeySpec>;
  /** Id delle action ammesse in `config.__action` (solo nodi multi-azione). */
  actionIds?: string[];
  /** True se il nodo è multi-azione → la config ammette `__action`/`__resource`. */
  multiAction: boolean;
}

/** Mappa il `type` di un catalog-field nella categoria-valore normalizzata. */
function valueKind(type: string, hasOptions: boolean): ConfigValueKind {
  if (type === 'select') return hasOptions ? 'enum' : 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (STRUCTURED_VALUE_TYPES.has(type)) return 'structured';
  if (STRING_VALUE_TYPES.has(type)) return 'string';
  // Tipo sconosciuto (catalog evoluto oltre questo modulo): trattalo come
  // strutturato/permissivo — MAI vincolarlo a un tipo sbagliato che bloccherebbe
  // generazioni valide. Difensivo > restrittivo su tipi non previsti.
  return 'structured';
}

type CatalogField = NodeCatalogEntry['fields'][number];

function fieldToSpec(f: CatalogField): ConfigKeySpec {
  const isSecret = f.type === 'secret';
  const hasOptions = Array.isArray(f.options) && f.options.length > 0;
  const spec: ConfigKeySpec = {
    key: f.key,
    kind: valueKind(f.type, hasOptions),
    // I segreti non sono mai "required" ai fini generazione/validazione (pending).
    required: f.required && !isSecret,
    secret: isSecret,
  };
  if (spec.kind === 'enum' && f.options && f.options.length > 0) spec.options = [...f.options];
  if (typeof f.defaultValue === 'string' && f.defaultValue.length > 0) spec.defaultValue = f.defaultValue;
  return spec;
}

/**
 * Normalizza un catalog entry nella spec di config. Per i nodi multi-azione
 * fonde i campi shared (top-level) con TUTTI i campi delle action (union):
 * non potendo sapere a priori quale action sceglierà il modello, ammettiamo
 * l'unione delle chiavi (il vincolo resta forte: nessuna chiave FUORI da quelle
 * dichiarate da QUALCHE action). La precisione per-action è una raffinazione
 * futura (discriminazione su __action).
 */
export function buildNodeConfigSpec(entry: NodeCatalogEntry): NodeConfigSpec {
  const keys = new Map<string, ConfigKeySpec>();
  for (const f of entry.fields) keys.set(f.key, fieldToSpec(f));

  const actions = entry.actions ?? [];
  const multiAction = actions.length > 0;
  if (multiAction) {
    for (const a of actions) {
      for (const f of a.fields) {
        // I campi shared hanno precedenza (già inseriti); non sovrascrivere il
        // loro `required` con quello — più debole — di una singola action.
        if (!keys.has(f.key)) keys.set(f.key, { ...fieldToSpec(f), required: false });
      }
    }
  }

  const spec: NodeConfigSpec = { defId: entry.defId, keys, multiAction };
  if (multiAction) spec.actionIds = actions.map((a) => a.id);
  return spec;
}

/** Costruisce la spec per l'intero catalog, indicizzata per defId. L'ultimo
 *  entry con lo stesso defId vince (allineato a buildNodeCatalog de-dup). */
export function buildCatalogSpec(catalog: NodeCatalogEntry[]): Map<string, NodeConfigSpec> {
  const out = new Map<string, NodeConfigSpec>();
  for (const entry of catalog) out.set(entry.defId, buildNodeConfigSpec(entry));
  return out;
}

/** True se il valore di config è un'espressione FlowForge (`{{ ... }}`): in tal
 *  caso enum/tipo-primitivo NON vanno applicati (il valore è risolto a runtime). */
export function isExpressionValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{') && value.includes('}}');
}
