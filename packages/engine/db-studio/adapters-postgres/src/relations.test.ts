/**
 * Test — PostgresAdapter.introspectRelations: mapping righe information_schema →
 * Relation + forma della query (client postgres-js mockato, niente DB reale).
 *
 * @module relations.test
 */
import { describe, it, expect } from 'vitest';
import { PostgresAdapter } from './index.js';

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
    on_delete: 'SET NULL',
  },
];

function adapterWithSql(rows: unknown[]): { adapter: PostgresAdapter; query: () => string } {
  const adapter = new PostgresAdapter();
  let captured = '';
  // tagged template mock: cattura l'SQL e ritorna le righe finte.
  (adapter as unknown as { sql: unknown }).sql = (strings: TemplateStringsArray) => {
    captured = strings.join(' ? ');
    return Promise.resolve(rows);
  };
  return { adapter, query: () => captured };
}

describe('PostgresAdapter.introspectRelations — mapping', () => {
  it('mappa le FK in Relation (from=child, to=parent, onDelete normalizzato)', async () => {
    const { adapter } = adapterWithSql(FK_ROWS);
    const rels = await adapter.introspectRelations();
    expect(rels).toHaveLength(2);
    expect(rels[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
      onDelete: 'cascade',
      kind: 'one-to-many',
    });
    expect(rels[1]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'shop_id',
      toTable: 'shops',
      toColumn: 'id',
      onDelete: 'set null',
    });
  });

  it('la query interroga information_schema per le FOREIGN KEY (composite-safe)', async () => {
    const { adapter, query } = adapterWithSql([]);
    await adapter.introspectRelations();
    expect(query()).toMatch(/information_schema/u);
    expect(query()).toMatch(/FOREIGN KEY/u);
    expect(query()).toMatch(/position_in_unique_constraint/u); // join composite-safe
  });

  it('nessuna FK → []', async () => {
    const { adapter } = adapterWithSql([]);
    expect(await adapter.introspectRelations()).toEqual([]);
  });
});

describe('PostgresAdapter — rename_column', () => {
  it('ALTER TABLE RENAME COLUMN nativo', async () => {
    const sql = await new PostgresAdapter().previewMigration([
      { kind: 'rename_column', tableName: 'users', from: 'name', to: 'full_name' },
    ]);
    expect(sql).toMatch(/ALTER TABLE "users" RENAME COLUMN "name" TO "full_name"/u);
  });
});
