/**
 * Embedding store persistente — adapter SQLite del port IEmbeddingVectorStore.
 *
 * Content-addressed: la chiave è sha256(embedText) → un vettore si ricalcola
 * SOLO quando il testo del nodo cambia (nuova versione del def, alias nuovi),
 * mai a ogni boot/processo. Prima di questo store il retriever ri-embeddava
 * l'intero catalogo (~190 chiamate BGE-M3, sequenziali) alla PRIMA query di
 * ogni processo: 10-20s di warm-up pagati dall'utente.
 *
 * Fail-soft totale: get/put non lanciano MAI (DB non pronto, riga corrotta →
 * null/no-op). Il retriever degrada a re-embed o a solo-lessicale: mai un
 * crash per colpa della cache.
 */
import { createHash } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import type { IEmbeddingVectorStore } from './retriever.js';

/** Hash content-addressed del testo embeddato. Esportato per i test. */
export function embedTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class SqliteEmbeddingStore implements IEmbeddingVectorStore {
  get(hash: string): number[] | null {
    try {
      const { sqlite } = getDatabase();
      const row = sqlite.prepare(
        'SELECT vector_json, dims FROM catalog_embeddings WHERE text_hash = ?',
      ).get(hash) as { vector_json: string; dims: number } | undefined;
      if (!row) return null;
      const vec = JSON.parse(row.vector_json) as unknown;
      if (!Array.isArray(vec) || vec.length !== row.dims || vec.some((v) => typeof v !== 'number')) {
        return null; // riga corrotta → re-embed, mai crash
      }
      return vec as number[];
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[embedding-store] get failed (fail-soft)');
      return null;
    }
  }

  put(hash: string, vector: number[]): void {
    try {
      const { sqlite } = getDatabase();
      sqlite.prepare(
        'INSERT OR REPLACE INTO catalog_embeddings (text_hash, vector_json, dims, created_at) VALUES (?, ?, ?, ?)',
      ).run(hash, JSON.stringify(vector), vector.length, new Date().toISOString());
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[embedding-store] put failed (fail-soft)');
    }
  }
}
