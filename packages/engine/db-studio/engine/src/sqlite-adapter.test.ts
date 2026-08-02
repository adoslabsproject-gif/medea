import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from './sqlite-adapter.js';
import type { Database, MigrationAction, Table } from '@medea/engine-db-studio-core';

const sampleDb: Database = {
  id: 'db-test',
  tenantId: 'default',
  name: 'Test',
  connection: { engine: 'sqlite', embedded: true, url: ':memory:' },
  tables: [],
  relations: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const customersTable: Table = {
  id: 'customers',
  name: 'customers',
  columns: [
    { id: 'id', name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: false } },
    { id: 'email', name: 'email', type: 'text', constraints: { unique: true, nullable: false, primaryKey: false } },
    { id: 'amount', name: 'amount', type: 'decimal', constraints: { nullable: true, unique: false, primaryKey: false } },
  ],
  indexes: [],
};

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter();
    await adapter.connect(sampleDb);
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('applies a create_table migration', async () => {
    const actions: MigrationAction[] = [{ kind: 'create_table', table: customersTable }];
    const result = await adapter.applyMigration(actions);
    expect(result.affectedTables).toContain('customers');
    expect(result.sql).toContain('CREATE TABLE');
  });

  it('preview returns SQL without executing', async () => {
    const preview = await adapter.previewMigration([{ kind: 'create_table', table: customersTable }]);
    expect(preview).toContain('CREATE TABLE');
    const introspected = await adapter.introspect();
    expect(introspected.find((t) => t.name === 'customers')).toBeUndefined();
  });

  it('insert + query roundtrip', async () => {
    await adapter.applyMigration([{ kind: 'create_table', table: customersTable }]);
    await adapter.insert('customers', { id: 1, email: 'alice@example.com', amount: 1500 });
    await adapter.insert('customers', { id: 2, email: 'bob@example.com', amount: 250 });

    const result = await adapter.query({
      table: 'customers',
      filters: [{ column: 'amount', op: 'gte', value: 1000 }],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 10,
    });
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as { email: string }).email).toBe('alice@example.com');
  });

  it('update modifies rows', async () => {
    await adapter.applyMigration([{ kind: 'create_table', table: customersTable }]);
    await adapter.insert('customers', { id: 1, email: 'a@b.com', amount: 100 });
    const upd = await adapter.update('customers', { id: 1 }, { amount: 999 });
    expect(upd.affectedRows).toBe(1);
    const result = await adapter.query({ table: 'customers', filters: [{ column: 'id', op: 'eq', value: 1 }] });
    expect((result.rows[0] as { amount: number }).amount).toBe(999);
  });

  it('delete removes rows', async () => {
    await adapter.applyMigration([{ kind: 'create_table', table: customersTable }]);
    await adapter.insert('customers', { id: 1, email: 'x@y.z', amount: 0 });
    const del = await adapter.delete('customers', { id: 1 });
    expect(del.affectedRows).toBe(1);
    const result = await adapter.query({ table: 'customers' });
    expect(result.rows).toHaveLength(0);
  });

  it('introspect lists created tables', async () => {
    await adapter.applyMigration([{ kind: 'create_table', table: customersTable }]);
    const tables = await adapter.introspect();
    expect(tables.find((t) => t.name === 'customers')).toBeDefined();
  });

  describe('transaction (atomic batch)', () => {
    const ordersTable: Table = {
      id: 'orders', name: 'orders', columns: [
        { id: 'id', name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: false } },
        { id: 'supplier_code', name: 'supplier_code', type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
      ], indexes: [],
    };
    const linesTable: Table = {
      id: 'order_lines', name: 'order_lines', columns: [
        { id: 'id', name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: false } },
        { id: 'order_id', name: 'order_id', type: 'integer', constraints: { nullable: false, unique: false, primaryKey: false } },
        { id: 'sku', name: 'sku', type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
        { id: 'qty', name: 'qty', type: 'integer', constraints: { nullable: false, unique: false, primaryKey: false } },
      ], indexes: [],
    };

    beforeEach(async () => {
      await adapter.applyMigration([{ kind: 'create_table', table: ordersTable }, { kind: 'create_table', table: linesTable }]);
    });

    it('commits header + children atomically and propagates FK', async () => {
      const result = await adapter.transaction([
        { kind: 'insert', table: 'orders', row: { supplier_code: 'F139' }, as: 'orderId' },
        { kind: 'insertMany', table: 'order_lines', rows: [
          { sku: 'A1', qty: 10 },
          { sku: 'A2', qty: 20 },
          { sku: 'A3', qty: 30 },
        ], refColumn: 'order_id', refFrom: 'orderId' },
      ]);
      expect(result.bindings.orderId).toBeGreaterThan(0);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[1]?.affectedRows).toBe(3);

      const lines = await adapter.query({ table: 'order_lines' });
      expect(lines.rows).toHaveLength(3);
      expect((lines.rows[0] as { order_id: number }).order_id).toBe(result.bindings.orderId);
    });

    it('rolls back EVERYTHING when a child insert fails', async () => {
      // Force a failure: missing required column `qty` on the second row.
      await expect(adapter.transaction([
        { kind: 'insert', table: 'orders', row: { supplier_code: 'F999' }, as: 'orderId' },
        { kind: 'insertMany', table: 'order_lines', rows: [
          { sku: 'OK1', qty: 1 },
          // @ts-expect-error intentionally invalid for test
          { sku: 'BAD', missing_field: 99 },
        ], refColumn: 'order_id', refFrom: 'orderId' },
      ])).rejects.toThrow();

      // Header must NOT be persisted (atomic rollback).
      const orders = await adapter.query({ table: 'orders', filters: [{ column: 'supplier_code', op: 'eq', value: 'F999' }] });
      expect(orders.rows).toHaveLength(0);
      const lines = await adapter.query({ table: 'order_lines' });
      expect(lines.rows).toHaveLength(0);
    });

    it('binds explicit TEXT id (UUID-style) for downstream FK', async () => {
      // Real-world schema: id TEXT PRIMARY KEY (not autoincrement). The
      // workflow generates UUIDs and the children must reference THAT,
      // not the internal sqlite rowid.
      const ordersText: Table = {
        id: 'orders_text', name: 'orders_text', columns: [
          { id: 'id', name: 'id', type: 'text', constraints: { primaryKey: true, nullable: false, unique: false } },
          { id: 'order_number', name: 'order_number', type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
        ], indexes: [],
      };
      const linesText: Table = {
        id: 'lines_text', name: 'lines_text', columns: [
          { id: 'id', name: 'id', type: 'text', constraints: { primaryKey: true, nullable: false, unique: false } },
          { id: 'order_id', name: 'order_id', type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
          { id: 'sku', name: 'sku', type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
        ], indexes: [],
      };
      await adapter.applyMigration([{ kind: 'create_table', table: ordersText }, { kind: 'create_table', table: linesText }]);

      const r = await adapter.transaction([
        { kind: 'insert', table: 'orders_text', row: { id: 'ord-uuid-abc', order_number: '2600070' }, as: 'orderId' },
        { kind: 'insertMany', table: 'lines_text', rows: [
          { id: 'line-1', sku: 'A1' },
          { id: 'line-2', sku: 'A2' },
        ], refColumn: 'order_id', refFrom: 'orderId' },
      ]);
      expect(r.bindings.orderId).toBe('ord-uuid-abc');
      const lines = await adapter.query({ table: 'lines_text' });
      expect((lines.rows[0] as { order_id: string }).order_id).toBe('ord-uuid-abc');
    });

    it('throws when refFrom is not bound', async () => {
      await expect(adapter.transaction([
        { kind: 'insertMany', table: 'order_lines', rows: [{ sku: 'X', qty: 1 }], refColumn: 'order_id', refFrom: 'missing' },
      ])).rejects.toThrow(/refFrom/);
    });
  });
});
