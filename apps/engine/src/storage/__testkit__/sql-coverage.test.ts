/**
 * Unit-test del KIT schema-coverage — prova che il gate MORDE.
 *
 * Un gate che passa sempre è peggio di nessun gate: dà falsa sicurezza. Qui
 * dimostriamo, riga per riga, che `resolveDynamicSql`:
 *   - cattura un drift (colonna fantasma) ANCHE in una query dinamica;
 *   - classifica PRAGMA come introspettivo;
 *   - segnala come `irreducible` una forma con `${}` non neutralizzabile
 *     (es. colonna dinamica in SELECT) invece di mascherarla;
 *   - espande le query a nome-tabella dinamico su tutta l'allowlist;
 *   - neutralizza IN-list, WHERE, clausola-trailing e UPDATE→SELECT.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveDynamicSql } from './sql-coverage.js';

const ALLOWLIST = ['workflows', 'runs', 'audit_log'] as const;

/** Prepara ogni variante risolta contro uno schema noto → ritorna i drift. */
function driftsOf(sql: string, db: Database.Database): string[] {
  const res = resolveDynamicSql(sql, ALLOWLIST);
  if (res.kind !== 'resolved') return [];
  const out: string[] = [];
  for (const variant of res.variants) {
    try { db.prepare(variant); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column|no such table/i.test(msg)) out.push(msg);
    }
  }
  return out;
}

describe('resolveDynamicSql — classificazione', () => {
  it('PRAGMA table_info(${table}) → introspective', () => {
    expect(resolveDynamicSql('PRAGMA table_info(${table})', ALLOWLIST).kind).toBe('introspective');
  });

  it('colonna dinamica in SELECT (${col}) → irreducible (non mascherata)', () => {
    const res = resolveDynamicSql('SELECT ${col} FROM runs WHERE id = ?', ALLOWLIST);
    expect(res.kind).toBe('irreducible');
  });

  it('IN-list dinamica → resolved, una variante neutralizzata', () => {
    const res = resolveDynamicSql('SELECT id FROM runs WHERE id IN (${ph})', ALLOWLIST);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') expect(res.variants).toEqual(['SELECT id FROM runs WHERE id IN (?)']);
  });

  it('WHERE ${whereSql} → WHERE 1=1 + ORDER BY preservato', () => {
    const res = resolveDynamicSql('SELECT * FROM runs WHERE ${w} ORDER BY started_at DESC', ALLOWLIST);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') expect(res.variants[0]).toBe('SELECT * FROM runs WHERE 1=1 ORDER BY started_at DESC');
  });

  it('clausola trailing ${whereSql} → rimossa (tabella+colonne validate)', () => {
    const res = resolveDynamicSql('SELECT COUNT(*) AS c FROM runs ${whereSql}', ALLOWLIST);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') expect(res.variants[0]).toBe('SELECT COUNT(*) AS c FROM runs');
  });

  it('UPDATE SET dinamico → SELECT che valida tabella + WHERE', () => {
    const res = resolveDynamicSql('UPDATE users SET ${sets} WHERE tenant_id = ? AND id = ?', ALLOWLIST);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') expect(res.variants[0]).toBe('SELECT 1 FROM users WHERE tenant_id = ? AND id = ?');
  });

  it('tabella dinamica → una variante per ogni tabella dell\'allowlist', () => {
    const res = resolveDynamicSql('SELECT * FROM ${table} WHERE tenant_id = ?', ALLOWLIST);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') {
      expect(res.variants).toHaveLength(ALLOWLIST.length);
      expect(res.variants).toContain('SELECT * FROM workflows WHERE tenant_id = ?');
    }
  });
});

describe('resolveDynamicSql — il gate MORDE su drift reale', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE runs (id TEXT, tenant_id TEXT, started_at TEXT)');
  db.exec('CREATE TABLE workflows (id TEXT, tenant_id TEXT)');
  db.exec('CREATE TABLE audit_log (id TEXT, tenant_id TEXT)');

  it('colonna fantasma nella parte STATICA di una query dinamica → drift catturato', () => {
    // `deleted_at` non esiste su runs: la classe dell'incident dashboard-500.
    const drifts = driftsOf('SELECT id, deleted_at FROM runs WHERE id IN (${ph})', db);
    expect(drifts.length).toBeGreaterThan(0);
    expect(drifts[0]).toMatch(/no such column/i);
  });

  it('ORDER BY su colonna fantasma in query dinamica → drift catturato', () => {
    const drifts = driftsOf('SELECT * FROM runs WHERE ${w} ORDER BY ghost_col DESC', db);
    expect(drifts.length).toBeGreaterThan(0);
  });

  it('drift su UNA tabella dell\'allowlist (tenant_id mancante) → catturato', () => {
    db.exec('CREATE TABLE no_tenant (id TEXT)');
    const drifts = driftsOf('SELECT * FROM ${table} WHERE tenant_id = ?', db);
    // workflows/runs/audit_log hanno tenant_id → nessun drift atteso QUI.
    expect(drifts).toEqual([]);
    // ma se l'allowlist includesse una tabella senza tenant_id, scatterebbe:
    const res = resolveDynamicSql('SELECT * FROM ${table} WHERE tenant_id = ?', ['no_tenant']);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') {
      let caught = false;
      try { db.prepare(res.variants[0]!); } catch { caught = true; }
      expect(caught).toBe(true);
    }
  });

  it('query dinamica corretta → zero drift (no cry-wolf)', () => {
    expect(driftsOf('SELECT id, tenant_id, started_at FROM runs ${whereSql}', db)).toEqual([]);
  });
});
