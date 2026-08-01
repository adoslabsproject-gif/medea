// @vitest-environment node
/**
 * GUARD legale anti-regressione — la tabella `ai_signals` (Track A) NON deve MAI
 * contenere testo libero / PII / quasi-identificatori.
 *
 * È l'invariante che rende Track A "sempre attivo senza consenso" difendibile:
 * se è non-personale è fuori dal GDPR. Questo test legge lo schema REALE da
 * `migrate.ts` (non una copia) ed esige che le colonne siano ESATTAMENTE l'insieme
 * non-personale approvato. Aggiungere `prompt`/`message`/`snapshot`/… fa fallire il
 * test → forza una decisione legale consapevole, non una svista. (Regola owner:
 * "se un commento promette un comportamento, serve un test che lo asserisce".)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'migrate.ts');

/** Estrae i nomi-colonna dal blocco `CREATE TABLE ... ai_signals ( ... )`. */
function aiSignalsColumns(): string[] {
  const src = readFileSync(MIGRATE, 'utf8');
  const start = src.indexOf('CREATE TABLE IF NOT EXISTS ai_signals (');
  expect(start, 'blocco CREATE TABLE ai_signals non trovato in migrate.ts').toBeGreaterThan(-1);
  const open = src.indexOf('(', start);
  // chiusura della definizione colonne: la prima ');' dopo l'open paren
  const close = src.indexOf(');', open);
  const body = src.slice(open + 1, close);
  const cols: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/--.*$/, '').trim(); // via i commenti SQL
    if (!line) continue;
    const m = /^([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i.exec(line);
    if (m?.[1]) cols.push(m[1]);
  }
  return cols;
}

// Insieme NON-personale approvato — l'unica forma consentita per Track A.
const ALLOWED = new Set([
  'id', 'tenant_id', 'interaction_type', 'node_def_id',
  'response_model', 'response_latency_ms', 'response_tokens_in', 'response_tokens_out',
  'outcome', 'outcome_at', 'quality_score', 'created_at',
]);

// Sostringhe che tradiscono testo libero / PII / contenuto utente.
const FORBIDDEN = ['prompt', 'message', 'response_message', 'patch', 'snapshot', 'history',
  'conversation', 'content', 'email', 'phone', 'body', 'text', 'user_id', 'reviewer'];

describe('🚨 GUARD legale — ai_signals è NON-personale', () => {
  const cols = aiSignalsColumns();

  it('il parser trova le colonne (sanity)', () => {
    expect(cols.length).toBeGreaterThanOrEqual(10);
    expect(cols).toContain('interaction_type');
  });

  it('🚨 nessuna colonna fuori dall\'insieme non-personale approvato', () => {
    const extra = cols.filter((c) => !ALLOWED.has(c));
    expect(extra, `colonne NON approvate in ai_signals (rischio dato personale): ${extra.join(', ')}`).toEqual([]);
  });

  it('🚨 nessun nome-colonna evoca testo libero/PII/contenuto utente', () => {
    const offenders = cols.filter((c) => FORBIDDEN.some((bad) => c.includes(bad)));
    expect(offenders, `colonne sospette di contenuto personale: ${offenders.join(', ')}`).toEqual([]);
  });
});
