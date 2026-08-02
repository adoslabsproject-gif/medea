import { z } from 'zod';

export const VectorRecordSchema = z.object({
  id: z.string().min(1),
  vector: z.array(z.number()),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type VectorRecord = z.infer<typeof VectorRecordSchema>;

export interface SimilaritySearchQuery {
  vector: number[];
  topK?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
}

export interface SimilaritySearchResult {
  id: string;
  score: number;
  vector?: number[];
  payload?: Record<string, unknown>;
}

export interface CollectionInfo {
  name: string;
  dimensions: number;
  distance: 'cosine' | 'euclidean' | 'dot';
  count: number;
}

export interface IVectorAdapter {
  readonly engine: 'vector-embedded' | 'qdrant' | 'pgvector';
  ensureCollection(
    name: string,
    dimensions: number,
    distance: 'cosine' | 'euclidean' | 'dot',
  ): Promise<void>;
  listCollections(): Promise<CollectionInfo[]>;
  upsert(collection: string, records: readonly VectorRecord[]): Promise<{ count: number }>;
  search(collection: string, query: SimilaritySearchQuery): Promise<SimilaritySearchResult[]>;
  deleteByIds(collection: string, ids: readonly string[]): Promise<{ count: number }>;
  countCollection(name: string): Promise<number>;
  dropCollection(name: string): Promise<void>;
  /**
   * True se un record con questo id esiste già nella collection. Opzionale: usato
   * dalla quota per non addebitare un re-ingest idempotente (id deterministico →
   * upsert UPDATE = 0 vettori netti). Adapter che non lo implementano → la quota
   * assume net-add conservativo (+1).
   */
  existsById?(collection: string, id: string): Promise<boolean>;
}
