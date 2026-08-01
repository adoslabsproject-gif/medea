/**
 * Test constrained-schema — la grammatica guided_json per-nodo.
 *
 * Tre livelli, anti-greensmoke:
 *  1. Un mini-evaluator JSON-Schema del SOTTOINSIEME che emettiamo (const/enum/
 *     type/object+additionalProperties/required/anyOf), AUTO-TESTATO su micro-casi
 *     → oracolo fidato, non cieco.
 *  2. Con quell'oracolo: un nodo VALIDO passa, e OGNI classe di nodo rotto
 *     (defId inesistente, chiave inventata, enum fuori lista) viene RIFIUTATA
 *     dalla grammatica → prova che vincola davvero a decode-time.
 *  3. Struttura + contract anti-drift (la grammatica e il validatore condividono
 *     la spec → stesse chiavi/enum) + fallback (catalog vuoto / over-cap).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildConstrainedOutputSchema, selectScaffoldSchema, isConstrainedSchemaEnabled, pickGrammarCatalog } from './constrained-schema.js';
import { SINGLESHOT_OUTPUT_SCHEMA } from './schema.js';
import type { NodeCatalogEntry } from './node-catalog.js';

// ─────────────────────────── mini JSON-Schema evaluator ───────────────────────────
type JS = Record<string, unknown>;
function evalSchema(schema: JS, value: unknown): boolean {
  if ('const' in schema) return value === schema.const;
  if (Array.isArray(schema.enum)) return (schema.enum).includes(value);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as JS[]).some((s) => evalSchema(s, value));
  const type = schema.type as string | undefined;
  if (type === undefined) return true; // {} = any
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const items = schema.items as JS | undefined;
    return items ? value.every((v) => evalSchema(items, v)) : true;
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const props = (schema.properties ?? {}) as Record<string, JS>;
    const addl = schema.additionalProperties;
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (k in props) { if (!evalSchema(props[k]!, obj[k])) return false; }
      else if (addl === false) return false; // chiave non dichiarata vietata
    }
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) return false;
    }
    return true;
  }
  return true;
}

describe('🔬 self-test del mini-evaluator (non un oracolo cieco)', () => {
  it('const accetta solo il valore', () => {
    expect(evalSchema({ const: 'x' }, 'x')).toBe(true);
    expect(evalSchema({ const: 'x' }, 'y')).toBe(false);
  });
  it('enum', () => {
    expect(evalSchema({ enum: ['a', 'b'] }, 'b')).toBe(true);
    expect(evalSchema({ enum: ['a', 'b'] }, 'c')).toBe(false);
  });
  it('object additionalProperties:false vieta chiavi extra', () => {
    const s = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(evalSchema(s, { a: 'ok' })).toBe(true);
    expect(evalSchema(s, { a: 'ok', extra: 1 })).toBe(false);
  });
  it('required', () => {
    const s = { type: 'object', properties: { a: {} }, required: ['a'] };
    expect(evalSchema(s, { a: 1 })).toBe(true);
    expect(evalSchema(s, {})).toBe(false);
  });
  it('anyOf accetta se UN ramo matcha', () => {
    const s = { anyOf: [{ const: 'p' }, { const: 'q' }] };
    expect(evalSchema(s, 'q')).toBe(true);
    expect(evalSchema(s, 'z')).toBe(false);
  });
  it('{} = any', () => {
    expect(evalSchema({}, 42)).toBe(true);
    expect(evalSchema({}, '{{ expr }}')).toBe(true);
  });
});

// ─────────────────────────── catalog di prova ───────────────────────────
const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'trigger_manual', type: 'trigger', label: 'Manual', description: '', fields: [],
  },
  {
    defId: 'action_http_request', type: 'action', label: 'HTTP', description: '',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'Method', type: 'select', required: true, options: ['GET', 'POST'] },
      { key: 'timeout', label: 'Timeout', type: 'number', required: false },
      { key: 'apiKey', label: 'Key', type: 'secret', required: true },
    ],
  },
  {
    defId: 'community_telegram', type: 'action', label: 'TG', description: '',
    fields: [{ key: 'botToken', label: 'Token', type: 'secret', required: true }],
    actions: [{ id: 'send_message', label: 'Send', fields: [{ key: 'chatId', label: 'C', type: 'text', required: true }] }],
  },
];

/** Estrae lo schema dei singoli nodi (anyOf dei rami) dalla grammatica compilata. */
function itemsSchema(): JS {
  const schema = buildConstrainedOutputSchema(CATALOG)!;
  return ((schema.properties as Record<string, JS>).nodes!).items as JS;
}

