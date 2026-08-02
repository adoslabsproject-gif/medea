/**
 * VectorService — wraps embedded-vector adapter or Qdrant per database.
 * Each Database with engine 'vector-embedded' or 'qdrant' becomes a vector
 * store discoverable via /api/v1/vector/:dbId/*.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { EmbeddedVectorAdapter, QdrantVectorAdapter, PgVectorAdapter, TenantScopedVectorStore, type IVectorAdapter, type SimilaritySearchQuery, type VectorRecord, type QdrantConfig } from '@medea/engine-db-studio-vector';
import type { Database } from '@medea/engine-db-studio-core';
import postgres from 'postgres';
import { DbStudioService } from './db-studio.service.js';
import { estimateVectorDiskMb } from './vector-quota.js';
import { loadConfig } from '@/config.js';

export class VectorService {
  private readonly adapters = new Map<string, IVectorAdapter>();
  private readonly dbStudio = new DbStudioService();

   
  private resolveAdapter(databaseId: string, tenantId: string): Promise<{ adapter: IVectorAdapter; database: Database }> {
    const database = this.dbStudio.get(databaseId, tenantId);
    if (!database) throw new Error(`Database ${databaseId} not found`);
    const engine = database.connection.engine;
    if (engine !== 'vector-embedded' && engine !== 'qdrant' && engine !== 'pgvector') {
      throw new Error(`Database ${databaseId} engine "${engine}" is not a vector engine`);
    }
    const cached = this.adapters.get(databaseId);
    if (cached) return Promise.resolve({ adapter: cached, database });

    let adapter: IVectorAdapter;
    if (engine === 'vector-embedded') {
      // Embedded SQLite nel container del tenant → isolamento FISICO per-file.
      const config = loadConfig();
      const dir = join(config.MEDEA_DATA_DIR, 'vector-stores');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(dir, `${databaseId}.sqlite`);
      const a = new EmbeddedVectorAdapter(path);
      a.connect();
      adapter = a;
    } else if (engine === 'pgvector') {
      // Postgres centrale (separato) condiviso → l'isolamento NON è fisico:
      // TenantScopedVectorStore namespacizza le collection per databaseId (già
      // tenant-owned da dbStudio.get) → impossibile leggere lo store di un altro.
      const url = database.connection.url ?? '';
      if (!url) throw new Error('pgvector adapter requires connection.url');
      const sql = postgres(url);
      type UnsafeParams = Parameters<typeof sql.unsafe>[1];
      const executor = {
        query: (text: string, params?: readonly unknown[]) =>
          sql.unsafe(text, (params ?? []) as unknown as UnsafeParams).then((rows) => ({
            rows: rows as unknown as Record<string, unknown>[],
          })),
      };
      adapter = new TenantScopedVectorStore(new PgVectorAdapter(executor), databaseId);
    } else {
      const baseUrl = database.connection.url ?? '';
      if (!baseUrl) throw new Error('Qdrant adapter requires connection.url');
      const cfg: QdrantConfig = { baseUrl };
      if (database.connection.passwordSecretRef) cfg.apiKey = database.connection.passwordSecretRef;
      adapter = new QdrantVectorAdapter(cfg);
    }
    this.adapters.set(databaseId, adapter);
    return Promise.resolve({ adapter, database });
  }

  async ensureCollection(databaseId: string, name: string, dimensions: number, distance: 'cosine' | 'euclidean' | 'dot', tenantId = 'default'): Promise<void> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    await adapter.ensureCollection(name, dimensions, distance);
  }

  async listCollections(databaseId: string, tenantId = 'default'): Promise<{ name: string; dimensions: number; distance: 'cosine' | 'euclidean' | 'dot'; count: number }[]> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    return adapter.listCollections();
  }

  async upsert(databaseId: string, collection: string, records: readonly VectorRecord[], tenantId = 'default'): Promise<{ count: number }> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    return adapter.upsert(collection, records);
  }

  async search(databaseId: string, collection: string, query: SimilaritySearchQuery, tenantId = 'default'): Promise<unknown> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    const results = await adapter.search(collection, query);
    return { results, count: results.length };
  }

  async count(databaseId: string, name: string, tenantId = 'default'): Promise<{ count: number }> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    return { count: await adapter.countCollection(name) };
  }

  /** True se il record esiste già (per la quota: re-ingest idempotente = 0 vettori netti). */
  async recordExists(databaseId: string, collection: string, id: string, tenantId = 'default'): Promise<boolean> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    return adapter.existsById ? adapter.existsById(collection, id) : false;
  }

  async deleteIds(databaseId: string, collection: string, ids: readonly string[], tenantId = 'default'): Promise<{ count: number }> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    return adapter.deleteByIds(collection, ids);
  }

  async dropCollection(databaseId: string, name: string, tenantId = 'default'): Promise<void> {
    const { adapter } = await this.resolveAdapter(databaseId, tenantId);
    await adapter.dropCollection(name);
  }

  /**
   * Uso vettoriale AGGREGATO del tenant su TUTTI i suoi vector DB (vincolo quota:
   * non per-database, altrimenti si aggira il limite creando N database).
   */
  async tenantVectorUsage(tenantId: string): Promise<{ totalVectors: number; diskMb: number }> {
    const dbs = await Promise.resolve(this.dbStudio.list(tenantId));
    let totalVectors = 0;
    let diskMb = 0;
    for (const d of dbs) {
      const eng = d.connection.engine;
      if (eng !== 'vector-embedded' && eng !== 'qdrant' && eng !== 'pgvector') continue;
      try {
        const cols = await this.listCollections(d.id, tenantId);
        for (const c of cols) {
          totalVectors += c.count;
          diskMb += estimateVectorDiskMb(c.count, c.dimensions);
        }
      } catch {
        // DB vettoriale irraggiungibile → non bloccare l'accounting (best-effort).
      }
    }
    return { totalVectors, diskMb };
  }
}
