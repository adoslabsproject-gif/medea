import { describe, it, expect } from 'vitest';
import {
  CREATE_GENERATIONS_TABLE_SQL,
  GENERATIONS_COLUMNS,
  GENERATIONS_TABLE,
  GENERATIONS_DB_NAME,
  RATINGS,
} from './schema.js';

/**
 * Contract test sullo SCHEMA della tabella (anti-drift schema↔codice): se
 * qualcuno aggiunge una colonna alla lista ma non al DDL (o viceversa) qui
 * diventa rosso. È esattamente il "test sulle tabelle create" richiesto.
 */
describe('schema generations — contratto DDL↔colonne', () => {
  it('il DDL dichiara OGNI colonna di GENERATIONS_COLUMNS', () => {
    for (const col of GENERATIONS_COLUMNS) {
      // ogni colonna compare come token all'inizio di una definizione (riga indentata)
      expect(CREATE_GENERATIONS_TABLE_SQL).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('il DDL non dichiara colonne FUORI dalla lista (no drift inverso)', () => {
    // estrae gli identificatori a inizio-riga dentro la CREATE TABLE
    const body = CREATE_GENERATIONS_TABLE_SQL.split('CREATE TABLE')[1]?.split(');')[0] ?? '';
    const declared = [...body.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]);
    for (const col of declared) {
      expect(GENERATIONS_COLUMNS).toContain(col);
    }
    expect(declared.length).toBe(GENERATIONS_COLUMNS.length);
  });

  it('è idempotente (CREATE TABLE IF NOT EXISTS + indici IF NOT EXISTS)', () => {
    expect(CREATE_GENERATIONS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS');
    expect(CREATE_GENERATIONS_TABLE_SQL).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('vincola kind e rating a livello DB (CHECK)', () => {
    expect(CREATE_GENERATIONS_TABLE_SQL).toMatch(
      /kind TEXT NOT NULL CHECK \(kind IN \('image','video'\)\)/,
    );
    expect(CREATE_GENERATIONS_TABLE_SQL).toMatch(/rating TEXT CHECK \(rating IN \('up','down'\)\)/);
  });

  it('media_ref e mime sono NOT NULL (un record senza media non ha senso)', () => {
    expect(CREATE_GENERATIONS_TABLE_SQL).toMatch(/media_ref TEXT NOT NULL/);
    expect(CREATE_GENERATIONS_TABLE_SQL).toMatch(/mime TEXT NOT NULL/);
  });

  it('costanti coerenti', () => {
    expect(GENERATIONS_TABLE).toBe('generations');
    expect(GENERATIONS_DB_NAME).toBe('private_generations');
    expect(RATINGS).toEqual(['up', 'down']);
  });
});