describe('🚨 la grammatica VINCOLA davvero (via oracolo auto-testato)', () => {
  const items = itemsSchema();

  it('✅ nodo valido (defId reale, config con chiavi/enum validi) → ACCETTATO', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'GET', timeout: 30 } })).toBe(true);
  });

  it('🚨 defId INESISTENTE → RIFIUTATO (unione chiusa, niente catch-all)', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_inventato', config: {} })).toBe(false);
  });

  it('🚨 chiave di config INVENTATA → RIFIUTATA (additionalProperties:false)', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'GET', bogus: 1 } })).toBe(false);
  });

  it('🚨 valore enum FUORI LISTA → RIFIUTATO', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'PATCH' } })).toBe(false);
  });

  it('✅ enum valido tra le options → ACCETTATO', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'POST' } })).toBe(true);
  });

  it('✅ valore numerico permissivo: number letterale O espressione {{ }} → ENTRAMBI accettati', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'GET', timeout: 30 } })).toBe(true);
    expect(evalSchema(items, { id: 'n1', defId: 'action_http_request', config: { url: 'https://x', method: 'GET', timeout: '{{ vars.t }}' } })).toBe(true);
  });

  it('✅ multi-azione: __action valido accettato, 🚨 __action inventato rifiutato', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'community_telegram', config: { __action: 'send_message', chatId: '1' } })).toBe(true);
    expect(evalSchema(items, { id: 'n1', defId: 'community_telegram', config: { __action: 'fly' } })).toBe(false);
  });

  it('✅ nodo senza campi (trigger_manual) → config DEVE essere {} (no chiavi extra)', () => {
    expect(evalSchema(items, { id: 'n1', defId: 'trigger_manual', config: {} })).toBe(true);
    expect(evalSchema(items, { id: 'n1', defId: 'trigger_manual', config: { foo: 1 } })).toBe(false);
  });
});

describe('struttura & inviluppo', () => {
  it('un ramo per defId, con defId come const', () => {
    const items = itemsSchema();
    const branches = items.anyOf as JS[];
    const consts = branches.map((b) => ((b.properties as Record<string, JS>).defId!).const);
    expect(consts.sort()).toEqual(['action_http_request', 'community_telegram', 'trigger_manual'].sort());
  });

  it('config additionalProperties:false su ogni ramo', () => {
    const branches = (itemsSchema().anyOf as JS[]);
    for (const b of branches) {
      const cfg = (b.properties as Record<string, JS>).config!;
      expect(cfg.additionalProperties).toBe(false);
    }
  });

  it('inviluppo (name/reasoning/edges/tablesToCreate) preservato dallo schema statico', () => {
    const schema = buildConstrainedOutputSchema(CATALOG)!;
    const base = SINGLESHOT_OUTPUT_SCHEMA as unknown as JS;
    const props = schema.properties as Record<string, JS>;
    const baseProps = base.properties as Record<string, JS>;
    expect(props.name).toEqual(baseProps.name);
    expect(props.reasoning).toEqual(baseProps.reasoning);
    expect(props.edges).toEqual(baseProps.edges);
    expect(props.tablesToCreate).toEqual(baseProps.tablesToCreate);
    expect(schema.required).toEqual(base.required);
    // minItems/maxItems dei nodi restano dall'inviluppo
    const nodes = (schema.properties as Record<string, JS>).nodes!;
    expect(nodes.minItems).toBe(3);
    expect(nodes.maxItems).toBe(30);
  });

  it('REQUIRED non forzato nella config (showIf-safe): required del ramo = solo id/defId/config', () => {
    const branches = itemsSchema().anyOf as JS[];
    for (const b of branches) {
      expect(b.required).toEqual(['id', 'defId', 'config']);
      const cfg = (b.properties as Record<string, JS>).config!;
      expect(cfg.required).toBeUndefined();
    }
  });
});

describe('fallback (null → il caller usa lo schema statico)', () => {
  it('catalog vuoto → null', () => {
    expect(buildConstrainedOutputSchema([])).toBeNull();
  });
  it('oltre maxBranches → null', () => {
    expect(buildConstrainedOutputSchema(CATALOG, { maxBranches: 2 })).toBeNull();
  });
  it('entro maxBranches → schema (non null)', () => {
    expect(buildConstrainedOutputSchema(CATALOG, { maxBranches: 3 })).not.toBeNull();
  });
});

