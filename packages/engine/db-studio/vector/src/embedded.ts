/**
 * Embedded vector store backed by SQLite. Brute-force scan with in-memory
 * cosine/euclidean/dot similarity. Suitable up to ~100k vectors on a single
 * machine; beyond that, switch to QdrantVectorAdapter (HTTP backend).
 *
 * Why no HNSW: keeps deps minimal (no native compile beyond better-sqlite3
 * which is already present). For the 95% workflow-automation use case
 * (RAG over a small knowledge base) this is more than enough.
 */

import SqliteDatabase, { type Database as BetterSqlite3Db } from 'better-sqlite3';
import type {
  IVectorAdapter,
  VectorRecord,
  SimilaritySearchQuery,
  SimilaritySearchResult,
} from './types.js';

interface CollectionRow {
  name: string;
  dimensions: number;
  distance: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function euclideanDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

export class EmbeddedVectorAdapter implements IVectorAdapter {
  readonly engine = 'vector-embedded' as const;
  private db: BetterSqlite3Db | null = null;

  constructor(private readonly path: string) {}

  connect(): void {
    const db = new SqliteDatabase(this.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_collections (
        name TEXT PRIMARY KEY,
        dimensions INTEGER NOT NULL,
        distance TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS vector_records (
        id TEXT NOT NULL,
        collection TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (collection, id),
        FOREIGN KEY (collection) REFERENCES vector_collections(name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS vector_records_collection_idx ON vector_records(collection);
    `);
    this.db = db;
  }

  private get conn(): BetterSqlite3Db {
    if (!this.db) this.connect();
    return this.db!;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  ensureCollection(
    name: string,
    dimensions: number,
    distance: 'cosine' | 'euclidean' | 'dot',
  ): Promise<void> {
    this.conn
      .prepare(
        'INSERT INTO vector_collections (name, dimensions, distance) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING',
      )
      .run(name, dimensions, distance);
    return Promise.resolve();
  }

  upsert(collection: string, records: readonly VectorRecord[]): Promise<{ count: number }> {
    const meta = this.conn
      .prepare('SELECT * FROM vector_collections WHERE name = ?')
      .get(collection) as CollectionRow | undefined;
    if (!meta) {
      return Promise.reject(
        new Error(
          `Vector collection "${collection}" does not exist. Call ensureCollection() first.`,
        ),
      );
    }
    // Validate ALL vectors before opening the transaction so we surface the
    // first dimension mismatch as a proper rejected promise (better-sqlite3's
    // transaction wraps sync throws into the caller's exception chain).
    for (const row of records) {
      if (row.vector.length !== meta.dimensions) {
        return Promise.reject(
          new Error(
            `Vector dimensions mismatch: collection ${collection} expects ${meta.dimensions.toString()}, got ${row.vector.length.toString()}`,
          ),
        );
      }
    }

    const stmt = this.conn.prepare(
      'INSERT INTO vector_records (id, collection, vector_json, payload_json) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (collection, id) DO UPDATE SET vector_json = excluded.vector_json, payload_json = excluded.payload_json',
    );
    const txn = this.conn.transaction((rows: readonly VectorRecord[]) => {
      for (const row of rows) {
        stmt.run(
          row.id,
          collection,
          JSON.stringify(row.vector),
          row.payload ? JSON.stringify(row.payload) : null,
        );
      }
    });
    txn(records);
    return Promise.resolve({ count: records.length });
  }

  search(collection: string, query: SimilaritySearchQuery): Promise<SimilaritySearchResult[]> {
    const meta = this.conn
      .prepare('SELECT * FROM vector_collections WHERE name = ?')
      .get(collection) as CollectionRow | undefined;
    if (!meta) throw new Error(`Vector collection "${collection}" not found`);
    if (query.vector.length !== meta.dimensions) {
      throw new Error(
        `Query vector dimensions mismatch: expected ${meta.dimensions.toString()}, got ${query.vector.length.toString()}`,
      );
    }
    const rows = this.conn
      .prepare('SELECT id, vector_json, payload_json FROM vector_records WHERE collection = ?')
      .all(collection) as { id: string; vector_json: string; payload_json: string | null }[];

    const scorer =
      meta.distance === 'cosine' ? cosine : meta.distance === 'euclidean' ? euclideanDist : dot;
    const scored: SimilaritySearchResult[] = rows.map((r) => {
      const v = JSON.parse(r.vector_json) as number[];
      let score = scorer(query.vector, v);
      if (meta.distance === 'euclidean') score = -score;
      const result: SimilaritySearchResult = { id: r.id, score, vector: v };
      if (r.payload_json) {
        result.payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      }
      return result;
    });

    let filtered = scored;
    if (query.filter) {
      filtered = scored.filter((r) => {
        if (!r.payload) return false;
        for (const [k, v] of Object.entries(query.filter ?? {})) {
          if (r.payload[k] !== v) return false;
        }
        return true;
      });
    }
    if (query.minScore !== undefined) {
      filtered = filtered.filter((r) => r.score >= (query.minScore ?? -Infinity));
    }

    filtered.sort((a, b) => b.score - a.score);
    const topK = query.topK ?? 10;
    return Promise.resolve(filtered.slice(0, topK));
  }

  deleteByIds(collection: string, ids: readonly string[]): Promise<{ count: number }> {
    const stmt = this.conn.prepare('DELETE FROM vector_records WHERE collection = ? AND id = ?');
    const txn = this.conn.transaction((arr: readonly string[]) => {
      let count = 0;
      for (const id of arr) {
        const info = stmt.run(collection, id);
        count += info.changes;
      }
      return count;
    });
    return Promise.resolve({ count: txn(ids) });
  }

  countCollection(name: string): Promise<number> {
    const row = this.conn
      .prepare('SELECT COUNT(*) as c FROM vector_records WHERE collection = ?')
      .get(name) as { c: number };
    return Promise.resolve(row.c);
  }

  existsById(collection: string, id: string): Promise<boolean> {
    const row = this.conn
      .prepare('SELECT 1 FROM vector_records WHERE collection = ? AND id = ? LIMIT 1')
      .get(collection, id);
    return Promise.resolve(row !== undefined);
  }

  listCollections(): Promise<
    { name: string; dimensions: number; distance: 'cosine' | 'euclidean' | 'dot'; count: number }[]
  > {
    const rows = this.conn
      .prepare('SELECT name, dimensions, distance FROM vector_collections ORDER BY name')
      .all() as { name: string; dimensions: number; distance: 'cosine' | 'euclidean' | 'dot' }[];
    const counts = this.conn
      .prepare('SELECT collection, COUNT(*) as c FROM vector_records GROUP BY collection')
      .all() as { collection: string; c: number }[];
    const countMap = new Map(counts.map((r) => [r.collection, r.c]));
    return Promise.resolve(
      rows.map((r) => ({
        name: r.name,
        dimensions: r.dimensions,
        distance: r.distance,
        count: countMap.get(r.name) ?? 0,
      })),
    );
  }

  dropCollection(name: string): Promise<void> {
    this.conn.prepare('DELETE FROM vector_collections WHERE name = ?').run(name);
    return Promise.resolve();
  }
}
