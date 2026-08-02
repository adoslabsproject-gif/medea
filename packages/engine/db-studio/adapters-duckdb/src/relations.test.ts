/**
 * Test — DuckDbAdapter.introspectRelations su DuckDB REALE (in-process).
 * Crea FK vere via executeRaw e verifica cosa l'adapter introspetta.
 *
 * @module relations.test
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from '@medea/engine-db-studio-core';
import { DuckDbAdapter } from './index.js';

function makeDb(): Database {
  return {
    id: 't',
    tenantId: 'default',
    name: 't',
    connection: { engine: 'duckdb', embedded: true },
    tables: [],
    relations: [],
    createdAt: '',
    updatedAt: '',
  };
}

const adapters: DuckDbAdapter[] = [];
async function connect(): Promise<DuckDbAdapter> {
  const a = new DuckDbAdapter();
  await a.connect(makeDb());
  adapters.push(a);
  return a;
}
afterEach(async () => {
  for (const a of adapters.splice(0))
    await a.disconnect().catch(() => {
      /* ignore */
    });
});

describe('DuckDbAdapter.introspectRelations (reale)', () => {
  it('FK reale orders.user_id → users.id viene introspettata correttamente', async () => {
    const a = await connect();
    await a.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY);');
    await a.executeRaw(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));',
    );
    const rels = await a.introspectRelations();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
      kind: 'one-to-many',
    });
  });

  it('nessuna FK → [] (no crash)', async () => {
    const a = await connect();
    await a.executeRaw('CREATE TABLE solo (id INTEGER PRIMARY KEY);');
    expect(await a.introspectRelations()).toEqual([]);
  });

  it('rename_column REALE: a → a2 (DuckDB ALTER RENAME COLUMN)', async () => {
    const a = await connect();
    await a.executeRaw('CREATE TABLE t (a INTEGER, b INTEGER);');
    await a.applyMigration([{ kind: 'rename_column', tableName: 't', from: 'a', to: 'a2' }]);
    const cols = (await a.introspect()).find((x) => x.name === 't')!.columns.map((c) => c.name);
    expect(cols.sort()).toEqual(['a2', 'b']);
  });
});
