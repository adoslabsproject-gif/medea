/**
 * pgvector-backed implementation of IVectorAdapter.
 *
 * Backend Postgres + estensione `vector` (pgvector). Stessa semantica di
 * EmbeddedVectorAdapter (validazione dimensioni, distanze cosine/euclidean/dot,
 * filtro payload, topK, minScore) ma su KNN nativo pgvector (`<=>`, `<->`, `<#>`).
 *
 * Driver-agnostic: riceve un `SqlExecutor` minimale (compatibile con `pg`
 * Client/Pool) → testabile contro Postgres reale e wirabile in prod senza
 * accoppiarsi a uno specifico client.
 *
 * Le collection convivono in UN'unica coppia di tabelle (`vs_collections` +
 * `vs_records`) con colonna `embedding vector` non-dimensionata: collection
 * diverse possono avere dimensioni diverse; la dimensione per-collection è
 * validata a livello applicativo (come l'embedded).
 */
import type {
  IVectorAdapter,
  VectorRecord,
  SimilaritySearchQuery,
  SimilaritySearchResult,
  CollectionInfo,
} from './types.js';

/** Esecutore SQL minimale compatibile con `pg` (Client | Pool). */
export interface SqlExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

type Distance = 'cosine' | 'euclidean' | 'dot';

interface CollectionMeta {
  dimensions: number;
  distance: Distance;
}

/** Operatore di distanza pgvector + come trasformarlo in "score" (più alto = migliore). */
const DISTANCE_OP: Record<Distance, string> = {
  cosine: '<=>', // cosine distance ∈ [0,2] → score = 1 - dist
  euclidean: '<->', // L2 distance ≥ 0 → score = -dist
  dot: '<#>', // negative inner product → score = -(<#>) = inner product
};

function vectorLiteral(vec: readonly number[]): string {
  return '[' + vec.join(',') + ']';
}

