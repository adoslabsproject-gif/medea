/**
 * Port — IDataSourceResolver.
 *
 * Risolve un DataSourceRef simbolico in un IDatabaseAdapter connesso.
 * L'implementazione concreta riusa la cache di `DbStudioService` per
 * tenant DBs e tiene un singolo adapter dedicato per `system`.
 */

import type { IDatabaseAdapter } from '@medea/engine-db-studio-engine';
import type { DataSourceRef, DataSourceInfo } from '@/services/janitor/domain/index.js';

export interface IDataSourceResolver {
  /** Risolve in adapter pronto. Throw se ref invalido o DB inesistente. */
  resolve(ref: DataSourceRef): Promise<IDatabaseAdapter>;
  /** Lista dei data source disponibili per UI selector. */
  list(tenantId?: string): Promise<readonly DataSourceInfo[]>;
  /** Shutdown: chiude connection system. Idempotente. */
  disposeSystem(): Promise<void>;
}
