/**
 * Catalog retrieval — test ANTI-DRIFT + retriever ibrido.
 *
 * Il test #1 (copertura) è il garante del requisito owner 2026-06-12: "se
 * facciamo nuovi nodi, la catena RAG si aggiorna di pari passo". Verifica che
 * OGNI nodo del catalogo REALE (buildNodeCatalog) finisca nell'index. Aggiungi
 * un nodo senza che l'index lo prenda → questo test diventa rosso nel CI.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { buildCatalogIndex, tokenize, firstSentence } from './index-builder.js';
import { CatalogRetriever, cosine } from './retriever.js';
import { inferCategory } from './category.js';
import { formatCatalogForPrompt } from './index.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

/** Embedder finto deterministico: vettore "bag-of-token-hash" → cosine sensato senza rete. */
function fakeEmbedder(dim = 64): (t: string) => Promise<number[]> {
  return async (text: string) => {
    const v = new Array(dim).fill(0) as number[];
    for (const tok of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      const idx = h % dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return v;
  };
}
const nullEmbedder = async (): Promise<null> => null;

describe('🔒 ANTI-DRIFT — ogni nodo del catalogo REALE è nell\'index', () => {
  it('buildCatalogIndex copre il 100% di buildNodeCatalog (CI fail se un nodo manca)', () => {
    const catalog = buildNodeCatalog();
    const index = buildCatalogIndex(catalog);
    const indexed = new Set(index.map((r) => r.defId));
    const missing = catalog.map((e) => e.defId).filter((id) => !indexed.has(id));
    expect(missing, `nodi nel catalogo ma NON nell'index: ${missing.join(', ')}`).toEqual([]);
    expect(index.length).toBeGreaterThanOrEqual(100); // sanity: il catalogo è grande
  });

  it('ogni record ha categoria valida, shortDesc e keyword non vuoti', () => {
    const index = buildCatalogIndex(buildNodeCatalog());
    for (const r of index) {
      expect(r.category, `${r.defId} senza categoria`).toBeTruthy();
      expect(r.keywords.length, `${r.defId} senza keyword`).toBeGreaterThan(0);
      expect(typeof r.shortDesc).toBe('string');
    }
  });
});

describe('inferCategory — parità con l\'euristica portal', () => {
  it('override espliciti + euristica per-substring', () => {
    expect(inferCategory('action_send_email', 'action')).toBe('email');
    expect(inferCategory('trigger_webhook', 'trigger')).toBe('triggers');
    expect(inferCategory('db_insert', 'action')).toBe('database');
    expect(inferCategory('integration_slack_post', 'action')).toBe('integrations');
    expect(inferCategory('italia_pec_aruba_send', 'action')).toBe('italia');
    expect(inferCategory('action_generate_chart', 'action')).toBe('transform'); // override
    expect(inferCategory('logic_loop', 'logic')).toBe('logic');
  });
});

describe('index-builder helpers', () => {
  it('tokenize: lowercase, no accenti, no stopword, ≥2 char + sinonimi CANONIZZATI', () => {
    // 'invìa' → strip accento → 'invia' → canon IT↔EN → 'send' (così "manda
    // una mail" e "send an email" convergono sugli stessi token).
    expect(tokenize('Invìa una Email città')).toEqual(['send', 'email', 'citta']);
    expect(tokenize('nodo codice')).toEqual(['code']);   // 'nodo' stopword, 'codice'→'code'
    expect(tokenize('filtra il ciclo')).toEqual(['filter', 'loop']);
  });
  it('firstSentence: prima frase troncata', () => {
    expect(firstSentence('Manda una email. E poi altro.')).toBe('Manda una email.');
    expect(firstSentence('x'.repeat(200), 50).length).toBeLessThanOrEqual(50);
  });
});

describe('CatalogRetriever — lessicale (deterministico, sempre-on)', () => {
  const catalog = buildNodeCatalog();

  it('"manda una email al cliente" → action email nei top (match lessicale)', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const top = await r.retrieve('manda una email al cliente', { lexicalOnly: true, k: 10 });
    const ids = top.map((n) => n.defId);
    expect(ids.some((id) => id.includes('email') || id.includes('mail'))).toBe(true);
  });

  it('"salva una riga nel database" → nodo db nei top', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const top = await r.retrieve('salva una riga nel database', { lexicalOnly: true, k: 12 });
    expect(top.some((n) => n.category === 'database')).toBe(true);
  });

  /**
   * 🚨 BUG REALE 2026-06-12 — "creami un nodo code": 'code' matchava SOLO
   * agent_code_reviewer (substring del defId) e MAI action_run_js (keywords
   * run/js/javascript/codice — 'code' inglese assente) → Liara: "il nodo
   * code non esiste" + scaffold di un agent sbagliato. Fix: alias n8n-speak
   * EN↔IT nell'index (EXTRA_KEYWORDS_BY_DEFID).
   */
  it('🚨 "creami un nodo code" → action_run_js nei top (alias n8n-speak, non solo agent_code_reviewer)', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const top = await r.retrieve('creami un nodo code', { lexicalOnly: true, k: 10 });
    const ids = top.map((n) => n.defId);
    expect(ids).toContain('action_run_js');
    expect(ids).toContain('action_run_python');
  });

  it('"function node" e "set fields" (n8n-speak) → run_js / logic_transform nei top', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const fn = await r.retrieve('aggiungi un function node', { lexicalOnly: true, k: 10 });
    expect(fn.map((n) => n.defId)).toContain('action_run_js');
    const set = await r.retrieve('set fields sul risultato', { lexicalOnly: true, k: 10 });
    expect(set.map((n) => n.defId)).toContain('logic_transform');
  });

  it('inUseDefIds: i nodi già nel workflow sono SEMPRE inclusi, in cima', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const top = await r.retrieve('qualcosa di non correlato xyz', { lexicalOnly: true, inUseDefIds: ['logic_loop'], k: 5 });
    expect(top[0]!.defId).toBe('logic_loop');
  });

  it('embedder NULL (giù) → degrada a solo lessicale, nessun crash', async () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const top = await r.retrieve('webhook http', { k: 8 });
    expect(top.length).toBeGreaterThan(0); // funziona comunque
  });

  it('categoryMap: famiglie con conteggio, ordine stabile', () => {
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const map = r.categoryMap();
    expect(map.length).toBeGreaterThanOrEqual(5);
    expect(map.every((c) => c.count > 0)).toBe(true);
  });
});

