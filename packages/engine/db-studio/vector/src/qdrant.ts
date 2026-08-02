/**
 * Qdrant HTTP adapter. https://qdrant.tech/documentation/concepts/
 * Supports cloud and self-hosted via baseUrl + optional apiKey.
 */

import type {
  IVectorAdapter,
  VectorRecord,
  SimilaritySearchQuery,
  SimilaritySearchResult,
} from './types.js';

export interface QdrantConfig {
  baseUrl: string;
  apiKey?: string;
}

export class QdrantVectorAdapter implements IVectorAdapter {
  readonly engine = 'qdrant' as const;

  constructor(private readonly config: QdrantConfig) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) h['api-key'] = this.config.apiKey;
    return h;
  }

  async ensureCollection(
    name: string,
    dimensions: number,
    distance: 'cosine' | 'euclidean' | 'dot',
  ): Promise<void> {
    const head = await fetch(`${this.config.baseUrl}/collections/${encodeURIComponent(name)}`, {
      headers: this.headers(),

      signal: AbortSignal.timeout(30_000),
    });
    if (head.ok) return;
    const distMap = { cosine: 'Cosine', euclidean: 'Euclid', dot: 'Dot' } as const;
    const res = await fetch(`${this.config.baseUrl}/collections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ vectors: { size: dimensions, distance: distMap[distance] } }),

      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(
        `Qdrant create collection ${String(res.status)}: ${(await res.text()).slice(0, 300)}`,
      );
  }

  async upsert(collection: string, records: readonly VectorRecord[]): Promise<{ count: number }> {
    const res = await fetch(
      `${this.config.baseUrl}/collections/${encodeURIComponent(collection)}/points?wait=true`,
      {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          points: records.map((r) => ({ id: r.id, vector: r.vector, payload: r.payload ?? {} })),

          signal: AbortSignal.timeout(30_000),
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Qdrant upsert ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
    return { count: records.length };
  }

  async search(
    collection: string,
    query: SimilaritySearchQuery,
  ): Promise<SimilaritySearchResult[]> {
    const body: Record<string, unknown> = {
      vector: query.vector,
      limit: query.topK ?? 10,
      with_payload: true,
      with_vector: false,
    };
    if (query.filter) {
      body.filter = {
        must: Object.entries(query.filter).map(([k, v]) => ({ key: k, match: { value: v } })),
      };
    }
    if (query.minScore !== undefined) body.score_threshold = query.minScore;
    const res = await fetch(
      `${this.config.baseUrl}/collections/${encodeURIComponent(collection)}/points/search`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),

        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok)
      throw new Error(`Qdrant search ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      result: { id: string | number; score: number; payload?: Record<string, unknown> }[];
    };
    return json.result.map((r) => ({
      id: String(r.id),
      score: r.score,
      ...(r.payload ? { payload: r.payload } : {}),
    }));
  }

  async deleteByIds(collection: string, ids: readonly string[]): Promise<{ count: number }> {
    const res = await fetch(
      `${this.config.baseUrl}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ points: ids }),

        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok)
      throw new Error(`Qdrant delete ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
    return { count: ids.length };
  }

  async countCollection(name: string): Promise<number> {
    const res = await fetch(`${this.config.baseUrl}/collections/${encodeURIComponent(name)}`, {
      headers: this.headers(),

      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(`Qdrant count ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      result?: { points_count?: number; vectors_count?: number };
    };
    return json.result?.points_count ?? json.result?.vectors_count ?? 0;
  }

  async listCollections(): Promise<
    { name: string; dimensions: number; distance: 'cosine' | 'euclidean' | 'dot'; count: number }[]
  > {
    const res = await fetch(`${this.config.baseUrl}/collections`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Qdrant listCollections ${String(res.status)}`);
    const body = (await res.json()) as { result?: { collections?: { name: string }[] } };
    const collections = body.result?.collections ?? [];
    const out = await Promise.all(
      collections.map(async (c) => {
        const info = (await fetch(
          `${this.config.baseUrl}/collections/${encodeURIComponent(c.name)}`,
          {
            headers: this.headers(),

            signal: AbortSignal.timeout(30_000),
          },
        ).then((r) => r.json())) as {
          result?: {
            config?: { params?: { vectors?: { size?: number; distance?: string } } };
            points_count?: number;
          };
        };
        const params = info.result?.config?.params?.vectors;
        const dist = (params?.distance ?? 'Cosine').toLowerCase();
        // const tipizzato col union → niente widening a `string` nel contesto oggetto, niente cast.
        const distance: 'cosine' | 'euclidean' | 'dot' =
          dist === 'euclid' ? 'euclidean' : dist === 'dot' ? 'dot' : 'cosine';
        return {
          name: c.name,
          dimensions: params?.size ?? 0,
          distance,
          count: info.result?.points_count ?? 0,
        };
      }),
    );
    return out;
  }

  async dropCollection(name: string): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/collections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.headers(),

      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`Qdrant drop ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
  }
}
