/**
 * Test — alter_column (table-recreate REALE) + rename_column su SQLite in-memory.
 * Verifica che i DATI siano preservati e lo schema cambiato davvero — prima
 * alter_column era un NO-OP (commento). Esecuzione reale, niente green-fake.
 *
 * @module sqlite-adapter.alter-column.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from './sqlite-adapter.js';
import type { Database, Table } from '@medea/engine-db-studio-core';

const sampleDb: Database = {
  id: 'db',
  tenantId: 'default',
  name: 'T',
  connection: { engine: 'sqlite', embedded: true, url: ':memory:' },
  tables: [],
  relations: [],
  createdAt: '',
  updatedAt: '',
};

const usersTable: Table = {
  id: 'users',
  name: 'users',
  columns: [
    {
      id: 'id',
      name: 'id',
      type: 'integer',
      constraints: { primaryKey: true, nullable: false, unique: false },
    },
    {
      id: 'name',
      name: 'name',
      type: 'text',
      constraints: { nullable: true, unique: false, primaryKey: false },
    },
    {
      id: 'age',
      name: 'age',
      type: 'integer',
      constraints: { nullable: true, unique: false, primaryKey: false },
    },
  ],
  indexes: [],
};

describe('SqliteAdapter — alter_column / rename_column (table-recreate reale)', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => {
    adapter = new SqliteAdapter();
    await adapter.connect(sampleDb);
    await adapter.applyMigration([{ kind: 'create_table', table: usersTable }]);
    await adapter.insert('users', { id: 1, name: 'Alice', age: 30 });
    await adapter.insert('users', { id: 2, name: 'Bob', age: 25 });
  });
  afterEach(async () => {
    await adapter.disconnect();
  });

  async function colNames(): Promise<string[]> {
    return (await adapter.introspect()).find((t) => t.name === 'users')!.columns.map((c) => c.name);
  }

  it('rename_column: name → full_name, DATI preservati', async () => {
    await adapter.applyMigration([
      { kind: 'rename_column', tableName: 'users', from: 'name', to: 'full_name' },
    ]);
    expect(await colNames()).toEqual(['id', 'full_name', 'age']);
    const rows = await adapter.query<{ id: number; full_name: string }>({
      table: 'users',
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
    expect(rows.rows).toEqual([
      { id: 1, full_name: 'Alice', age: 30 },
      { id: 2, full_name: 'Bob', age: 25 },
    ]);
  });

  it('alter_column: age integer→text + NOT NULL, DATI preservati (era un NO-OP prima)', async () => {
    await adapter.applyMigration([
      {
        kind: 'alter_column',
        tableName: 'users',
        columnName: 'age',
        patch: { type: 'text', constraints: { nullable: false, unique: false, primaryKey: false } },
      },
    ]);
    // dati preservati
    const rows = await adapter.query<{ id: number; age: unknown }>({
      table: 'users',
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
    expect(rows.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.rows.map((r) => String(r.age))).toEqual(['30', '25']);
    // NOT NULL applicato davvero: un insert con age NULL deve fallire (sync o async).
    let nullInsertFailed = false;
    try {
      await adapter.insert('users', { id: 3, name: 'X', age: null });
    } catch {
      nullInsertFailed = true;
    }
    expect(nullInsertFailed).toBe(true);
  });

  it('alter_column con rinomina (patch.name): age → eta + dati preservati', async () => {
    await adapter.applyMigration([
      {
        kind: 'alter_column',
        tableName: 'users',
        columnName: 'age',
        patch: {
          name: 'eta',
          type: 'integer',
          constraints: { nullable: true, unique: false, primaryKey: false },
        },
      },
    ]);
    expect(await colNames()).toEqual(['id', 'name', 'eta']);
    const rows = await adapter.query<{ id: number; eta: number }>({
      table: 'users',
      orderBy: [{ column: 'id', direction: 'asc' }],
    });
    expect(rows.rows.map((r) => r.eta)).toEqual([30, 25]);
  });

  it('🚨 alter_column su colonna inesistente → throw (niente recreate distruttivo)', async () => {
    await expect(
      adapter.applyMigration([
        {
          kind: 'alter_column',
          tableName: 'users',
          columnName: 'nope',
          patch: { type: 'text' },
        },
      ]),
    ).rejects.toThrow(/non esiste/u);
  });
});
