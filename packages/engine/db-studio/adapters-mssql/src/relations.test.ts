/**
 * Test — MssqlAdapter.introspectRelations: mapping + query (pool mockato).
 * Verifica anche il mapping onDelete con underscore (SET_NULL → set null).
 * @module relations.test
 */
import { describe, it, expect } from 'vitest';
import { MssqlAdapter } from './index.js';

const FK_ROWS = [
  {
    from_table: 'orders',
    from_column: 'user_id',
    to_table: 'users',
    to_column: 'id',
    on_delete: 'CASCADE',
  },
  {
    from_table: 'orders',
    from_column: 'shop_id',
    to_table: 'shops',
    to_column: 'id',
    on_delete: 'SET_NULL',
  }, // *_desc underscore
];

function adapterWithPool(rows: unknown[]): { adapter: MssqlAdapter; query: () => string } {
  const adapter = new MssqlAdapter();
  let captured = '';
  // mssql: pool.request().query(sql) → { recordset }
  (adapter as unknown as { pool: unknown }).pool = {
    request: () => ({
      query: (sql: string) => {
        captured = sql;
        return Promise.resolve({ recordset: rows });
      },
    }),
  };
  return { adapter, query: () => captured };
}

describe('MssqlAdapter.introspectRelations', () => {
  it('mappa le FK + onDelete con underscore (SET_NULL → "set null")', async () => {
    const { adapter } = adapterWithPool(FK_ROWS);
    const rels = await adapter.introspectRelations();
    expect(rels).toHaveLength(2);
    expect(rels[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
      onDelete: 'cascade',
    });
    expect(rels[1]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'shop_id',
      toTable: 'shops',
      toColumn: 'id',
      onDelete: 'set null',
    });
  });

  it('query usa sys.foreign_keys + sys.foreign_key_columns', async () => {
    const { adapter, query } = adapterWithPool([]);
    await adapter.introspectRelations();
    expect(query()).toMatch(/sys\.foreign_keys/u);
    expect(query()).toMatch(/sys\.foreign_key_columns/u);
  });
});

describe('MssqlAdapter — rename_column', () => {
  it('genera sp_rename (SQL Server non ha ALTER RENAME COLUMN)', async () => {
    const sql = await new MssqlAdapter().previewMigration([
      { kind: 'rename_column', tableName: 'users', from: 'name', to: 'full_name' },
    ]);
    expect(sql).toContain("sp_rename 'users.name', 'full_name', 'COLUMN'");
  });
});
