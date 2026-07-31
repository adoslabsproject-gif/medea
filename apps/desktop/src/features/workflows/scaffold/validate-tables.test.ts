/**
 * I nomi delle tabelle richieste da un workflow finiscono in una DDL: questo
 * è il perimetro anti SQL-injection e anti-ombreggiamento del database di
 * Medea. Ogni caso ostile qui deve produrre una violazione — nessun nome
 * passa "perché tanto poi viene quotato".
 */

import { describe, expect, it } from 'vitest';

import { makeValid } from './fixtures';
import type { ScaffoldOutput } from './schema';
import { RESERVED_TABLE_NAMES, validateTables } from './validate-tables';

function withTables(tables: NonNullable<ScaffoldOutput['tablesToCreate']>): ScaffoldOutput {
  const out = makeValid();
  out.tablesToCreate = tables;
  return out;
}

const GOOD_COLUMNS = [
  { name: 'id', type: 'integer' },
  { name: 'created_at', type: 'timestamp' },
];

describe('tabelle valide', () => {
  it('senza tablesToCreate non ci sono violazioni', () => {
    expect(validateTables(makeValid())).toHaveLength(0);
  });

  it('accetta una tabella ben formata', () => {
    const out = withTables([{ name: 'followup_emails', columns: GOOD_COLUMNS }]);
    expect(validateTables(out)).toHaveLength(0);
  });

  it('accetta colonne nullable e tutti i tipi ammessi', () => {
    const out = withTables([
      {
        name: 'catalogo_eventi',
        columns: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'integer' },
          { name: 'c', type: 'real' },
          { name: 'd', type: 'boolean', nullable: true },
          { name: 'e', type: 'timestamp' },
          { name: 'f', type: 'json' },
        ],
      },
    ]);
    expect(validateTables(out)).toHaveLength(0);
  });
});

describe('nomi ostili (bug bounty)', () => {
  it.each([
    ['iniezione SQL con punto e virgola', 'tasks; DROP TABLE messages--'],
    ['virgolette', 'tasks"'],
    ['apice', "tasks'"],
    ['backtick', '`tasks`'],
    ['spazi', 'my tasks'],
    ['cifra iniziale', '1tasks'],
    ['maiuscole', 'Tasks'],
    ['trattino', 'my-tasks'],
    ['vuoto', ''],
    ['unicode', 'tabella_città'],
    ['parentesi', 'tasks(id)'],
  ])('respinge %s: %j', (_label, name) => {
    const out = withTables([{ name, columns: GOOD_COLUMNS }]);
    expect(validateTables(out).some((v) => v.kind === 'invalid_table')).toBe(true);
  });

  it('respinge un nome oltre i 64 caratteri', () => {
    const out = withTables([{ name: 'a'.repeat(65), columns: GOOD_COLUMNS }]);
    expect(validateTables(out).some((v) => v.kind === 'invalid_table')).toBe(true);
  });

  it('respinge il prefisso riservato sqlite_', () => {
    const out = withTables([{ name: 'sqlite_sequence', columns: GOOD_COLUMNS }]);
    const v = validateTables(out);
    expect(v[0]?.message).toContain('sqlite_');
  });
});

describe('ombreggiamento del database di Medea', () => {
  it('respinge ogni tabella riservata, per nome esatto', () => {
    for (const reserved of RESERVED_TABLE_NAMES) {
      const out = withTables([{ name: reserved, columns: GOOD_COLUMNS }]);
      expect(validateTables(out).some((v) => v.kind === 'invalid_table')).toBe(true);
    }
  });

  it('la lista riservata copre le tabelle vitali', () => {
    const vitals = [
      'messages',
      'accounts',
      'contacts',
      'schema_version',
      'messages_fts',
      'workflows',
    ];
    for (const vital of vitals) {
      expect(RESERVED_TABLE_NAMES.has(vital)).toBe(true);
    }
  });

  it('respinge dichiarazioni duplicate della stessa tabella', () => {
    const out = withTables([
      { name: 'followups', columns: GOOD_COLUMNS },
      { name: 'followups', columns: GOOD_COLUMNS },
    ]);
    expect(validateTables(out).filter((v) => v.kind === 'invalid_table')).toHaveLength(1);
  });
});

describe('colonne', () => {
  it('respinge una tabella senza colonne', () => {
    const out = withTables([{ name: 'vuota', columns: [] }]);
    expect(validateTables(out)[0]?.message).toContain('non ha colonne');
  });

  it('respinge più di 32 colonne', () => {
    const columns = Array.from({ length: 33 }, (_, i) => ({ name: `c_${i}`, type: 'text' }));
    const out = withTables([{ name: 'larga', columns }]);
    expect(validateTables(out).some((v) => v.kind === 'invalid_table')).toBe(true);
  });

  it('respinge nomi di colonna ostili', () => {
    const out = withTables([
      { name: 'ok', columns: [{ name: 'id; DROP TABLE messages', type: 'text' }] },
    ]);
    expect(validateTables(out).some((v) => v.kind === 'invalid_column')).toBe(true);
  });

  it('respinge colonne duplicate', () => {
    const out = withTables([
      {
        name: 'ok',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'id', type: 'text' },
        ],
      },
    ]);
    const v = validateTables(out).find((x) => x.kind === 'invalid_column');
    expect(v?.message).toContain('due volte');
  });

  it('respinge un tipo inesistente, elencando quelli ammessi', () => {
    const out = withTables([{ name: 'ok', columns: [{ name: 'id', type: 'varchar' }] }]);
    const v = validateTables(out).find((x) => x.kind === 'invalid_column');
    expect(v?.message).toContain('text | integer | real | boolean | timestamp | json');
  });

  it('respinge il tipo in maiuscolo: la normalizzazione spetta alla riparazione', () => {
    const out = withTables([{ name: 'ok', columns: [{ name: 'id', type: 'TEXT' }] }]);
    expect(validateTables(out).some((v) => v.kind === 'invalid_column')).toBe(true);
  });
});
