/**
 * SQL SCHEMA-COVERAGE KIT — analisi statica del SQL del runtime.
 *
 * Cuore del gate `db-schema-coverage.test.ts`. Estrae OGNI query `.prepare(...)`
 * dal sorgente runtime e la rende validabile contro lo schema SQLite reale.
 *
 * Due classi di query:
 *  - STATICHE  (nessun `${}`): preparate as-is.
 *  - DINAMICHE (con `${}`):  passate a `resolveDynamicSql`, che NON indovina i
 *    valori runtime ma NEUTRALIZZA i frammenti interpolati preservando la parte
 *    statica schema-validabile (nome tabella, colonne in SELECT/WHERE/ORDER BY).
 *    Così la classe di bug "colonna/tabella fantasma" — quella dell'incident
 *    dashboard-500 (`workflows.deleted_at`) — è chiusa ANCHE dentro le query
 *    costruite a runtime, senza falsi positivi sui frammenti realmente dinamici.
 *
 * Principio anti-erosione: ogni dinamica DEVE risolversi in `resolved` o
 * `introspective`. Una forma nuova non gestita torna `irreducible` e fa fallire
 * il gate — un buco non può più entrare di nascosto.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Esito della risoluzione di una query dinamica. */
export type DynamicResolution =
  /** Neutralizzata in 1+ query preparabili contro lo schema reale. */
  | { kind: 'resolved'; variants: string[]; note: string }
  /** Introspettiva (PRAGMA): non referenzia colonne in modo schema-validabile. */
  | { kind: 'introspective'; note: string }
  /** Forma dinamica non riconosciuta: il gate la segnala invece di ignorarla. */
  | { kind: 'irreducible'; reason: string };

