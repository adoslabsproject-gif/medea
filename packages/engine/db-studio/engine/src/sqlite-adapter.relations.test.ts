/**
 * Test 2026-grade — SqliteAdapter.introspectRelations (foreign key REALI).
 * sqlite :memory' con FK vere create via DDL → assert sulle relations estratte.
 * È la fonte di verità dell'ER diagram: provato sul DB vero, non su un manifest.
 *
 * @module engine/sqlite-adapter.relations.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from '@flowforge/db-studio-core';
import { SqliteAdapter } from './sqlite-adapter.js';

const sampleDb: Database = {
  id: 'reltest', tenantId: 't1', name: 'rel', connection: { engine: 'sqlite', embedded: true, url: ':memory:' },
  tables: [], relations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

let adapter: SqliteAdapter;
beforeEach(async () => { adapter = new SqliteAdapter(); await adapter.connect(sampleDb); });
afterEach(async () => { await adapter.disconnect(); });

describe('SqliteAdapter.introspectRelations', () => {
  it('estrae una FK reale con onDelete corretto', async () => {
    await adapter.executeRaw('CREATE TABLE customers (id INTEGER PRIMARY KEY)');
    await adapter.executeRaw('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE)');
    const rels = await adapter.introspectRelations();
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromTable: 'orders', fromColumn: 'customer_id',
      toTable: 'customers', toColumn: 'id', onDelete: 'cascade', kind: 'one-to-many',
    });
  });

  it('nessuna FK → array vuoto', async () => {
    await adapter.executeRaw('CREATE TABLE solo (id INTEGER PRIMARY KEY, nome TEXT)');
    expect(await adapter.introspectRelations()).toEqual([]);
  });

  it('FK multiple su più tabelle, onDelete mappati (RESTRICT/SET NULL/default NO ACTION)', async () => {
    await adapter.executeRaw('CREATE TABLE a (id INTEGER PRIMARY KEY)');
    await adapter.executeRaw('CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id) ON DELETE RESTRICT)');
    await adapter.executeRaw('CREATE TABLE c (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id) ON DELETE SET NULL, b_id INTEGER REFERENCES b(id))');
    const rels = await adapter.introspectRelations();
    expect(rels).toHaveLength(3);
    const byFrom = new Map(rels.map((r) => [`${r.fromTable}.${r.fromColumn}`, r]));
    expect(byFrom.get('b.a_id')).toMatchObject({ toTable: 'a', onDelete: 'restrict' });
    expect(byFrom.get('c.a_id')).toMatchObject({ toTable: 'a', onDelete: 'set null' });
    expect(byFrom.get('c.b_id')).toMatchObject({ toTable: 'b', onDelete: 'no action' });
  });

  it('id relation univoco per ogni FK (no collisioni in ER diagram)', async () => {
    await adapter.executeRaw('CREATE TABLE a (id INTEGER PRIMARY KEY)');
    await adapter.executeRaw('CREATE TABLE c (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id), b_id INTEGER REFERENCES a(id))');
    const rels = await adapter.introspectRelations();
    const ids = rels.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
