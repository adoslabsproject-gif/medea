import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgresAdapter, buildPostgresUrl } from './index.js';
import type { Database } from '@medea/engine-db-studio-core';

const conn = (over: Partial<Database['connection']>): Database['connection'] => ({
  engine: 'postgres',
  embedded: false,
  ...over,
});

describe('buildPostgresUrl — include la password (FIX 2026-06-14)', () => {
  it('hostname+port+db+user+password → url con :password@ (auth funzionante)', () => {
    const url = buildPostgresUrl(
      conn({
        hostname: 'ff-db-postgres-x',
        port: 5432,
        database: 'tenant_db',
        username: 'ff_app',
        passwordSecretRef: 'P4ss-w0rd_~test',
      }),
    );
    expect(url).toBe('postgres://ff_app:P4ss-w0rd_~test@ff-db-postgres-x:5432/tenant_db');
  });
  it('password con caratteri speciali → percent-encoded (no url rotto)', () => {
    const url = buildPostgresUrl(
      conn({
        hostname: 'h',
        port: 5432,
        database: 'd',
        username: 'u',
        passwordSecretRef: 'a@b:c/d?e',
      }),
    );
    expect(url).toContain('u:a%40b%3Ac%2Fd%3Fe@h:');
    expect(url).not.toContain('a@b:c'); // la password grezza non deve comparire
  });
  it('username senza password → solo user@ (back-compat)', () => {
    expect(
      buildPostgresUrl(conn({ hostname: 'h', port: 5432, database: 'd', username: 'u' })),
    ).toBe('postgres://u@h:5432/d');
  });
  it('conn.url esplicito → passthrough', () => {
    expect(buildPostgresUrl(conn({ url: 'postgres://x/y' }))).toBe('postgres://x/y');
  });
  it('senza url né hostname → "" (il caller rigetta)', () => {
    expect(buildPostgresUrl(conn({}))).toBe('');
  });
  it('sslMode → query param', () => {
    expect(
      buildPostgresUrl(
        conn({
          hostname: 'h',
          port: 5432,
          database: 'd',
          username: 'u',
          passwordSecretRef: 'p',
          sslMode: 'require',
        }),
      ),
    ).toContain('?sslmode=require');
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const adapterSource = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

describe('PostgresAdapter', () => {
  it('rejects connect when no URL/hostname provided', async () => {
    const adapter = new PostgresAdapter();
    await expect(
      adapter.connect({
        id: 'd',
        tenantId: 'default',
        name: 'X',
        connection: { engine: 'postgres', embedded: false },
        tables: [],
        relations: [],
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      }),
    ).rejects.toThrow();
  });

  it('renders create_table SQL via previewMigration', async () => {
    const adapter = new PostgresAdapter();
    const preview = await adapter.previewMigration([
      {
        kind: 'create_table',
        table: {
          id: 't1',
          name: 'customers',
          columns: [
            {
              id: 'id',
              name: 'id',
              type: 'uuid',
              constraints: { primaryKey: true, nullable: false, unique: false },
            },
            {
              id: 'email',
              name: 'email',
              type: 'text',
              constraints: { unique: true, nullable: false, primaryKey: false },
            },
          ],
          indexes: [],
        },
      },
    ]);
    expect(preview).toContain('CREATE TABLE IF NOT EXISTS "customers"');
    expect(preview).toContain('"id" UUID PRIMARY KEY NOT NULL');
    expect(preview).toContain('"email" TEXT NOT NULL UNIQUE');
  });

  it('renders rename + drop SQL', async () => {
    const adapter = new PostgresAdapter();
    const preview = await adapter.previewMigration([
      { kind: 'rename_table', from: 'old', to: 'new_name' },
      { kind: 'drop_table', tableName: 'gone' },
    ]);
    expect(preview).toContain('ALTER TABLE "old" RENAME TO "new_name"');
    expect(preview).toContain('DROP TABLE IF EXISTS "gone" CASCADE');
  });

  it('rejects invalid identifiers (SQL injection guard)', async () => {
    const adapter = new PostgresAdapter();
    await expect(
      adapter.previewMigration([{ kind: 'drop_table', tableName: 'drop_me; DROP TABLE users;--' }]),
    ).rejects.toThrow();
  });

  it('renders FK relation SQL', async () => {
    const adapter = new PostgresAdapter();
    const preview = await adapter.previewMigration([
      {
        kind: 'add_relation',
        relation: {
          id: 'r1',
          name: 'fk',
          kind: 'one-to-many',
          fromTable: 'orders',
          fromColumn: 'customer_id',
          toTable: 'customers',
          toColumn: 'id',
          onDelete: 'cascade',
        },
      },
    ]);
    expect(preview).toContain('FOREIGN KEY ("customer_id")');
    expect(preview).toContain('REFERENCES "customers"("id")');
    expect(preview).toContain('ON DELETE CASCADE');
  });
});

describe('PostgresAdapter — N19 audit: executeRaw readOnly gate (source inspection)', () => {
  it('source contains readOnly hard-gate block BEFORE transaction open', () => {
    expect(adapterSource).toMatch(/opts\.readOnly === true/);
  });

  it('source uses classifyStatement per-statement loop for readOnly check', () => {
    // Pattern: loop classifyStatement(stmt) + kind !== 'select' && kind !== 'explain'
    expect(adapterSource).toMatch(
      /kind\s*!==\s*['"]select['"]\s*&&\s*kind\s*!==\s*['"]explain['"]/,
    );
  });

  it('source throws with explicit "readOnly=true" prefix (debug clarity)', () => {
    expect(adapterSource).toMatch(/executeRaw readOnly=true:/);
  });

  it('source throw includes statement index + kind in error msg', () => {
    expect(adapterSource).toMatch(/statement #.*\$\{[\s\S]*?\}.*classified as.*\$\{kind\}/);
  });

  it('readOnly check is INSIDE executeRaw, AFTER splitStatements, BEFORE work() tx run', () => {
    const splitIdx = adapterSource.indexOf('const statements = splitStatements(text);');
    const readOnlyIdx = adapterSource.indexOf('opts.readOnly === true');
    // The executeRaw transaction call is uniquely identified by `work(tx)`.
    const workCallIdx = adapterSource.indexOf('await work(tx);');
    expect(splitIdx).toBeGreaterThan(0);
    expect(readOnlyIdx).toBeGreaterThan(splitIdx);
    expect(workCallIdx).toBeGreaterThan(0);
    expect(readOnlyIdx).toBeLessThan(workCallIdx);
  });
});
