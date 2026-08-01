/**
 * readonly-flag — flag operativo "workspace in sola lettura" del container tenant.
 *
 * Settato dal portal via endpoint interno quando il workspace entra in disk
 * over-quota grace (Layer 2): l'esecuzione dei workflow (vettore di crescita del
 * disco) viene bloccata in `RunService.execute`, mentre edit/delete/read restano
 * consentiti (l'utente deve poter ridurre i dati per rientrare).
 *
 * Persistito in `system_flags` (sopravvive al restart) + cache in-memory (la
 * lettura è nel hot-path di OGNI run → no query SQLite per-run). Single-tenant
 * per container → un solo valore globale.
 *
 * Fail-OPEN: se il DB non è pronto / tabella assente → NON blocca (disponibilità
 * > enforcement; il cap fisico ENOSPC del loop device resta comunque il backstop).
 */
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

/**
 * Eseguzione bloccata perché il workspace è read-only (disk over-quota grace).
 * `httpStatus` 423 Locked — la route manuale lo mappa; scheduler/trigger lo
 * loggano e skippano.
 */
export class WorkspaceReadOnlyError extends Error {
  readonly code = 'WORKSPACE_READ_ONLY';
  readonly httpStatus = 423;
  constructor() {
    super('Workspace in sola lettura (spazio disco oltre il limite): esecuzione bloccata. Riduci i dati o riattiva un piano.');
    this.name = 'WorkspaceReadOnlyError';
  }
}

const FLAG_KEY = 'read_only';
let cached: boolean | undefined;

export function isWorkspaceReadOnly(): boolean {
  if (cached !== undefined) return cached;
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get(FLAG_KEY) as { value: string } | undefined;
    cached = row?.value === 'true';
  } catch (err) {
    logger.warn({ err: String(err) }, 'readonly-flag: read failed, fail-open (no block)');
    cached = false;
  }
  return cached;
}

export function setWorkspaceReadOnly(value: boolean): void {
  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      `INSERT INTO system_flags (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(FLAG_KEY, value ? 'true' : 'false');
  cached = value;
  logger.info({ readOnly: value }, 'workspace read-only flag updated');
}

/** Per i test: resetta la cache in-memory. */
export function __resetReadOnlyCacheForTest(): void {
  cached = undefined;
}
