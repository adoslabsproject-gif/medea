/**
 * Test — MysqlAdapter.introspectRelations: mapping + query (pool mockato).
 * @module relations.test
 */
import { describe, it, expect } from 'vitest';
import { MysqlAdapter } from './index.js';

const FK_ROWS = [
  { from_table: 'orders', from_column: 'user_id', to_table: 'users', to_column: 'id', on_delete: 'CASCADE' },
];

function adapterWithPool(rows: unknown[]): { adapter: MysqlAdapter; query: () => string } {
  const adapter = new MysqlAdapter();
  let captured = '';
  // mysql2: pool.query → [rows, fields]
  (adapter as unknown as { pool: unknown }).pool = {
    query: (sql: string) => { captured = sql; return Promise.resolve([rows, []]); },
  };
  return { adapter, query: () => captured };
}

describe('MysqlAdapter.introspectRelations', () => {
  it('mappa la FK in Relation (lato referenced per-colonna, no cartesiano)', async () => {
    const { adapter } = adapterWithPool(FK_ROWS);
    const rels = await adapter.introspectRelations();
    expect(rels).toEqual([{
      id: 'orders.user_id->users.id#0', name: 'fk_orders_user_id', kind: 'one-to-many',
      fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id', onDelete: 'cascade',
    }]);
  });

  it('query usa KEY_COLUMN_USAGE + REFERENCED_TABLE_NAME del DB corrente', async () => {
    const { adapter, query } = adapterWithPool([]);
    await adapter.introspectRelations();
    expect(query()).toMatch(/KEY_COLUMN_USAGE/u);
    expect(query()).toMatch(/REFERENCED_TABLE_NAME/u);
    expect(query()).toMatch(/DATABASE\(\)/u);
  });
});
