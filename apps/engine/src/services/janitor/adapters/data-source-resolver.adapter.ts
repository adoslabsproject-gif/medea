/**
 * Adapter — DataSourceResolverAdapter.
 *
 * Risolve `DataSourceRef` in `IDatabaseAdapter`. Riusa il pool di
 * connection di `DbStudioService` per i DB tenant — niente connection
 * extra per il Janitor.
 *
 * System DB: aperto come SqliteAdapter dedicato puntato al file
 * `flowforge.db` del runtime. WAL mode già abilitato dal `db.ts`
 * principale → reader/writer multipli sicuri sullo stesso file.
 */

import { SqliteAdapter, type IDatabaseAdapter } from '@medea/engine-db-studio-engine';
import type { Database } from '@medea/engine-db-studio-core';
import { join } from 'node:path';
import type { DbStudioService } from '@/services/db-studio.service.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import {
  type DataSourceRef,
  type DataSourceInfo,
  parseDataSourceRef,
  systemRef,
  tenantRef,
  engineSupportsRawSql,
} from '@/services/janitor/domain/index.js';
import type { IDataSourceResolver } from '@/services/janitor/ports/index.js';

export class DataSourceResolverAdapter implements IDataSourceResolver {
  private systemAdapter: IDatabaseAdapter | null = null;
  private readonly dbStudio: DbStudioService;

  constructor(dbStudio: DbStudioService) {
    this.dbStudio = dbStudio;
  }

  async resolve(ref: DataSourceRef): Promise<IDatabaseAdapter> {
    const parsed = parseDataSourceRef(ref);
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.value.scope === 'system') return this.resolveSystem();
    return this.resolveTenant(parsed.value.tenantId, parsed.value.dbId);
  }

  list(tenantId?: string): Promise<readonly DataSourceInfo[]> {
    const out: DataSourceInfo[] = [
      {
        ref: systemRef(),
        displayName: 'FlowForge System (runs · checkpoints · audit)',
        engine: 'sqlite',
        scope: 'system',
        supportsRawSql: true,
      },
    ];

    const dbs = this.dbStudio.list(tenantId ?? 'default');
    for (const db of dbs) {
      const refRes = tenantRef(db.tenantId ?? 'default', db.id);
      if (!refRes.ok) {
        logger.warn({ db, err: refRes.error }, 'Skip DB with invalid id/tenantId');
        continue;
      }
      const info: DataSourceInfo = {
        ref: refRes.value,
        // `Database` ha `name` + opzionale `description`. Niente `displayName`
        // — usiamo `name`; per ricchezza UI prepend `tenantId · `.
        displayName: `${db.tenantId} · ${db.name}`,
        engine: db.connection.engine,
        scope: 'tenant',
        supportsRawSql: engineSupportsRawSql(db.connection.engine),
        tenantId: db.tenantId,
      };
      out.push(info);
    }
    return Promise.resolve(out);
  }

  async disposeSystem(): Promise<void> {
    if (!this.systemAdapter) return;
    try {
      await this.systemAdapter.disconnect();
    } catch (err) {
      logger.warn({ err }, 'Failed to disconnect system datasource adapter');
    } finally {
      this.systemAdapter = null;
    }
  }

  private async resolveSystem(): Promise<IDatabaseAdapter> {
    if (this.systemAdapter) return this.systemAdapter;
    const config = loadConfig();
    const dbPath = join(config.MEDEA_DATA_DIR, 'flowforge.db');
    const adapter = new SqliteAdapter();
    const systemDb: Database = {
      id: 'flowforge_system',
      name: 'flowforge_system',
      description: 'FlowForge System (runs, audit, checkpoints) — managed by Janitor',
      tenantId: 'default',
      connection: { engine: 'sqlite', url: dbPath, embedded: false },
      tables: [],
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await adapter.connect(systemDb);
    this.systemAdapter = adapter;
    logger.info({ dbPath }, 'Janitor system datasource connected');
    return adapter;
  }

  private async resolveTenant(tenantId: string, dbId: string): Promise<IDatabaseAdapter> {
    const database = this.dbStudio.get(dbId, tenantId);
    if (!database) {
      throw new Error(`Tenant database not found: tenantId=${tenantId} dbId=${dbId}`);
    }
    return this.dbStudio.getAdapter(database);
  }
}
