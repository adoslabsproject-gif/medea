/**
 * Guardia tenant del DB-agent — il chokepoint da cui passa OGNI operazione
 * che nomina un database.
 *
 * `loadOwnedDatabase` carica un DB SOLO attraverso `DbStudioService.get(id,
 * tenantId)`, che filtra `WHERE id=? AND tenant_id=?`. Un id di un altro
 * tenant (o inesistente) torna `null` → `TenantScopeError`. NON viene MAI usato
 * `getAnyTenant`/`listAllAcrossTenants` (le uniche vie cross-tenant del
 * service, riservate al superadmin operatore): qui sono semplicemente
 * irraggiungibili.
 *
 * @module services/db-agent/guard
 */
import type { Database } from '@flowforge/db-studio-core';
import type { DbAgentContext } from './context.js';
import { TenantScopeError, ToolValidationError } from './errors.js';

/**
 * Risolve un databaseId al Database posseduto dal tenant del contesto.
 * @throws ToolValidationError se l'id è vuoto/non stringa.
 * @throws TenantScopeError  se il DB non esiste NEL TENANT (msg anti-enumeration).
 */
export function loadOwnedDatabase(ctx: DbAgentContext, databaseId: unknown): Database {
  const id = typeof databaseId === 'string' ? databaseId.trim() : '';
  if (!id) throw new ToolValidationError('databaseId mancante o non valido.');
  const db = ctx.dbStudio.get(id, ctx.tenantId);
  if (!db) {
    // Stesso identico messaggio per "di un altro tenant" e "inesistente":
    // non si deve poter dedurre l'esistenza di DB altrui per enumerazione.
    throw new TenantScopeError(`Database "${id}" non trovato nel tuo workspace.`);
  }
  return db;
}

/**
 * Verifica che una tabella esista nel manifest del DB posseduto.
 * @throws TenantScopeError se il DB non è del tenant (via loadOwnedDatabase).
 * @throws ToolValidationError se la tabella non esiste nel DB.
 */
export function assertTableExists(ctx: DbAgentContext, databaseId: unknown, tableName: string): Database {
  const db = loadOwnedDatabase(ctx, databaseId);
  if (!db.tables.some((t) => t.name === tableName)) {
    throw new ToolValidationError(`Tabella "${tableName}" non esiste nel database "${db.name}".`);
  }
  return db;
}
