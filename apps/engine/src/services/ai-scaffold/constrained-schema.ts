/**
 * constrained-schema — grammatica guided_json PER-TIPO-NODO.
 *
 * Lo schema statico (SINGLESHOT_OUTPUT_SCHEMA) lascia `defId` libero (qualsiasi
 * stringa) e `config` aperta (additionalProperties:true): il modello PUÒ
 * allucinare un nodo inesistente o chiavi/enum di config sbagliati.
 *
 * Qui compiliamo il catalog in una UNIONE DISCRIMINATA (`anyOf`) dove ogni ramo
 * fissa `defId` a un literal (`const`) e vincola la `config` alle SOLE chiavi
 * dichiarate da quel nodo, con `enum` sui select e `additionalProperties:false`.
 * Per vLLM/xgrammar questo rende IMPOSSIBILE a decode-time:
 *   - un defId inesistente (l'unione è chiusa, niente ramo "catch-all"),
 *   - una chiave di config inventata,
 *   - un valore enum fuori lista.
 * Non "sperato dal prompt": impossibile per costruzione del decoder.
 *
 * Scelte di robustezza (prodotto di punta, non degradare le generazioni valide):
 *   - VALORI permissivi (number/boolean/strutturati = `{}`): un valore può essere
 *     un'espressione `{{ }}` (stringa) anche su un campo numerico → non lo
 *     vincoliamo al tipo primitivo. Il vincolo forte è su defId/chiavi/enum.
 *   - REQUIRED non forzato nella grammatica: alcuni campi sono required solo in
 *     certe condizioni (`showIf`) non codificate nel catalog → forzarli sempre
 *     bloccherebbe config valide. La completezza è affidata al validatore +
 *     loop di riparazione (catalog-validator.ts).
 *   - SIZE-CAP + fallback: oltre `maxBranches` rami ritorna null (il caller usa
 *     lo schema statico) → niente grammatiche xgrammar patologiche.
 *
 * @module services/ai-scaffold/constrained-schema
 */
import { SINGLESHOT_OUTPUT_SCHEMA } from '@/services/ai-scaffold/schema.js';
import { buildCatalogSpec, type ConfigKeySpec, type NodeConfigSpec } from '@/services/ai-scaffold/catalog-spec.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

/** Massimo numero di rami (defId) oltre il quale si rinuncia (fallback statico). */
const DEFAULT_MAX_BRANCHES = 800;

type JsonSchema = Record<string, unknown>;

/** Schema JSON del VALORE di un config field. Permissivo dove serve per non
 *  bloccare le espressioni; `enum` solo dove è sicuro (select con options). */
function valueSchema(spec: ConfigKeySpec): JsonSchema {
  switch (spec.kind) {
    case 'enum':
      // Select con options → stringa vincolata ai valori dichiarati.
      return spec.options && spec.options.length > 0
        ? { type: 'string', enum: [...spec.options] }
        : { type: 'string' };
    case 'string':
      return { type: 'string' };
    // number/boolean/structured → permissivo: il valore può essere un literal
    // OPPURE un'espressione `{{ }}` (stringa). Non vincoliamo il tipo primitivo.
    case 'number':
    case 'boolean':
    case 'structured':
    default:
      return {};
  }
}

/** Schema della `config` per un nodo: solo chiavi note, niente extra. */
function configSchema(spec: NodeConfigSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [key, keySpec] of spec.keys) properties[key] = valueSchema(keySpec);

  if (spec.multiAction) {
    // __action vincolato agli id reali; __resource libero (le resource non sono
    // nel catalog entry → stringa generica, comunque sotto una chiave nota).
    properties.__action = spec.actionIds && spec.actionIds.length > 0
      ? { type: 'string', enum: [...spec.actionIds] }
      : { type: 'string' };
    properties.__resource = { type: 'string' };
  }

  return { type: 'object', properties, additionalProperties: false };
}

/** Ramo dell'unione per un singolo defId: `defId` come `const`, config vincolata. */
function nodeBranch(spec: NodeConfigSpec, baseItemProps: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties: {
      id: baseItemProps.id,
      defId: { const: spec.defId },
      label: baseItemProps.label,
      x: { type: 'number' },
      y: { type: 'number' },
      config: configSchema(spec),
    },
    required: ['id', 'defId', 'config'],
    additionalProperties: false,
  };
}

export interface BuildConstrainedSchemaOptions {
  /** Oltre questo numero di rami → null (fallback statico). Default 800. */
  maxBranches?: number;
}

