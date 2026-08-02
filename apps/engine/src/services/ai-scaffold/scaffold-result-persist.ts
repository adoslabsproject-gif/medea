/**
 * Persistenza SQLite dei risultati scaffold DONE — refinement +5% del job-store.
 *
 * Il job-store (scaffold-jobs.ts) è in-memory: un RESTART del container nella
 * finestra di retrieval (15min) perderebbe una generazione GIÀ COMPLETATA. Qui
 * persistiamo SOLO i risultati `done` (non lo stato `running`: un job running dopo
 * un restart è morto comunque — il processo che lo generava non c'è più).
 *
 * Best-effort: se la persistenza fallisce NON deve rompere la generazione (è un
 * +5% di robustezza su un caso raro). Tabella creata lazy (no migration dedicata).
 * Modulo separato → scaffold-jobs.ts resta PURO/testabile in-memory.
 */
import { getDatabase } from '@/storage/db.js';

const TTL_MS = 60 * 60_000; // 1h: copre la finestra di retrieval (15min job-store) + margine
let tableReady = false;

function ensureTable(sqlite: { exec: (sql: string) => void }): void {
  if (tableReady) return;
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ai_scaffold_job_results (
      id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  tableReady = true;
}

/** Persiste un risultato DONE. Best-effort (swallow errori). */
export function persistScaffoldResult(id: string, result: unknown): void {
  try {
    const { sqlite } = getDatabase();
    ensureTable(sqlite);
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO ai_scaffold_job_results (id, result_json, created_at) VALUES (?, ?, ?)',
      )
      .run(id, JSON.stringify(result), Date.now());
    // Cleanup lazy dei risultati scaduti (no cron dedicato).
    sqlite
      .prepare('DELETE FROM ai_scaffold_job_results WHERE created_at < ?')
      .run(Date.now() - TTL_MS);
  } catch {
    /* best-effort: la persistenza non deve mai far fallire la generazione */
  }
}

/** Carica un risultato DONE persistito (fallback quando l'in-memory l'ha perso). */
export function loadScaffoldResult(id: string): unknown {
  try {
    const { sqlite } = getDatabase();
    ensureTable(sqlite);
    const row = sqlite
      .prepare('SELECT result_json, created_at FROM ai_scaffold_job_results WHERE id = ?')
      .get(id) as { result_json: string; created_at: number } | undefined;
    if (!row) return null;
    if (Date.now() - row.created_at > TTL_MS) return null; // scaduto
    return JSON.parse(row.result_json);
  } catch {
    return null;
  }
}

/** Solo per i test. */
export function __resetScaffoldResultPersistTableFlag(): void {
  tableReady = false;
}
