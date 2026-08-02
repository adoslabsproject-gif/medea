/**
 * Vitest setup — DB di test effimero con schema COMPLETO.
 *
 * Prima di questo file, i test che usano il DB reale (getDatabase non-mockato)
 * leggevano `./data/medea.sqlite`: un file su disco PERSISTENTE e STALE —
 * aveva le tabelle vecchie ma non quelle aggiunte di recente
 * (`ai_workflow_templates`, `ai_budget_daily`) perché `createSqliteHandle()` non
 * chiama `runMigrations()` (lo fa solo il bootstrap del server). Conseguenze:
 *   - log "no such table" non-fatali che inquinano l'output;
 *   - non-determinismo: il risultato dipendeva dallo stato del file su disco,
 *     diverso fra la macchina dello sviluppatore e il runner CI effimero.
 *
 * Fix: ogni worker vitest riceve un file SQLite dedicato (path per-PID = stabile
 * nel worker, fresco tra run) con lo schema base applicato.
 *
 * IMPORTANTE — perché schema DIRETTO e non `runMigrations()`:
 * importare `migrate.js`/`db.js` qui sporcherebbe la module registry, e i test
 * che li mockano (`vi.mock('@/storage/db.js')` in db-schema-coverage,
 * `vi.mock('@/config.js')` in migrate.test) non rebinderebbero più → falsi
 * fallimenti. Importiamo SOLO `SCHEMA_SQL` (una costante pura, non mockata da
 * nessuno) e la applichiamo con una connessione usa-e-getta. Le tabelle che
 * causavano il rumore sono tutte in SCHEMA_SQL; i test che vogliono il proprio
 * DB restano completamente isolati.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from './src/storage/migrate.schema.js';

const dbPath = join(tmpdir(), `flowforge-test-${String(process.pid)}.sqlite`);
// WAL lascia anche -wal/-shm: ripulisci tutto per partire da uno schema pulito.
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${dbPath}${suffix}`, { force: true });
  } catch {
    /* assente → ok */
  }
}
process.env.MEDEA_DB_PATH = dbPath;

const conn = new SqliteDatabase(dbPath);
conn.exec(SCHEMA_SQL); // crea tutte le tabelle base (IF NOT EXISTS, idempotente)
conn.close(); // niente singleton aperto → i test riaprono/mockano liberamente
