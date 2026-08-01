/**
 * Guard SELECT-only ROBUSTO per db_sql_query (security, 2026-06-17).
 *
 * Il guard precedente controllava solo la PRIMA keyword (startsWith select/with) →
 * bypassabile, violando la promessa "se vedi db_sql_query nel grafo, nessun dato
 * viene modificato qui":
 *   1. CTE data-modifying Postgres: `WITH x AS (DELETE FROM t RETURNING *) SELECT…`
 *      inizia con `with` → passava → ma CANCELLA dati.
 *   2. Multi-statement: `SELECT 1; DELETE FROM x` inizia con `select` → passava.
 *
 * Difesa: si lavora su uno "scheletro" senza stringhe/commenti (niente falsi
 * positivi da letterali tipo 'please delete'), si rifiutano i ; interni
 * (multi-statement) e qualsiasi keyword DML/DDL OVUNQUE (anche dentro un CTE).
 * PURO → testabile in isolamento.
 */

/**
 * Riduce `sql` a uno "scheletro" senza commenti né contenuto di stringhe,
 * preservando struttura/keyword/`;` REALI (fuori da stringhe e commenti).
 *
 * DEVE essere un SINGLE-PASS left-to-right (chi apre prima vince), NON passate
 * regex sequenziali: un marcatore di commento DENTRO una stringa (es. lo
 * slash-star o il doppio-trattino dentro apici) NON e' un commento. Le passate
 * sequenziali (commenti-poi-stringhe) erano bypassabili: un finto commento
 * aperto da uno slash-star dentro una stringa ingoiava un ";" + DELETE reale
 * successivo, lasciando solo "SELECT ''" nello skeleton -> DML in un nodo
 * "sola lettura" (fix 2026-06-18, vedi test BYPASS).
 *
 * Sintassi Postgres-faithful (il server e' PG): stringhe con apici singoli
 * (escape ''), identificatori con doppi apici (escape ""), dollar-quoting
 * tag-based, commenti di linea doppio-trattino, commenti a blocco ANNIDATI.
 */
export function sqlSkeleton(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Commento di linea -- … fino a newline
    if (c === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    // Commento a blocco /* … */ ANNIDATO (semantica Postgres)
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      out += ' ';
      continue;
    }
    // Stringa '…' con escape '' raddoppiato
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "''";
      continue;
    }
    // Identificatore "…" con escape "" raddoppiato
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      out += '""';
      continue;
    }
    // Dollar-quoting Postgres $tag$ … $tag$ (tag opzionale: $$ … $$)
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Dollar-quote NON terminato (malformato/ostile, es. `SELECT $x$ ; DELETE …`):
          // ingoiare fino a fine NASCONDEREBBE le keyword successive al guard read-only.
          // Conservativo: tratta `$` come char letterale e prosegui lo scan → DELETE/DROP
          // restano visibili e vengono bloccati (uno skeleton "select" silenzioso no).
          out += c;
          i += 1;
          continue;
        }
        i = end + tag.length;
        out += '$$';
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return out;
}

// Keyword che MUTANO dati/schema o cambiano stato di sessione/transazione. Parole
// non ambigue (un loro uso come identificatore richiederebbe il quoting, che lo
// skeleton svuota → niente falsi positivi).
//
// `into`: `SELECT … INTO nuova_tabella FROM …` su Postgres/MSSQL (DB esterni
// connessi dal tenant) CREA una tabella pur iniziando con SELECT → bypassava sia
// questo guard sia classifyStatement server-side (che lo classifica 'select').
// In un SELECT legittimo `INTO` non compare mai fuori da questa forma; un nome
// "into" richiederebbe il quoting che lo skeleton svuota → nessun falso positivo.
// (SQLite non supporta SELECT INTO → lì è già un errore di sintassi.)
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|grant|revoke|call|copy|vacuum|reindex|cluster|begin|commit|rollback|savepoint|into)\b/i;

/**
 * Lancia se `sql` non è una SINGOLA query di sola lettura (SELECT o CTE WITH che
 * NON contiene DML/DDL). Tollera un `;` finale e commenti/whitespace iniziali.
 */
export function assertSelectOnly(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, ''); // tollera UN ; finale
  const skel = sqlSkeleton(trimmed);

  if (skel.includes(';')) {
    throw new Error('db_sql_query: più statement non consentiti — una sola query SELECT. Rimuovi i ";" interni.');
  }

  const lead = skel.replace(/^\s+/, '').toLowerCase();
  if (!lead.startsWith('select') && !lead.startsWith('with')) {
    throw new Error('db_sql_query: solo SELECT (e CTE WITH) consentiti. Per mutazioni usa db_insert / db_update / db_delete.');
  }

  const m = FORBIDDEN.exec(skel);
  if (m) {
    throw new Error(`db_sql_query: parola chiave "${m[1]!.toUpperCase()}" non consentita — questo nodo è SOLO lettura (anche dentro un CTE). Per mutazioni usa db_insert / db_update / db_delete.`);
  }
}
