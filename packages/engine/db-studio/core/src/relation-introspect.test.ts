/**
 * Test — helper condiviso introspezione FK (mapping onDelete + Relation + ordinal).
 * @module relation-introspect.test
 */
import { describe, it, expect } from 'vitest';
import { mapOnDeleteAction, fkRowToRelation, fkRowsToRelations } from './relation-introspect.js';

describe('mapOnDeleteAction', () => {
  it.each([
    ['CASCADE', 'cascade'],
    ['cascade', 'cascade'],
    ['RESTRICT', 'restrict'],
    ['SET NULL', 'set null'],
    ['SET_NULL', 'set null'], // MSSQL *_desc usa underscore
    ['SET DEFAULT', 'set default'],
    ['SET_DEFAULT', 'set default'],
    ['NO ACTION', 'no action'],
    ['NO_ACTION', 'no action'],
    ['  cascade  ', 'cascade'],
  ])('%s → %s', (raw, expected) => {
    expect(mapOnDeleteAction(raw)).toBe(expected);
  });

  it('null/undefined/sconosciuto → "no action" (default SQL, mai crash)', () => {
    expect(mapOnDeleteAction(null)).toBe('no action');
    expect(mapOnDeleteAction(undefined)).toBe('no action');
    expect(mapOnDeleteAction('ZZZ')).toBe('no action');
    expect(mapOnDeleteAction('')).toBe('no action');
  });
});

describe('fkRowToRelation', () => {
  it('costruisce Relation con id/name deterministici + kind one-to-many', () => {
    const r = fkRowToRelation({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
      onDelete: 'CASCADE',
    });
    expect(r).toEqual({
      id: 'orders.user_id->users.id#0',
      name: 'fk_orders_user_id',
      kind: 'one-to-many',
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
      onDelete: 'cascade',
    });
  });

  it("ordinal esplicito finisce nell'id (FK multiple disambiguate)", () => {
    expect(
      fkRowToRelation({ fromTable: 'a', fromColumn: 'b', toTable: 'c', toColumn: 'd', ordinal: 3 })
        .id,
    ).toBe('a.b->c.d#3');
  });
});

describe('fkRowsToRelations', () => {
  it('assegna ordinal incrementale a FK con stessa from/to → id UNIVOCI', () => {
    const rows = [
      { fromTable: 'o', fromColumn: 'a', toTable: 't', toColumn: 'id' },
      { fromTable: 'o', fromColumn: 'a', toTable: 't', toColumn: 'id' }, // duplicato stessa coppia
      { fromTable: 'o', fromColumn: 'b', toTable: 't', toColumn: 'id' },
    ];
    const rels = fkRowsToRelations(rows);
    const ids = rels.map((r) => r.id);
    expect(new Set(ids).size).toBe(3); // tutti univoci
    expect(ids).toContain('o.a->t.id#0');
    expect(ids).toContain('o.a->t.id#1');
    expect(ids).toContain('o.b->t.id#0');
  });

  it('lista vuota → []', () => {
    expect(fkRowsToRelations([])).toEqual([]);
  });
});
