/**
 * MongoDB adapter — uses tables-as-collections semantics.
 * MongoDB is schema-less, so previewMigration emits a JSON describing the
 * intent (FlowForge stores it as catalog metadata for visualisation),
 * and applyMigration creates collections with $jsonSchema validators
 * for write-time validation.
 */

import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import type { Column, Database, MigrationAction, QueryFilter, QuerySpec, Table } from '@medea/engine-db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult } from '@medea/engine-db-studio-engine';

const TYPE_TO_BSON: Record<Column['type'], string> = {
  text: 'string',
  varchar: 'string',
  integer: 'int',
  bigint: 'long',
  decimal: 'decimal',
  real: 'double',
  boolean: 'bool',
  date: 'date',
  time: 'string',
  datetime: 'date',
  json: 'object',
  uuid: 'string',
  bytea: 'binData',
  enum: 'string',
};

function columnToJsonSchema(col: Column): Record<string, unknown> {
  const prop: Record<string, unknown> = { bsonType: TYPE_TO_BSON[col.type] };
  if (col.description) prop.description = col.description;
  return prop;
}

function filterToMongoQuery(filters: readonly QueryFilter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of filters) {
    switch (f.op) {
      case 'eq': out[f.column] = f.value; break;
      case 'neq': out[f.column] = { $ne: f.value }; break;
      case 'gt': out[f.column] = { $gt: f.value }; break;
      case 'gte': out[f.column] = { $gte: f.value }; break;
      case 'lt': out[f.column] = { $lt: f.value }; break;
      case 'lte': out[f.column] = { $lte: f.value }; break;
      case 'like': out[f.column] = { $regex: String(f.value), $options: 'i' }; break;
      case 'isNull': out[f.column] = null; break;
      case 'notNull': out[f.column] = { $ne: null }; break;
      case 'in': out[f.column] = { $in: Array.isArray(f.value) ? f.value : [f.value] }; break;
    }
  }
  return out;
}

export class MongoDbAdapter implements IDatabaseAdapter {
  readonly engine = 'mongodb' as const;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  async connect(database: Database): Promise<void> {
    const conn = database.connection;
    const url = conn.url ?? `mongodb://${conn.username ?? ''}:${conn.passwordSecretRef ?? ''}@${conn.hostname ?? 'localhost'}:${(conn.port ?? 27017).toString()}/${conn.database ?? ''}`;
    this.client = new MongoClient(url);
    await this.client.connect();
    this.db = this.client.db(conn.database);
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.db = null;
  }

  private requireDb(): Db {
    if (!this.db) throw new Error('MongoDbAdapter not connected');
    return this.db;
  }

  previewMigration(actions: readonly MigrationAction[]): Promise<string> {
    const lines: string[] = [];
    for (const a of actions) {
      if (a.kind === 'create_table') {
        const schema = {
          $jsonSchema: {
            bsonType: 'object',
            properties: Object.fromEntries(a.table.columns.map((c) => [c.name, columnToJsonSchema(c)])),
            required: a.table.columns.filter((c) => !c.constraints.nullable).map((c) => c.name),
          },
        };
        lines.push(`// createCollection("${a.table.name}", { validator: ${JSON.stringify(schema, null, 2)} })`);
      } else if (a.kind === 'drop_table') {
        lines.push(`// db.${a.tableName}.drop()`);
      } else if (a.kind === 'add_index') {
        lines.push(`// db.${a.tableName}.createIndex({ ${a.index.columns.map((c) => `"${c}": 1`).join(', ')} }, { unique: ${String(a.index.unique)} })`);
      } else {
        lines.push(`// no-op on Mongo: ${a.kind}`);
      }
    }
    return Promise.resolve(lines.join('\n'));
  }

  async applyMigration(actions: readonly MigrationAction[]): Promise<{ sql: string; affectedTables: string[] }> {
    const db = this.requireDb();
    const affected = new Set<string>();
    for (const a of actions) {
      if (a.kind === 'create_table') {
        const schema = {
          $jsonSchema: {
            bsonType: 'object',
            properties: Object.fromEntries(a.table.columns.map((c) => [c.name, columnToJsonSchema(c)])),
            required: a.table.columns.filter((c) => !c.constraints.nullable).map((c) => c.name),
          },
        };
        const exists = await db.listCollections({ name: a.table.name }).toArray();
        if (exists.length === 0) {
          await db.createCollection(a.table.name, { validator: schema });
        }
        affected.add(a.table.name);
      } else if (a.kind === 'drop_table') {
        await db.collection(a.tableName).drop().catch(() => undefined);
        affected.add(a.tableName);
      } else if (a.kind === 'add_index') {
        const spec: Record<string, 1> = {};
        for (const c of a.index.columns) spec[c] = 1;
        await db.collection(a.tableName).createIndex(spec, { unique: a.index.unique, name: a.index.name });
        affected.add(a.tableName);
      } else if (a.kind === 'drop_index') {
        await db.collection(a.tableName).dropIndex(a.indexName).catch(() => undefined);
        affected.add(a.tableName);
      }
    }
    return { sql: await this.previewMigration(actions), affectedTables: [...affected] };
  }

  async query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>> {
    const db = this.requireDb();
    const start = Date.now();
    const coll: Collection = db.collection(spec.table);
    let cursor = coll.find(filterToMongoQuery(spec.filters ?? []));
    if (spec.orderBy && spec.orderBy.length > 0) {
      const sort: Record<string, 1 | -1> = {};
      for (const o of spec.orderBy) sort[o.column] = o.direction === 'desc' ? -1 : 1;
      cursor = cursor.sort(sort);
    }
    if (spec.offset !== undefined) cursor = cursor.skip(spec.offset);
    if (spec.limit !== undefined) cursor = cursor.limit(spec.limit);
    const rows = await cursor.toArray();
    return { rows: rows as unknown as T[], rowCount: rows.length, durationMs: Date.now() - start };
  }

  async insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const db = this.requireDb();
    const start = Date.now();
    const result = await db.collection(tableName).insertOne(row);
    return { affectedRows: 1, insertedId: result.insertedId.toString(), durationMs: Date.now() - start };
  }

  async update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const db = this.requireDb();
    const start = Date.now();
    const filter = where._id && typeof where._id === 'string' ? { ...where, _id: new ObjectId(where._id) } : where;
    const result = await db.collection(tableName).updateMany(filter, { $set: patch });
    return { affectedRows: result.modifiedCount, durationMs: Date.now() - start };
  }

  async delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const db = this.requireDb();
    const start = Date.now();
    const filter = where._id && typeof where._id === 'string' ? { ...where, _id: new ObjectId(where._id) } : where;
    const result = await db.collection(tableName).deleteMany(filter);
    return { affectedRows: result.deletedCount, durationMs: Date.now() - start };
  }

  async introspect(): Promise<Table[]> {
    const db = this.requireDb();
    const collections = await db.listCollections().toArray();
    return collections.map((c) => ({
      id: c.name,
      name: c.name,
      columns: [{ id: '_id', name: '_id', type: 'text' as const, constraints: { primaryKey: true, nullable: false, unique: true } }],
      indexes: [],
    }));
  }
}
