import { describe, it, expect } from 'vitest';
import { MysqlAdapter } from './index.js';

describe('MysqlAdapter', () => {
  it('renders create_table SQL with backtick identifiers', async () => {
    const adapter = new MysqlAdapter();
    const sql = await adapter.previewMigration([
      {
        kind: 'create_table',
        table: {
          id: 't',
          name: 'orders',
          columns: [
            { id: 'id', name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: false } },
            { id: 'amount', name: 'amount', type: 'decimal', constraints: { primaryKey: false, nullable: true, unique: false } },
          ],
          indexes: [],
        },
      },
    ]);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `orders`');
    expect(sql).toContain('`id` INT PRIMARY KEY NOT NULL');
    expect(sql).toContain('`amount` DECIMAL(18,4)');
    expect(sql).toContain('ENGINE=InnoDB');
  });

  it('rejects identifiers with special chars', async () => {
    const adapter = new MysqlAdapter();
    await expect(adapter.previewMigration([{ kind: 'drop_table', tableName: '`; DROP--' }])).rejects.toThrow();
  });

  it('renders FK relation with cascade', async () => {
    const adapter = new MysqlAdapter();
    const sql = await adapter.previewMigration([
      { kind: 'add_relation', relation: { id: 'r', name: 'fk', kind: 'one-to-many', fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id', onDelete: 'cascade' } },
    ]);
    expect(sql).toContain('FOREIGN KEY (`customer_id`)');
    expect(sql).toContain('REFERENCES `customers`(`id`)');
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('rejects connect with no pool established', async () => {
    const adapter = new MysqlAdapter();
    await expect(adapter.query({ table: 'x' })).rejects.toThrow(/not connected/);
  });
});