describe('pickGrammarCatalog — grammatica sul subset RAG (anti full-catalog degrade)', () => {
  it('subset dato → catalog ristretto a quei defId (grammatica piccola + steering)', () => {
    const sub = new Set(['action_http_request', 'community_telegram']);
    const picked = pickGrammarCatalog(CATALOG, sub);
    expect(picked.map((c) => c.defId).sort()).toEqual(['action_http_request', 'community_telegram']);
    // e la grammatica costruita ha SOLO quei rami
    const grammar = buildConstrainedOutputSchema(picked)!;
    const branches = (((grammar.properties as Record<string, JS>).nodes!).items as JS).anyOf as JS[];
    expect(branches).toHaveLength(2);
  });

  it('🚨 subset assente → full catalog (fallback retrieval-giù)', () => {
    expect(pickGrammarCatalog(CATALOG, undefined)).toBe(CATALOG);
  });

  it('🚨 subset vuoto → full catalog', () => {
    expect(pickGrammarCatalog(CATALOG, new Set())).toBe(CATALOG);
  });

  it('🚨 intersezione VUOTA (subset tutto fuori dal catalog di validazione) → full catalog (mai grammatica vuota)', () => {
    const picked = pickGrammarCatalog(CATALOG, new Set(['nodo_custom_inesistente']));
    expect(picked).toBe(CATALOG); // fallback: meglio full che zero rami
  });

  it('intersezione PARZIALE → solo i defId presenti', () => {
    const picked = pickGrammarCatalog(CATALOG, new Set(['action_http_request', 'fantasma']));
    expect(picked.map((c) => c.defId)).toEqual(['action_http_request']);
  });
});

describe('selectScaffoldSchema — policy provider + flag + fallback', () => {
  const STATIC = { sentinel: 'static-schema' } as const;
  afterEach(() => { delete process.env.FLOWFORGE_SCAFFOLD_CONSTRAINED_SCHEMA; });

  it('flag OFF (default) → statico anche per liara (constrained:false)', () => {
    expect(isConstrainedSchemaEnabled()).toBe(false);
    const r = selectScaffoldSchema(CATALOG, 'liara', STATIC);
    expect(r.constrained).toBe(false);
    expect(r.schema).toBe(STATIC);
  });

  it('flag ON + liara → grammatica vincolata (constrained:true, ha nodes.items.anyOf)', () => {
    process.env.FLOWFORGE_SCAFFOLD_CONSTRAINED_SCHEMA = 'true';
    const r = selectScaffoldSchema(CATALOG, 'liara', STATIC);
    expect(r.constrained).toBe(true);
    const nodes = ((r.schema as JS).properties as Record<string, JS>).nodes!;
    expect((nodes.items as JS).anyOf).toBeDefined();
  });

  it('🚨 flag ON + provider BYOK (openai) → STATICO (no grammar embeddata nel prompt)', () => {
    process.env.FLOWFORGE_SCAFFOLD_CONSTRAINED_SCHEMA = 'true';
    const r = selectScaffoldSchema(CATALOG, 'openai', STATIC);
    expect(r.constrained).toBe(false);
    expect(r.schema).toBe(STATIC);
  });

  it('flag ON + liara + catalog VUOTO → fallback statico (compiler null)', () => {
    process.env.FLOWFORGE_SCAFFOLD_CONSTRAINED_SCHEMA = 'true';
    const r = selectScaffoldSchema([], 'liara', STATIC);
    expect(r.constrained).toBe(false);
    expect(r.schema).toBe(STATIC);
  });
});

describe('🔒 contract anti-drift: grammatica ⇄ validatore condividono la stessa spec', () => {
  it('le chiavi di config ammesse nella grammatica == quelle della spec (per ogni nodo)', async () => {
    const { buildCatalogSpec } = await import('./catalog-spec.js');
    const spec = buildCatalogSpec(CATALOG);
    const branches = itemsSchema().anyOf as JS[];
    for (const b of branches) {
      const defId = ((b.properties as Record<string, JS>).defId!).const as string;
      const cfgProps = Object.keys(((b.properties as Record<string, JS>).config!).properties as Record<string, JS>);
      const specKeys = [...spec.get(defId)!.keys.keys()];
      const meta = spec.get(defId)!.multiAction ? ['__action', '__resource'] : [];
      expect(cfgProps.sort()).toEqual([...specKeys, ...meta].sort());
    }
  });
});