describe('🚨 embedding lifecycle — store persistente, parallelismo, retry TTL', () => {
  const tinyCatalog = buildNodeCatalog().slice(0, 6);
  const fakeStore = (): { map: Map<string, number[]>; get: (h: string) => number[] | null; put: (h: string, v: number[]) => void } => {
    const map = new Map<string, number[]>();
    return { map, get: (h) => map.get(h) ?? null, put: (h, v) => { map.set(h, v); } };
  };

  it('🚨 secondo retriever sullo STESSO store → ZERO chiamate embedder (warm-up gratis)', async () => {
    const store = fakeStore();
    let calls = 0;
    const embed = async (): Promise<number[]> => { calls += 1; return [1, 0, 0]; };
    const r1 = new CatalogRetriever(tinyCatalog, embed, store);
    await r1.retrieve('qualunque cosa', { k: 3 });
    expect(calls).toBeGreaterThan(0);
    const callsAfterWarmup = calls;
    // Nuovo processo simulato: nuovo retriever, stesso store persistente.
    const r2 = new CatalogRetriever(tinyCatalog, embed, store);
    await r2.retrieve('altra query', { k: 3 });
    // L'unica chiamata in più è l'embedding della QUERY (1), MAI del catalogo.
    expect(calls - callsAfterWarmup).toBeLessThanOrEqual(1);
  });

  it('🚨 embedder GIÙ → retry dopo TTL, non "mai più" (pre-fix: spento fino al restart)', async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      let catalogEmbeds = 0;
      const embed = async (): Promise<number[] | null> => {
        if (!up) return null;
        catalogEmbeds += 1;
        return [0, 1, 0];
      };
      const r = new CatalogRetriever(tinyCatalog, embed, fakeStore());
      await r.retrieve('query uno', { k: 3 });
      expect(catalogEmbeds).toBe(0); // embedder giù: nessun vettore
      up = true;
      // PRIMA del TTL: ancora in backoff, nessun tentativo.
      await r.retrieve('query due', { k: 3 });
      expect(catalogEmbeds).toBe(0);
      // DOPO il TTL: riprova e il semantico torna vivo.
      vi.advanceTimersByTime(11 * 60_000);
      await r.retrieve('query tre', { k: 3 });
      expect(catalogEmbeds).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('embed dei mancanti in PARALLELO (in-flight > 1 osservato)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const embed = async (): Promise<number[]> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => { setTimeout(res, 5); });
      inFlight -= 1;
      return [1, 1, 0];
    };
    const r = new CatalogRetriever(tinyCatalog, embed, fakeStore());
    await r.retrieve('query', { k: 3 });
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('embedText include la sezione "Use case:" della description (segnale semantico ricco)', () => {
    const idx = buildCatalogIndex(buildNodeCatalog());
    const runJs = idx.find((r) => r.defId === 'action_run_js');
    expect(runJs).toBeDefined();
    expect(runJs!.embedText.toLowerCase()).toContain('use case:');
    // Il lessicale resta sul testo stretto: searchText NON ingloba l'use case.
    expect(runJs!.searchText.length).toBeLessThan(runJs!.embedText.length);
  });
});

describe('CatalogRetriever — semantico + fusione', () => {
  const catalog = buildNodeCatalog();

  it('con embedder attivo: il semantico contribuisce (vettori catalogo lazy-embeddati)', async () => {
    const embed = vi.fn(fakeEmbedder());
    const r = new CatalogRetriever(catalog, embed);
    const top = await r.retrieve('invia messaggio email', { k: 10 });
    expect(top.length).toBeGreaterThan(0);
    // l'embedder è stato chiamato per i vettori del catalogo + la query
    expect(embed.mock.calls.length).toBeGreaterThan(catalog.length); // catalog + query
  });

  it('i vettori del catalogo si embeddano UNA volta sola (cache lazy)', async () => {
    const embed = vi.fn(fakeEmbedder());
    const r = new CatalogRetriever(catalog, embed);
    await r.retrieve('email', { k: 5 });
    const afterFirst = embed.mock.calls.length;
    await r.retrieve('database', { k: 5 });
    // seconda query: solo +1 chiamata (la query), NON ri-embedda il catalogo
    expect(embed.mock.calls.length).toBe(afterFirst + 1);
  });

  it('cosine: identici=1, ortogonali=0', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('🔒 la FUSIONE semantica conta: un nodo SENZA match lessicale ma alta cosine appare', async () => {
    // Mini-catalogo controllato: conosco i testi esatti, quindi posso pilotare
    // l'embedder per defId. La query "gamma" non ha NESSUN termine in comune con
    // i nodi → solo il semantico può far emergere il target.
    const mini = [
      { defId: 'action_alpha', type: 'action', label: 'Alpha', description: 'gestisce alpha.', fields: [] },
      { defId: 'action_beta', type: 'action', label: 'Beta', description: 'gestisce beta.', fields: [] },
      { defId: 'action_delta', type: 'action', label: 'Delta', description: 'gestisce delta.', fields: [] },
    ];
    // Diamo lo STESSO vettore alla query e al searchText di "beta" (contiene 'beta').
    const pilot = async (text: string): Promise<number[]> =>
      (text.includes('gamma') || text.toLowerCase().includes('beta')) ? [1, 0, 0] : [0, 1, 0];
    const r = new CatalogRetriever(mini, pilot);
    const fused = await r.retrieve('gamma', { k: 3 });
    expect(fused.some((n) => n.defId === 'action_beta'), 'la fusione semantica deve far emergere beta').toBe(true);
    const lex = await r.retrieve('gamma', { k: 3, lexicalOnly: true });
    expect(lex.some((n) => n.defId === 'action_beta'), 'lessicale puro: gamma non matcha beta').toBe(false);
  });
});

describe('🔒 formatCatalogForPrompt — OUTPUT CONTRACT grounding (B: anti-allucinazione Liara)', () => {
  const entries: NodeCatalogEntry[] = [
    {
      defId: 'action_demo_contract', type: 'action', label: 'Demo Contract', description: 'fa una demo.', fields: [],
      outputContract: {
        fields: [
          { name: 'partnerId', type: 'number | null', desc: 'id del partner; NULL se non trovato e !createIfMissing' },
          { name: 'found', type: 'boolean', desc: 'true se il partner esiste' },
        ],
        notes: 'Miss + createIfMissing=false → partnerId null (NON 0).',
      },
    },
    { defId: 'action_no_contract', type: 'action', label: 'Plain', description: 'senza contract.', fields: [] },
  ];
  const retriever = new CatalogRetriever(entries, nullEmbedder);

  it('il blocco CONTRATTI DI OUTPUT espone i campi REALI + edge-case del nodo', async () => {
    const retrieved = await retriever.retrieve('demo', { inUseDefIds: ['action_demo_contract'] });
    const prompt = formatCatalogForPrompt(retriever, retrieved);
    expect(prompt).toContain('CONTRATTI DI OUTPUT');
    expect(prompt).toContain('action_demo_contract:');
    expect(prompt).toContain('partnerId: number | null');
    expect(prompt).toContain('NULL se non trovato');
    expect(prompt).toContain('Miss + createIfMissing=false → partnerId null (NON 0).');
  });

  it('🚨 ANTI-ALLUCINAZIONE: il prompt istruisce a NON dedurre output non documentati', async () => {
    const retrieved = await retriever.retrieve('demo', { inUseDefIds: ['action_demo_contract'] });
    const prompt = formatCatalogForPrompt(retriever, retrieved);
    expect(prompt.toLowerCase()).toContain('non inventare');
  });

  it('🚨 MUTATION: il contract attraversa entry→record→retrieved INTATTO', async () => {
    const retrieved = await retriever.retrieve('demo', { inUseDefIds: ['action_demo_contract'] });
    const node = retrieved.find((n) => n.defId === 'action_demo_contract');
    expect(node?.outputContract?.fields.map((f) => f.name)).toEqual(['partnerId', 'found']);
  });

  it('🚨 nodo SENZA outputContract → niente blocco contratti (no rumore/falsi)', async () => {
    const retrieved = await retriever.retrieve('plain', { inUseDefIds: ['action_no_contract'] });
    const onlyPlain = retrieved.every((n) => !n.outputContract);
    const prompt = formatCatalogForPrompt(retriever, retrieved);
    if (onlyPlain) expect(prompt).not.toContain('CONTRATTI DI OUTPUT');
  });
});
