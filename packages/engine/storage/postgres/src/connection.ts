import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export interface PostgresConfig {
  url: string;
  appRole?: string;
  poolSize?: number;
}

export type PostgresDb = PostgresJsDatabase<typeof schema>;

export interface PostgresHandle {
  db: PostgresDb;
  rawClient: postgres.Sql;
  close(): Promise<void>;
}

export function createPostgresConnection(config: PostgresConfig): PostgresHandle {
  const rawClient = postgres(config.url, {
    max: config.poolSize ?? 10,
    onnotice: () => {
      // suppress NOTICE
    },
  });
  const db = drizzle(rawClient, { schema });
  return {
    db,
    rawClient,
    close: async () => {
      await rawClient.end({ timeout: 5 });
    },
  };
}

/**
 * Wrap a callback in a tenant-scoped transaction. Sets the
 * `flowforge.tenant_id` and `flowforge.user_id` GUCs LOCALly via Drizzle's
 * transaction(), so Row-Level Security policies filter every query inside.
 */
export async function withTenant<T>(
  handle: PostgresHandle,
  tenantId: string,
  userId: string | null,
  fn: (tx: PostgresDb) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('flowforge.tenant_id', ${tenantId}, true)`);
    if (userId) {
      await tx.execute(sql`SELECT set_config('flowforge.user_id', ${userId}, true)`);
    }
    return fn(tx);
  });
}
