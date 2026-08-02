import { describe, it, expect } from 'vitest';
import {
  TableSchema,
  DatabaseSchema,
  QuerySpecSchema,
  MigrationActionSchema,
  ColumnSchema,
} from './index.js';

describe('TableSchema', () => {
  it('accepts a well-formed table with PK column', () => {
    const ok = TableSchema.safeParse({
      id: 't1',
      name: 'customers',
      columns: [
        { id: 'c1', name: 'id', type: 'uuid', constraints: { primaryKey: true, nullable: false } },
        { id: 'c2', name: 'email', type: 'text', constraints: { unique: true, nullable: false } },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects camelCase column name', () => {
    const bad = ColumnSchema.safeParse({ id: 'x', name: 'firstName', type: 'text' });
    expect(bad.success).toBe(false);
  });
});

describe('QuerySpecSchema', () => {
  it('supports filter ops', () => {
    const ok = QuerySpecSchema.safeParse({
      table: 'invoices',
      filters: [
        { column: 'status', op: 'eq', value: 'paid' },
        { column: 'amount', op: 'gte', value: 1000 },
      ],
      orderBy: [{ column: 'issued_at', direction: 'desc' }],
      limit: 50,
    });
    expect(ok.success).toBe(true);
  });
});

describe('MigrationActionSchema (discriminated union)', () => {
  it('discriminates create_table from add_column correctly', () => {
    const ct = MigrationActionSchema.safeParse({
      kind: 'create_table',
      table: { id: 't', name: 'orders', columns: [{ id: 'c', name: 'id', type: 'uuid' }] },
    });
    expect(ct.success).toBe(true);

    const ac = MigrationActionSchema.safeParse({
      kind: 'add_column',
      tableName: 'orders',
      column: { id: 'c2', name: 'total', type: 'decimal' },
    });
    expect(ac.success).toBe(true);
  });
});

describe('DatabaseSchema', () => {
  it('accepts an embedded SQLite database', () => {
    const ok = DatabaseSchema.safeParse({
      id: 'db1',
      tenantId: 'default',
      name: 'My business DB',
      connection: { engine: 'sqlite', embedded: true },
      tables: [],
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a Postgres connection', () => {
    const ok = DatabaseSchema.safeParse({
      id: 'db2',
      tenantId: 'default',
      name: 'Prod Postgres',
      connection: {
        engine: 'postgres',
        embedded: false,
        hostname: 'db.example.com',
        port: 5432,
        database: 'flowforge_prod',
        username: 'flowforge_app',
        sslMode: 'require',
      },
      tables: [],
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
  });
});