const PLACEHOLDER = /\$\{[^}]*\}/;
const hasPlaceholder = (s: string): boolean => PLACEHOLDER.test(s);
const stripQuotes = (t: string): string => t.replace(/^[`"]|[`"]$/g, '');

/**
 * Raccoglie ricorsivamente i `.ts` di PRODUZIONE (no test, no testkit, no dist,
 * no `.d.ts`). Saltare `__testkit__` evita che questo stesso file — che contiene
 * frammenti SQL d'esempio nei commenti — venga scansionato come sorgente.
 */
export function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === '__tests__' ||
      name === '__testkit__'
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Estrae le stringhe SQL passate a `.prepare(...)`: template-literal backtick
 * (multi-linea), single-quote e double-quote. `[^`]` include i newline → nessun
 * flag `s` necessario per i template multilinea.
 */
export function extractPreparedSql(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.prepare\(\s*`([^`]*)`/g)) out.push(m[1] ?? '');
  for (const m of src.matchAll(/\.prepare\(\s*'([^']*)'/g)) out.push(m[1] ?? '');
  for (const m of src.matchAll(/\.prepare\(\s*"([^"]*)"/g)) out.push(m[1] ?? '');
  return out;
}

/**
 * Estrae i `CREATE TABLE IF NOT EXISTS ... )` (anche multi-linea) bilanciando le
 * parentesi: molte tabelle sono LAZY-CREATE dai loro moduli (workflow_memory,
 * wait_states) e non stanno in `runMigrations()`. Lo schema "reale" a runtime è
 * `runMigrations()` + queste. Robusto a DEFAULT annidati e assenza di `;` finale.
 */
export function extractCreateTables(src: string): string[] {
  const out: string[] = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+[`"]?[\w.]+[`"]?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      const stmt = src.slice(m.index, end + 1);
      if (!stmt.includes('${')) out.push(`${stmt};`);
    }
  }
  return out;
}

/**
 * Estrae gli `ALTER TABLE <t> ADD COLUMN <c>` lazy (schema-evolution sparsa nei
 * service). Serve solo table+colonna: applicata come TEXT (il tipo non conta per
 * la validazione "no such column").
 */
export function extractAddColumns(src: string): { table: string; col: string }[] {
  const out: { table: string; col: string }[] = [];
  for (const m of src.matchAll(
    /ALTER TABLE\s+[`"]?([\w.]+)[`"]?\s+ADD COLUMN\s+[`"]?(\w+)[`"]?/gi,
  )) {
    if (!m[0].includes('${') && m[1] && m[2]) out.push({ table: m[1], col: m[2] });
  }
  return out;
}

/**
 * Neutralizza SOLO i frammenti `${}` nei pattern LEGITTIMI di query-building,
 * riducendoli a SQL valido e schema-neutro mentre la parte statica resta intatta:
 *   IN (${ids})        → IN (?)        (lista valori, parametrizzata)
 *   VALUES (${ph})     → VALUES (?)
 *   WHERE ${cond}      → WHERE 1=1     (predicato runtime su colonne whitelisted)
 *   … ${whereSql} ⟨ORDER|LIMIT|GROUP|fine⟩ → ''  (clausola trailing opzionale)
 *
 * NON usa un catch-all che azzera ogni `${}`: un frammento in posizione non
 * riconosciuta (es. `SELECT ${col}`, colonna dinamica) SOPRAVVIVE come `${}` →
 * `resolveDynamicSql` lo marca `irreducible` invece di mascherarlo. È questo che
 * rende il gate anti-erosione anziché vacuo.
 */
function neutralizeFragments(sql: string): string {
  return (
    sql
      .replace(/\bIN\s*\(\s*\$\{[^}]*\}\s*\)/gi, 'IN (?)')
      .replace(/\bVALUES\s*\(\s*\$\{[^}]*\}\s*\)/gi, 'VALUES (?)')
      .replace(/\bWHERE\s+\$\{[^}]*\}/gi, 'WHERE 1=1')
      // Clausola trailing (whereSql opzionale): SOLO se seguita da ORDER/LIMIT/
      // GROUP o fine query — non un `${}` in mezzo ad altre clausole.
      .replace(/\s+\$\{[^}]*\}(?=\s+ORDER\b|\s+LIMIT\b|\s+GROUP\b|\s*$)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Risolve una query DINAMICA in forma(e) validabile(i) contro lo schema reale.
 *
 * @param rawSql  la stringa SQL estratta (contiene almeno un `${}`)
 * @param allowlistTables  tabelle reali su cui espandere le query a nome-tabella
 *   dinamico (`FROM ${table}` / `INTO ${table}`), tipicamente `EXPORT_TABLES`.
 */
export function resolveDynamicSql(
  rawSql: string,
  allowlistTables: readonly string[],
): DynamicResolution {
  const sql = rawSql.replace(/\s+/g, ' ').trim();

  // 1. PRAGMA introspettivo: `PRAGMA table_info(x)` su tabella inesistente NON
  //    lancia (ritorna 0 righe) → niente da validare a livello schema-drift.
  if (/^PRAGMA\b/i.test(sql)) {
    return { kind: 'introspective', note: 'PRAGMA introspettivo' };
  }

  // 2. UPDATE <t> SET <dinamico> WHERE <statico>: la SET-list nasce da una colMap
  //    whitelisted a runtime (non risolvibile), ma tabella e WHERE (tenant_id/id)
  //    sono statici. Convertiamo in `SELECT 1 FROM <t> WHERE <rest>` per validare
  //    SOLO la parte statica.
  const upd = /^UPDATE\s+([`"]?[\w.]+[`"]?)\s+SET\s+.*?\bWHERE\b\s+(.+)$/i.exec(sql);
  if (upd?.[1] && upd[2]) {
    const probe = neutralizeFragments(`SELECT 1 FROM ${upd[1]} WHERE ${upd[2]}`);
    return hasPlaceholder(probe)
      ? { kind: 'irreducible', reason: `UPDATE WHERE non neutralizzabile: ${sql}` }
      : { kind: 'resolved', variants: [probe], note: 'UPDATE→SELECT (valida tabella+WHERE)' };
  }

  // 3. INSERT/REPLACE INTO <table> ...: colonne/valori sono dinamici, ma l'esistenza
  //    della tabella è validabile. Table dinamica → espansa sull'allowlist.
  const ins = /^INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\$\{[^}]*\}|[`"]?[\w.]+[`"]?)/i.exec(sql);
  if (ins?.[1]) {
    const targets = hasPlaceholder(ins[1]) ? allowlistTables : [stripQuotes(ins[1])];
    return {
      kind: 'resolved',
      variants: targets.map((t) => `SELECT 1 FROM ${t} LIMIT 0`),
      note: 'INSERT→esistenza tabella',
    };
  }

  // 4. SELECT/DELETE con TABELLA dinamica (`FROM ${table}`): espandi su OGNI tabella
  //    dell'allowlist → valida che le colonne statiche (es. tenant_id) esistano su
  //    tutte. Un drift su una qualunque tabella allowlist fa fallire il gate.
  if (/\bFROM\s+\$\{[^}]*\}/i.test(sql)) {
    const variants: string[] = [];
    for (const t of allowlistTables) {
      const probe = neutralizeFragments(sql.replace(/(\bFROM\s+)\$\{[^}]*\}/i, `$1${t}`));
      if (!hasPlaceholder(probe)) variants.push(probe);
    }
    return variants.length > 0
      ? { kind: 'resolved', variants, note: 'tabella dinamica → allowlist expansion' }
      : { kind: 'irreducible', reason: `tabella dinamica non espandibile: ${sql}` };
  }

  // 5. Tabella STATICA, frammenti solo in WHERE/IN/clausola-trailing: neutralizza.
  const probe = neutralizeFragments(sql);
  if (!hasPlaceholder(probe)) {
    return {
      kind: 'resolved',
      variants: [probe],
      note: 'frammenti neutralizzati (WHERE/IN/clausola)',
    };
  }

  // 6. Forma non riconosciuta: il gate la segnala (no skip silenzioso).
  return { kind: 'irreducible', reason: `forma dinamica non riconosciuta: ${sql}` };
}
