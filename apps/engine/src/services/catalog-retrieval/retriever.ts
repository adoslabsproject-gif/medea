/**
 * Catalog retriever IBRIDO — lessicale + semantico, con fusione.
 *
 * Stato dell'arte 2026 (hybrid retrieval): due segnali indipendenti fusi via
 * Reciprocal Rank Fusion (RRF). Ognuno copre il punto cieco dell'altro:
 *   • LESSICALE (BM25-ish, sempre-on, deterministico, zero dipendenze): becca
 *     i match esatti di termine ("slack" → community_slack). È il GARANTE:
 *     funziona anche se l'embedder è giù, ed è testabile al 100% senza rete.
 *   • SEMANTICO (BGE-M3 via generateEmbedding, vettori catalogo lazy-cached):
 *     becca la similarità CONCETTUALE ("avvisa il team" → slack/telegram/email
 *     senza che la parola compaia). Degrada con grazia: se l'embedder è giù
 *     (CB aperto, no license key) → generateEmbedding ritorna null → il
 *     semantico si spegne e resta il lessicale. MAI un crash, MAI un buco.
 *
 * Risolve il problema "il catalogo non sta nel prompt": invece dei 100k token
 * di catalogo completo, il modello riceve la mappa categorie (~200 token) + i
 * top-k nodi rilevanti per la richiesta. Liara ha accesso a TUTTI i nodi, ma
 * caricati on-demand — il pattern "leggi, scegli, dimentica" dell'owner.
 *
 * @module services/catalog-retrieval/retriever
 */

import { createHash } from 'node:crypto';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { logger } from '@/lib/logger.js';
import {
  buildCatalogIndex, groupByCategory, tokenize,
  type CatalogRecord,
} from './index-builder.js';
import { CATEGORY_LABELS, type CatalogCategory } from './category.js';
import type { OutputContract } from '@medea/engine-core-schema';

export interface RetrievedNode {
  defId: string;
  type: string;
  label: string;
  category: CatalogCategory;
  shortDesc: string;
  /** Contratto di output (cosa ritorna + edge-case) — grounding per l'analisi AI. */
  outputContract?: OutputContract;
  /** Punteggio di rilevanza fuso (più alto = più pertinente). Per debug/test. */
  score: number;
}

export interface RetrieveOptions {
  /** Quanti nodi restituire. Default 18. */
  k?: number;
  /** defId già nel workflow corrente: garantiti in cima (il modello li vede). */
  inUseDefIds?: readonly string[];
  /** Forza il solo lessicale (test deterministici / embedder noto-giù). */
  lexicalOnly?: boolean;
}

type Embedder = (text: string) => Promise<number[] | null>;

/**
 * Port dello store di vettori persistente (content-addressed). L'adapter
 * SQLite vive in embedding-store.ts; nei test si inietta un Map-backed fake.
 * Assente → comportamento storico (vettori solo in RAM per processo).
 */
export interface IEmbeddingVectorStore {
  get(hash: string): number[] | null;
  put(hash: string, vector: number[]): void;
}

const RRF_K = 60; // costante standard RRF
const DEFAULT_K = 18;
/** Embed paralleli al warm-up (il gateway BGE-M3 regge bene 8 in-flight). */
const EMBED_CONCURRENCY = 8;
/** Dopo un warm-up fallito, ritenta non prima di questo TTL (mai "mai più"). */
const EMBED_RETRY_TTL_MS = 10 * 60_000;

export class CatalogRetriever {
  private readonly records: CatalogRecord[];
  private readonly byDefId: Map<string, CatalogRecord>;
  /** IDF per termine, calcolata una volta dal corpus. */
  private readonly idf: Map<string, number>;
  private readonly docTokens: Map<string, Set<string>>;
  /** Vettori del catalogo: lazy (store persistente + embed dei mancanti). */
  private vectors: Map<string, number[]> | null = null;
  /** Backoff dopo un warm-up fallito/parziale: epoch ms del prossimo tentativo. */
  private nextEmbedRetryAt = 0;
  private readonly embed: Embedder;
  private readonly vectorStore: IEmbeddingVectorStore | undefined;
  private readonly hashOf: (text: string) => string;

