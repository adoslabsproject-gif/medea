/**
 * Test — recreateTableStatements (funzione pura: assembly degli statement).
 * @module alter-column-recreate.test
 */
import { describe, it, expect } from 'vitest';
import { recreateTableStatements } from './alter-column-recreate.js';

const q = (id: string): string => `"${id}"`;

describe('recreateTableStatements', () => {
  it('genera CREATE tmp → INSERT SELECT → DROP → RENAME nell\'ordine giusto', () => {
    const stmts = recreateTableStatements({
      tableName: 'users',
      columnsDdl: ['"id" INTEGER PRIMARY KEY', '"full_name" TEXT NOT NULL'],
      copyColumns: [{ from: 'id', to: 'id' }, { from: 'name', to: 'full_name' }],
      quote: q,
    });
    expect(stmts).toEqual([
      'CREATE TABLE "_ff_recreate_users" ("id" INTEGER PRIMARY KEY, "full_name" TEXT NOT NULL)',
      'INSERT INTO "_ff_recreate_users" ("id", "full_name") SELECT "id", "name" FROM "users"',
      'DROP TABLE "users"',
      'ALTER TABLE "_ff_recreate_users" RENAME TO "users"',
    ]);
  });

  it('🚨 columnsDdl vuoto → throw (previene tabella vuota / perdita dati)', () => {
    expect(() => recreateTableStatements({ tableName: 't', columnsDdl: [], copyColumns: [], quote: q }))
      .toThrow(/nessuna colonna/u);
  });
});
