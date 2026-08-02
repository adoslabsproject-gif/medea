/**
 * Domain — DataSourceRef.
 *
 * Reference simbolico a una sorgente dati. Forma canonica:
 *
 *   • `system`                       → FlowForge runtime SQLite (runs, audit, ...)
 *   • `tenant:<tenantId>:<dbId>`     → DB tenant configurato in DbStudio
 *
 * Federico-grade: zero stringa concatenata sparsa nel codice. Tutte le
 * costruzioni passano da qui — refactor-friendly.
 */

import { type CorruptionSeverity } from './severity.js';
import { Ok, Err, type Result } from './result.js';

export type DataSourceRef = string & { readonly __brand: 'DataSourceRef' };

export type DataSourceScope = 'system' | 'tenant';

export interface ParsedTenantRef {
  readonly scope: 'tenant';
  readonly tenantId: string;
  readonly dbId: string;
}

export interface ParsedSystemRef {
  readonly scope: 'system';
}

export type ParsedDataSourceRef = ParsedSystemRef | ParsedTenantRef;

export const SYSTEM_REF = 'system' as DataSourceRef;
const TENANT_PREFIX = 'tenant:';

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const DB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function systemRef(): DataSourceRef {
  return SYSTEM_REF;
}

export function tenantRef(tenantId: string, dbId: string): Result<DataSourceRef, string> {
  if (!TENANT_ID_RE.test(tenantId)) return Err(`Invalid tenantId: "${tenantId}"`);
  if (!DB_ID_RE.test(dbId)) return Err(`Invalid dbId: "${dbId}"`);
  return Ok(`${TENANT_PREFIX}${tenantId}:${dbId}` as DataSourceRef);
}

export function parseDataSourceRef(ref: string): Result<ParsedDataSourceRef, string> {
  if (ref === SYSTEM_REF) return Ok({ scope: 'system' as const });
  if (!ref.startsWith(TENANT_PREFIX)) return Err(`DataSourceRef "${ref}" non riconosciuto`);
  const rest = ref.slice(TENANT_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return Err(`Tenant ref malformato: "${ref}"`);
  const tenantId = rest.slice(0, colonIdx);
  const dbId = rest.slice(colonIdx + 1);
  if (!TENANT_ID_RE.test(tenantId)) return Err(`tenantId non valido in ref: "${ref}"`);
  if (!DB_ID_RE.test(dbId)) return Err(`dbId non valido in ref: "${ref}"`);
  return Ok({ scope: 'tenant' as const, tenantId, dbId });
}

export function isDataSourceRef(value: unknown): value is DataSourceRef {
  return typeof value === 'string' && parseDataSourceRef(value).ok;
}

/** Helper UI: ritorna lo scope a partire dal ref (senza throw). */
export function scopeOf(ref: DataSourceRef): DataSourceScope {
  const parsed = parseDataSourceRef(ref);
  return parsed.ok ? parsed.value.scope : 'tenant';
}

// ────────────────────────────────────────────────────────────────────
// Info ricco (per UI dropdown del data-source selector)
// ────────────────────────────────────────────────────────────────────

/**
 * Engine ID — allineato 1:1 con `DatabaseEngine` di `@medea/engine-db-studio-core`.
 * Niente narrowing rispetto al tipo di provenienza: se db-studio aggiunge
 * un nuovo engine in futuro, qui esplode il typecheck e ricordi di
 * aggiornare il Janitor.
 */
export type DatabaseEngineId =
  | 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'duckdb'
  | 'mongodb' | 'redis' | 'vector-embedded' | 'qdrant' | 'pgvector';

export interface DataSourceInfo {
  readonly ref: DataSourceRef;
  readonly displayName: string;
  readonly engine: DatabaseEngineId;
  readonly scope: DataSourceScope;
  readonly tenantId?: string;
  /** Adapter supporta executeRaw SQL? Determina se le regole DSL sono permesse. */
  readonly supportsRawSql: boolean;
}

/** Mappa engine → supportsRawSql (Mongo/Redis non hanno SQL nativo). */
export function engineSupportsRawSql(engine: DatabaseEngineId): boolean {
  // Mongo/Redis/vector engine non hanno SQL nativo. Le DSL rule che
  // richiedono detectSql sono permesse SOLO sui restanti engine.
  switch (engine) {
    case 'sqlite':
    case 'postgres':
    case 'mysql':
    case 'mssql':
    case 'duckdb':
    case 'pgvector': // pgvector è Postgres + extension, supporta SQL
      return true;
    case 'mongodb':
    case 'redis':
    case 'vector-embedded':
    case 'qdrant':
      return false;
  }
}

/**
 * Default severity raccomandata per uno scope (UI suggest):
 *   system DB → critical (i corrotti bloccano runtime FlowForge)
 *   tenant DB → warning  (i corrotti sono problema business del tenant)
 * L'utente UI può ovviamente overridare.
 */
export function defaultSeverityForScope(scope: DataSourceScope): CorruptionSeverity {
  return scope === 'system' ? 'critical' : 'warning';
}
