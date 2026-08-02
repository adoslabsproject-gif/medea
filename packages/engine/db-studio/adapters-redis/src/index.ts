/**
 * Redis adapter — KV semantics. The "table" concept maps to a key prefix.
 * Each row is stored as a Hash under `<prefix>:<id>`.
 * Query/filter is limited: SCAN over prefix + decode JSON; filters apply in JS.
 */

import { Redis } from 'ioredis';
import type { Database, MigrationAction, QueryFilter, QuerySpec, Table } from '@medea/engine-db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult } from '@medea/engine-db-studio-engine';

/** Coercizione sicura unknown→string per chiavi/sort (mai "[object Object]"). */
function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return ''; }
}

function matchFilter(row: Record<string, unknown>, filters: readonly QueryFilter[]): boolean {
  for (const f of filters) {
    const v = row[f.column];
    switch (f.op) {
      case 'eq': if (v !== f.value) return false; break;
      case 'neq': if (v === f.value) return false; break;
      case 'gt': if (!((v as number | string) > (f.value as number | string))) return false; break;
      case 'gte': if (!((v as number | string) >= (f.value as number | string))) return false; break;
      case 'lt': if (!((v as number | string) < (f.value as number | string))) return false; break;
      case 'lte': if (!((v as number | string) <= (f.value as number | string))) return false; break;
      case 'like': if (typeof v !== 'string' || !v.includes(String(f.value))) return false; break;
      case 'isNull': if (v !== null && v !== undefined) return false; break;
      case 'notNull': if (v === null || v === undefined) return false; break;
      case 'in': {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (!arr.includes(v)) return false;
        break;
      }
    }
  }
  return true;
}

export class RedisAdapter implements IDatabaseAdapter {
  readonly engine = 'redis' as const;
  private client: Redis | null = null;

  async connect(database: Database): Promise<void> {
    const conn = database.connection;
    this.client = new Redis({
      host: conn.hostname ?? 'localhost',
      port: conn.port ?? 6379,
      password: conn.passwordSecretRef,
      maxRetriesPerRequest: 3,
    });
    await this.client.ping();
  }

  async disconnect(): Promise<void> {
    await this.client?.quit();
    this.client = null;
  }

  private requireClient(): Redis {
    if (!this.client) throw new Error('RedisAdapter not connected');
    return this.client;
  }

  previewMigration(_actions: readonly MigrationAction[]): Promise<string> {
    return Promise.resolve('// Redis is schema-less. Migrations are no-ops; key prefixes are created implicitly on first write.');
  }

  applyMigration(actions: readonly MigrationAction[]): Promise<{ sql: string; affectedTables: string[] }> {
    const affected = new Set<string>();
    for (const a of actions) {
      if (a.kind === 'create_table') affected.add(a.table.name);
      else if (a.kind === 'drop_table') affected.add(a.tableName);
    }
    return Promise.resolve({ sql: '// no-op', affectedTables: [...affected] });
  }

  async query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>> {
    const client = this.requireClient();
    const start = Date.now();
    const pattern = `${spec.table}:*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', '500');
      cursor = next;
      keys.push(...batch);
      if (keys.length > 10_000) break;
    } while (cursor !== '0');

    const rows: Record<string, unknown>[] = [];
    const pipeline = client.pipeline();
    for (const k of keys) pipeline.hgetall(k);
    const results = await pipeline.exec();
    for (const [err, val] of results ?? []) {
      if (err) continue;
      rows.push(val as Record<string, unknown>);
    }
    const filtered = rows.filter((r) => matchFilter(r, spec.filters ?? []));
    const sorted = spec.orderBy?.[0]
      ? filtered.sort((a, b) => {
          const col = spec.orderBy?.[0]?.column ?? '';
          const dir = spec.orderBy?.[0]?.direction === 'desc' ? -1 : 1;
          return toStr(a[col]).localeCompare(toStr(b[col])) * dir;
        })
      : filtered;
    const offset = spec.offset ?? 0;
    const limit = spec.limit ?? sorted.length;
    return { rows: sorted.slice(offset, offset + limit) as T[], rowCount: sorted.length, durationMs: Date.now() - start };
  }

  async insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const client = this.requireClient();
    const start = Date.now();
    const id = row.id ?? (row._id) ?? crypto.randomUUID();
    const key = `${tableName}:${toStr(id)}`;
    const entries: string[] = [];
    for (const [k, v] of Object.entries(row)) {
      entries.push(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    await client.hset(key, ...entries);
    return { affectedRows: 1, insertedId: toStr(id), durationMs: Date.now() - start };
  }

  async update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const client = this.requireClient();
    const start = Date.now();
    const id = where.id ?? where._id;
    if (!id) throw new Error('Redis update: where must include id (or _id)');
    const key = `${tableName}:${toStr(id)}`;
    const entries: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      entries.push(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    await client.hset(key, ...entries);
    return { affectedRows: 1, durationMs: Date.now() - start };
  }

  async delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const client = this.requireClient();
    const start = Date.now();
    const id = where.id ?? where._id;
    if (!id) throw new Error('Redis delete: where must include id (or _id)');
    const removed = await client.del(`${tableName}:${toStr(id)}`);
    return { affectedRows: removed, durationMs: Date.now() - start };
  }

  introspect(): Promise<Table[]> {
    // Without conventions Redis has no introspection. Return empty.
    return Promise.resolve([]);
  }
}