/**
 * Compila il catalog nello schema guided_json vincolato. Ritorna `null` quando
 * non è applicabile (catalog vuoto o troppi rami) → il caller usa
 * SINGLESHOT_OUTPUT_SCHEMA. L'inviluppo (name/reasoning/edges/tablesToCreate)
 * è CLONATO dallo schema statico → unica fonte per la parte non-nodi.
 */
export function buildConstrainedOutputSchema(
  catalog: NodeCatalogEntry[],
  opts: BuildConstrainedSchemaOptions = {},
): JsonSchema | null {
  const spec = buildCatalogSpec(catalog);
  if (spec.size === 0) return null;
  const maxBranches = opts.maxBranches ?? DEFAULT_MAX_BRANCHES;
  if (spec.size > maxBranches) return null;

  // Deep-clone dell'inviluppo statico (readonly `as const` → mutabile via clone).
  const schema = JSON.parse(JSON.stringify(SINGLESHOT_OUTPUT_SCHEMA)) as JsonSchema;
  const schemaProps = schema.properties as Record<string, JsonSchema>;
  const nodes = schemaProps.nodes;
  if (!nodes) return null; // l'inviluppo statico ha sempre `nodes` — guardia difensiva
  const nodesItems = nodes.items as JsonSchema;
  const baseItemProps = (nodesItems.properties ?? {}) as Record<string, JsonSchema>;

  const branches: JsonSchema[] = [];
  for (const nodeSpec of spec.values()) branches.push(nodeBranch(nodeSpec, baseItemProps));

  // items → unione discriminata. minItems/maxItems restano dall'inviluppo.
  nodes.items = { anyOf: branches };
  return schema;
}

/**
 * Restringe il catalog di VALIDAZIONE ai soli defId del subset RAG (i nodi
 * recuperati per il goal). Così la grammatica è PICCOLA (15-70 rami invece di
 * ~185) → compile veloce + STEERING verso i nodi pertinenti, e usa le STESSE
 * spec del validatore (zero drift: grammar ⊆ validation-catalog).
 *
 * Lo smoke live ha provato che vincolare al FULL-catalog degrada la scelta del
 * nodo (185 opzioni, nessuno steering → il modello collassa su un nodo errato):
 * il subset è la versione attivabile.
 *
 * Fallback al full-catalog se: subset assente (retrieval giù) o intersezione
 * vuota (nessun defId del subset è nel catalog di validazione) → mai peggio.
 */
export function pickGrammarCatalog(
  fullCatalog: NodeCatalogEntry[],
  subsetDefIds?: ReadonlySet<string>,
): NodeCatalogEntry[] {
  if (!subsetDefIds || subsetDefIds.size === 0) return fullCatalog;
  const filtered = fullCatalog.filter((c) => subsetDefIds.has(c.defId));
  return filtered.length > 0 ? filtered : fullCatalog;
}

/**
 * Flag d'attivazione della grammatica vincolata. Default OFF: cambia il path di
 * generazione del PRODOTTO DI PUNTA → si abilita esplicitamente dopo lo smoke
 * live contro vLLM/xgrammar (set `MEDEA_SCAFFOLD_CONSTRAINED_SCHEMA=true`).
 */
export function isConstrainedSchemaEnabled(): boolean {
  return process.env.MEDEA_SCAFFOLD_CONSTRAINED_SCHEMA === 'true';
}

export interface ScaffoldSchemaChoice {
  /** Schema da passare a dispatchLLMChatStructuredStreaming. */
  schema: object;
  /** True se è la grammatica vincolata per-nodo (false = inviluppo statico). */
  constrained: boolean;
}

/**
 * Sceglie lo schema di output per lo scaffold.
 *
 * La grammatica vincolata vale SOLO per Liara/vLLM (guided_json a decode-time).
 * Per i provider BYOK lo schema finisce EMBEDDATO nel prompt (dispatchLLMChat-
 * Structured): una grammatica con ~200 rami gonfierebbe il prompt a dismisura →
 * per loro si tiene lo schema statico (piccolo) e il vincolo è dato dal
 * validatore post-parse (catalog-validator.ts). Fallback allo statico anche
 * quando il compiler ritorna null (catalog vuoto / over-cap).
 */
export function selectScaffoldSchema(
  catalog: NodeCatalogEntry[],
  provider: string,
  staticSchema: object,
): ScaffoldSchemaChoice {
  if (provider !== 'liara' || !isConstrainedSchemaEnabled()) {
    return { schema: staticSchema, constrained: false };
  }
  const constrained = buildConstrainedOutputSchema(catalog);
  return constrained ? { schema: constrained, constrained: true } : { schema: staticSchema, constrained: false };
}
