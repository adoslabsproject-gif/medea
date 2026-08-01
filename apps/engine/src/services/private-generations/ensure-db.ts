/**
 * Creazione idempotente del database + tabella `generations`.
 *
 * Trova il database DB Studio per nome; se assente lo crea (embedded sqlite);
 * poi applica il DDL `CREATE TABLE IF NOT EXISTS`. Memoizzato per tenant: la
 * risoluzione del database id avviene una sola volta per processo (la
 * creazione resta comunque idempotente se la cache è fredda).
 *
 * @module services/private-generations/ensure-db
 */
import { CREATE_GENERATIONS_TABLE_SQL, GENERATIONS_DB_NAME, GENERATIONS_MIGRATIONS } from './schema.js';
import type { DbStudioPort, CreateEmbeddedDb } from './types.js';
import { loggerFor } from '@/lib/logger.js';

const log = loggerFor('private-gen.ensure-db');
/** Una migrazione additiva è "già applicata" se la colonna esiste — solo questo è da ignorare. */
const ALREADY_APPLIED = /duplicate column|already exists/i;

/** Cache dbId per tenant (evita una list() ad ogni richiesta). */
const dbIdCache = new Map<string, string>();

export interface EnsureDbDeps {
  dbStudio: DbStudioPort;
  createEmbeddedDb: CreateEmbeddedDb;
  tenantId: string;
}

/**
 * Ritorna l'id del database `private_generations` del tenant, creandolo +
 * creando la tabella se non esistono. Idempotente.
 */
export async function ensureGenerationsDb(deps: EnsureDbDeps): Promise<string> {
  const cached = dbIdCache.get(deps.tenantId);
  if (cached) return cached;

  const existing = deps.dbStudio.list(deps.tenantId).find((d) => d.name === GENERATIONS_DB_NAME);
  const db = existing ?? (await deps.createEmbeddedDb(GENERATIONS_DB_NAME));

  // DDL idempotente: sicuro anche se la tabella esiste già (IF NOT EXISTS).
  await deps.dbStudio.executeRaw(db.id, CREATE_GENERATIONS_TABLE_SQL, { dryRun: false, rowLimit: 0 }, deps.tenantId);

  // Migrazioni additive (colonne nuove su tabelle preesistenti). Best-effort:
  // "duplicate column" se già applicata → si ignora.
  for (const sql of GENERATIONS_MIGRATIONS) {
    try {
      await deps.dbStudio.executeRaw(db.id, sql, { dryRun: false, rowLimit: 0 }, deps.tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "colonna già presente" è l'esito atteso (migrazione idempotente) → ignora.
      // Qualsiasi altro errore è un problema REALE da rendere visibile (non silenziare).
      if (!ALREADY_APPLIED.test(msg)) log.warn({ err: msg, sql }, '[private-gen] migrazione generations fallita');
    }
  }

  dbIdCache.set(deps.tenantId, db.id);
  return db.id;
}

/** Solo per i test: azzera la memoization. */
export function __resetEnsureDbCache(): void {
  dbIdCache.clear();
}