export class PgVectorAdapter implements IVectorAdapter {
  readonly engine = 'pgvector' as const;
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {}

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.sql.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.sql.query(`
      CREATE TABLE IF NOT EXISTS vs_collections (
        name text PRIMARY KEY,
        dimensions integer NOT NULL CHECK (dimensions > 0),
        distance text NOT NULL CHECK (distance IN ('cosine','euclidean','dot')),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await this.sql.query(`
      CREATE TABLE IF NOT EXISTS vs_records (
        collection text NOT NULL REFERENCES vs_collections(name) ON DELETE CASCADE,
        id text NOT NULL,
        embedding vector NOT NULL,
        payload jsonb,
        PRIMARY KEY (collection, id)
      )`);
    await this.sql.query(
      'CREATE INDEX IF NOT EXISTS vs_records_collection_idx ON vs_records(collection)',
    );
    // ⚠️ SCALA (trade-off consapevole): nessun indice ANN (hnsw/ivfflat). La KNN
    // fa seq-scan + sort sulla distanza → O(n) per query. È una conseguenza del
    // design "colonna embedding vector NON-dimensionata" (collection di dimensioni
    // diverse nella stessa tabella): hnsw/ivfflat richiedono dimensione FISSA, quindi
    // un singolo indice ANN non è possibile qui. OK per corpora piccoli/medi
    // (per-tenant RAG, ~10⁴-10⁵ vettori). Per corpora grandi → rework: tabella +
    // indice ANN PER-dimensione (es. vs_records_d1536 vector(1536) USING hnsw).
    this.initialized = true;
  }

  private async getMeta(collection: string): Promise<CollectionMeta | null> {
    const { rows } = await this.sql.query(
      'SELECT dimensions, distance FROM vs_collections WHERE name = $1',
      [collection],
    );
    const row = rows[0];
    if (!row) return null;
    return { dimensions: Number(row.dimensions), distance: row.distance as Distance };
  }

  async ensureCollection(name: string, dimensions: number, distance: Distance): Promise<void> {
    await this.init();
    await this.sql.query(
      'INSERT INTO vs_collections (name, dimensions, distance) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
      [name, dimensions, distance],
    );
  }

  async upsert(collection: string, records: readonly VectorRecord[]): Promise<{ count: number }> {
    await this.init();
    const meta = await this.getMeta(collection);
    if (!meta) {
      throw new Error(
        `Vector collection "${collection}" does not exist. Call ensureCollection() first.`,
      );
    }
    if (records.length === 0) return { count: 0 };
    // Valida TUTTE le dimensioni prima di scrivere (fail-fast).
    for (const r of records) {
      if (r.vector.length !== meta.dimensions) {
        throw new Error(
          `Vector dimensions mismatch: collection ${collection} expects ${meta.dimensions}, got ${r.vector.length}`,
        );
      }
    }
    // UNA sola INSERT multi-row → ATOMICA per definizione (1 statement: o tutti i
    // record o nessuno, niente scritture parziali) + 1 round-trip (no N+1). Vale
    // anche se SqlExecutor è un Pool (BEGIN/COMMIT su query() separate finirebbero
    // su connessioni diverse — qui non serve). Parità col gemello embedded (txn).
    const values: unknown[] = [];
    const tuples: string[] = [];
    let i = 1;
    for (const r of records) {
      tuples.push(`($${i++}, $${i++}, $${i++}::vector, $${i++}::jsonb)`);
      values.push(
        collection,
        r.id,
        vectorLiteral(r.vector),
        r.payload ? JSON.stringify(r.payload) : null,
      );
    }
    await this.sql.query(
      `INSERT INTO vs_records (collection, id, embedding, payload)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (collection, id) DO UPDATE SET embedding = excluded.embedding, payload = excluded.payload`,
      values,
    );
    return { count: records.length };
  }

  async search(
    collection: string,
    query: SimilaritySearchQuery,
  ): Promise<SimilaritySearchResult[]> {
    await this.init();
    const meta = await this.getMeta(collection);
    if (!meta) throw new Error(`Vector collection "${collection}" not found`);
    if (query.vector.length !== meta.dimensions) {
      throw new Error(
        `Query vector dimensions mismatch: expected ${meta.dimensions}, got ${query.vector.length}`,
      );
    }
    const op = DISTANCE_OP[meta.distance];
    const lit = vectorLiteral(query.vector);
    const params: unknown[] = [collection, lit];
    let where = 'WHERE collection = $1';
    if (query.filter && Object.keys(query.filter).length > 0) {
      params.push(JSON.stringify(query.filter));
      where += ` AND payload @> $${params.length}::jsonb`;
    }

    // score: cosine → 1-dist ; euclidean → -dist ; dot → -dist (= inner product)
    const scoreExpr =
      meta.distance === 'cosine'
        ? `1 - (embedding ${op} $2::vector)`
        : `-(embedding ${op} $2::vector)`;

    // minScore applicato in SQL PRIMA del LIMIT (semantica corretta: filtra poi
    // tronca a topK, come il gemello embedded — non topK-poi-filtra che ne
    // ritornerebbe meno del disponibile sopra-soglia).
    if (query.minScore !== undefined) {
      params.push(query.minScore);
      where += ` AND (${scoreExpr}) >= $${params.length}`;
    }
    const topK = query.topK ?? 10;
    params.push(topK);
    const limitIdx = params.length;

    // NB: NON si seleziona embedding — rispedire il vettore completo (es. 1536 float)
    // per ogni risultato + JSON.parse è lavoro sprecato sulla hot path (i consumer
    // RAG non lo usano). `vector` resta opzionale nell'interfaccia.
    const { rows } = await this.sql.query(
      `SELECT id, payload, ${scoreExpr} AS score
       FROM vs_records ${where}
       ORDER BY embedding ${op} $2::vector ASC
       LIMIT $${limitIdx}`,
      params,
    );

    return rows.map((r) => {
      const out: SimilaritySearchResult = { id: String(r.id), score: Number(r.score) };
      if (r.payload) {
        out.payload = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
          string,
          unknown
        >;
      }
      return out;
    });
  }

  async deleteByIds(collection: string, ids: readonly string[]): Promise<{ count: number }> {
    await this.init();
    if (ids.length === 0) return { count: 0 };
    const { rows } = await this.sql.query(
      'DELETE FROM vs_records WHERE collection = $1 AND id = ANY($2::text[]) RETURNING id',
      [collection, [...ids]],
    );
    return { count: rows.length };
  }

  async countCollection(name: string): Promise<number> {
    await this.init();
    const { rows } = await this.sql.query(
      'SELECT COUNT(*)::int AS c FROM vs_records WHERE collection = $1',
      [name],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async existsById(collection: string, id: string): Promise<boolean> {
    await this.init();
    const { rows } = await this.sql.query(
      'SELECT 1 FROM vs_records WHERE collection = $1 AND id = $2 LIMIT 1',
      [collection, id],
    );
    return rows.length > 0;
  }

  async listCollections(): Promise<CollectionInfo[]> {
    await this.init();
    const { rows } = await this.sql.query(`
      SELECT c.name, c.dimensions, c.distance, COUNT(r.id)::int AS count
      FROM vs_collections c
      LEFT JOIN vs_records r ON r.collection = c.name
      GROUP BY c.name, c.dimensions, c.distance
      ORDER BY c.name`);
    return rows.map((r) => ({
      name: String(r.name),
      dimensions: Number(r.dimensions),
      distance: r.distance as Distance,
      count: Number(r.count),
    }));
  }

  async dropCollection(name: string): Promise<void> {
    await this.init();
    await this.sql.query('DELETE FROM vs_collections WHERE name = $1', [name]); // cascade → records
  }
}
