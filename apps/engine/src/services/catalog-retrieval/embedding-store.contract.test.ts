/**
 * CONTRACT TEST — SqliteEmbeddingStore sullo schema VERO (runMigrations).
 *
 * Stesso pattern di snapshot-persistence.contract: lo store gira sulla
 * tabella creata dalla MIGRATION reale, non su una copia nel test. Una
 * divergenza schema↔store (typo colonna, tabella mancante) fallisce QUI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));
vi.mock('@/lib/logger.js');

const { runMigrations } = await import('@/storage/migrate.js');
const { SqliteEmbeddingStore, embedTextHash } = await import('./embedding-store.js');

beforeEach(() => {
  sqliteInst = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  sqliteInst.close();
});

describe('🚨 contract: catalog_embeddings da runMigrations() ↔ SqliteEmbeddingStore', () => {
  it('round-trip put → get sul DB migrato per davvero', () => {
    const store = new SqliteEmbeddingStore();
    const hash = embedTextHash('run js — Run JavaScript — utility');
    const vec = [0.1, -0.2, 0.33];
    expect(store.get(hash)).toBeNull();
    store.put(hash, vec);
    expect(store.get(hash)).toEqual(vec);
    // put idempotente (INSERT OR REPLACE): aggiorna, non duplica.
    store.put(hash, [9, 9, 9]);
    expect(store.get(hash)).toEqual([9, 9, 9]);
    const count = sqliteInst.prepare('SELECT COUNT(*) AS n FROM catalog_embeddings').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('riga corrotta (dims ≠ lunghezza) → null, mai crash (fail-soft → re-embed)', () => {
    const store = new SqliteEmbeddingStore();
    sqliteInst
      .prepare(
        'INSERT INTO catalog_embeddings (text_hash, vector_json, dims, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('h-corrotto', '[1,2]', 999, '2026-01-01');
    expect(store.get('h-corrotto')).toBeNull();
  });

  it('DB rotto → get/put non lanciano (fail-soft assoluto)', () => {
    const store = new SqliteEmbeddingStore();
    sqliteInst.close(); // simulazione: connessione morta
    expect(() => store.put('h', [1])).not.toThrow();
    expect(store.get('h')).toBeNull();
    sqliteInst = new Database(':memory:'); // ripristino per afterEach
  });
});
