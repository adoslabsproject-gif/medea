/**
 * Test — create_view / drop_view sull'adapter SQLite REALE (in-memory).
 * Non basta generare l'SQL: la view deve essere CREATA, INTERROGABILE e
 * riflettere i dati della tabella base, e drop_view deve rimuoverla davvero.
 *
 * @module sqlite-adapter.views.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from './sqlite-adapter.js';
import type { Database, MigrationAction, Table } from '@medea/engine-db-studio-core';

const sampleDb: Database = {
  id: 'db-v',
  tenantId: 'default',
  name: 'V',
  connection: { engine: 'sqlite', embedded: true, url: ':memory:' },
  tables: [],
  relations: [],
  createdAt: '',
  updatedAt: '',
};

const orders: Table = {
  id: 'orders',
  name: 'orders',
  columns: [
    {
      id: 'id',
      name: 'id',
      type: 'integer',
      constraints: { primaryKey: true, nullable: false, unique: false },
    },
    {
      id: 'total',
      name: 'total',
      type: 'integer',
      constraints: { nullable: false, unique: false, primaryKey: false },
    },
  ],
  indexes: [],
};

describe('SqliteAdapter — VIEW', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = new SqliteAdapter();
    await adapter.connect(sampleDb);
  });
  afterEach(async () => {
    await adapter.disconnect();
  });

  async function seed(): Promise<void> {
    await adapter.applyMigration([{ kind: 'create_table', table: orders }]);
    await adapter.insert('orders', { id: 1, total: 50 });
    await adapter.insert('orders', { id: 2, total: 150 });
  }

  /** True se interrogare la "tabella" fallisce (sync throw O async reject). */
  async function queryFails(table: string): Promise<boolean> {
    try {
      await adapter.query({ table });
      return false;
    } catch {
      return true;
    }
  }

  it('create_view → SQL CREATE VIEW + la view è interrogabile e riflette i dati base', async () => {
    await seed();
    const action: MigrationAction = {
      kind: 'create_view',
      view: { name: 'big_orders', select: 'SELECT id, total FROM orders WHERE total >= 100' },
    };
    const res = await adapter.applyMigration([action]);
    expect(res.sql).toContain('CREATE VIEW "big_orders"');

    const rows = await adapter.query({ table: 'big_orders' });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: 2, total: 150 });
  });

  it('la view è DINAMICA: nuovi dati nella tabella base appaiono nella view', async () => {
    await seed();
    await adapter.applyMigration([
      {
        kind: 'create_view',
        view: { name: 'big_orders', select: 'SELECT * FROM orders WHERE total >= 100' },
      },
    ]);
    await adapter.insert('orders', { id: 3, total: 200 });
    const rows = await adapter.query({ table: 'big_orders' });
    expect(rows.rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('preview NON esegue: la view non esiste dopo previewMigration', async () => {
    await seed();
    const sql = await adapter.previewMigration([
      { kind: 'create_view', view: { name: 'v_prev', select: 'SELECT 1 AS x' } },
    ]);
    expect(sql).toContain('CREATE VIEW "v_prev"');
    expect(await queryFails('v_prev')).toBe(true);
  });

  it('drop_view rimuove la view (idempotente: drop due volte non lancia)', async () => {
    await seed();
    await adapter.applyMigration([
      {
        kind: 'create_view',
        view: { name: 'big_orders', select: 'SELECT * FROM orders WHERE total >= 100' },
      },
    ]);
    await adapter.applyMigration([{ kind: 'drop_view', viewName: 'big_orders' }]);
    expect(await queryFails('big_orders')).toBe(true);
    // IF EXISTS → secondo drop non lancia
    await expect(
      adapter.applyMigration([{ kind: 'drop_view', viewName: 'big_orders' }]),
    ).resolves.toBeDefined();
  });
});