  constructor(
    entries: readonly NodeCatalogEntry[],
    embed: Embedder,
    vectorStore?: IEmbeddingVectorStore,
    hashOf: (text: string) => string = defaultHash,
  ) {
    this.records = buildCatalogIndex(entries);
    this.byDefId = new Map(this.records.map((r) => [r.defId, r]));
    this.embed = embed;
    this.vectorStore = vectorStore;
    this.hashOf = hashOf;
    // Precompute token-set + IDF per il lessicale.
    this.docTokens = new Map();
    const df = new Map<string, number>();
    for (const r of this.records) {
      const toks = new Set([...r.keywords, ...tokenize(r.searchText)]);
      this.docTokens.set(r.defId, toks);
      for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = this.records.length;
    this.idf = new Map();
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + n / d));
  }

  /** Tutti i defId indicizzati — usato dal test di copertura anti-drift. */
  defIds(): string[] { return this.records.map((r) => r.defId); }

  /** Spec compatta di un nodo (per getNodeDetails on-demand). */
  getRecord(defId: string): CatalogRecord | undefined { return this.byDefId.get(defId); }

  /** Mappa categorie human-readable + conteggio — sempre nel prompt (~200 token). */
  categoryMap(): { category: CatalogCategory; label: string; count: number }[] {
    const grouped = groupByCategory(this.records);
    const order = Object.keys(CATEGORY_LABELS) as CatalogCategory[];
    return order
      .filter((c) => grouped.has(c))
      .map((c) => ({ category: c, label: CATEGORY_LABELS[c], count: grouped.get(c)!.length }));
  }

  /** Tutti i nodi di una categoria (per browse). */
  nodesInCategory(category: CatalogCategory): CatalogRecord[] {
    return this.records.filter((r) => r.category === category);
  }

  // ── Lessicale: score TF-IDF-ish query↔doc ──────────────────────────────
  private lexicalRanking(query: string): { defId: string; score: number }[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);
    const scored: { defId: string; score: number }[] = [];
    for (const r of this.records) {
      const docToks = this.docTokens.get(r.defId)!;
      let score = 0;
      for (const t of qSet) {
        if (docToks.has(t)) score += this.idf.get(t) ?? 0;
      }
      // Boost forte se un termine query è proprio nell'id/label del nodo
      // (match diretto: "slack" → community_slack vince).
      for (const t of qSet) {
        if (r.defId.includes(t) || r.label.toLowerCase().includes(t)) score += 1.5;
      }
      if (score > 0) scored.push({ defId: r.defId, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // ── Semantico: cosine query↔vettori catalogo (store persistente + lazy) ──
  private async ensureVectors(): Promise<Map<string, number[]> | null> {
    if (this.vectors) return this.vectors;
    if (Date.now() < this.nextEmbedRetryAt) return null; // backoff post-fallimento
    const out = new Map<string, number[]>();
    // 1) Store persistente PRIMA: i vettori già calcolati (content-addressed
    //    su embedText) costano una SELECT, non una chiamata BGE-M3 — warm-up
    //    zero dopo il primo boot; re-embed SOLO dei nodi col testo cambiato.
    const missing: CatalogRecord[] = [];
    for (const r of this.records) {
      const cached = this.vectorStore?.get(this.hashOf(r.embedText));
      if (cached) out.set(r.defId, cached);
      else missing.push(r);
    }
    // 2) Embed dei mancanti in PARALLELO (pool, non più sequenziale).
    let failures = 0;
    await runPool(missing, EMBED_CONCURRENCY, async (r) => {
      const v = await this.embed(r.embedText);
      if (v && v.length > 0) {
        out.set(r.defId, v);
        this.vectorStore?.put(this.hashOf(r.embedText), v);
      } else {
        failures += 1;
      }
    });
    if (out.size === 0) {
      // Embedder giù: ritenta dopo il TTL (pre-fix: MAI più fino al restart).
      this.nextEmbedRetryAt = Date.now() + EMBED_RETRY_TTL_MS;
      logger.warn({ failures, retryInMs: EMBED_RETRY_TTL_MS }, '[catalog-retrieval] embedder non disponibile — solo lessicale, retry dopo TTL');
      return null;
    }
    if (failures > 0) {
      // Parziale: usa i vettori disponibili ORA, ma non congelare la cache —
      // al prossimo tentativo (post-TTL) i mancanti vengono ritentati, e i
      // riusciti arrivano gratis dallo store.
      this.nextEmbedRetryAt = Date.now() + EMBED_RETRY_TTL_MS;
      logger.warn({ embedded: out.size, failures }, '[catalog-retrieval] index semantico parziale — retry dei mancanti dopo TTL');
      return out;
    }
    this.vectors = out;
    return out;
  }

  private async semanticRanking(query: string): Promise<{ defId: string; score: number }[]> {
    const vectors = await this.ensureVectors();
    if (!vectors) return [];
    const qVec = await this.embed(query);
    if (!qVec || qVec.length === 0) return [];
    const scored: { defId: string; score: number }[] = [];
    for (const [defId, v] of vectors) {
      scored.push({ defId, score: cosine(qVec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Recupera i top-k nodi più rilevanti per `query`. Fonde lessicale +
   * semantico via RRF. I nodi `inUseDefIds` sono SEMPRE inclusi (il modello
   * deve vedere i nodi già nel workflow che sta modificando).
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedNode[]> {
    const k = opts.k ?? DEFAULT_K;
    const lexical = this.lexicalRanking(query);
    const semantic = opts.lexicalOnly ? [] : await this.semanticRanking(query);

    // Reciprocal Rank Fusion: score(d) = Σ 1/(RRF_K + rank_in_list(d)).
    const fused = new Map<string, number>();
    const addRanking = (ranking: { defId: string; score: number }[]): void => {
      ranking.forEach((item, i) => {
        fused.set(item.defId, (fused.get(item.defId) ?? 0) + 1 / (RRF_K + i + 1));
      });
    };
    addRanking(lexical);
    addRanking(semantic);

    const ranked = Array.from(fused.entries())
      .map(([defId, score]) => ({ defId, score }))
      .sort((a, b) => b.score - a.score);

    // I nodi in uso vanno in cima (dedup), poi i top fusi.
    const result: RetrievedNode[] = [];
    const seen = new Set<string>();
    const push = (defId: string, score: number): void => {
      if (seen.has(defId)) return;
      const r = this.byDefId.get(defId);
      if (!r) return;
      seen.add(defId);
      const node: RetrievedNode = { defId: r.defId, type: r.type, label: r.label, category: r.category, shortDesc: r.shortDesc, score };
      if (r.outputContract) node.outputContract = r.outputContract;
      result.push(node);
    };
    for (const defId of opts.inUseDefIds ?? []) push(defId, Infinity);
    for (const { defId, score } of ranked) {
      if (result.length >= k) break;
      push(defId, score);
    }
    return result;
  }
}

/** Hash di default (sha256 hex) — sostituibile nei test via costruttore. */
function defaultHash(text: string): string {
  // import lazy-free: node:crypto è sempre disponibile nel runtime.
  // (definito qui e non in embedding-store per non importare l'adapter)
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Esegue `fn` su ogni item con al più `limit` promise in volo. */
async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w += 1) {
    workers.push((async (): Promise<void> => {
      while (cursor < items.length) {
        const i = cursor;
        cursor += 1;
        const item = items[i];
        if (item !== undefined) await fn(item);
      }
    })());
  }
  await Promise.all(workers);
}

/** Cosine similarity. Vettori stessa dimensione (1024 BGE-M3). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
