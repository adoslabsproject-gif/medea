/**
 * Test REAL — customNodeExecutor (skip pattern + sandbox dispatch).
 *
 * Coverage critica (regressione bloccata):
 *  - defId `custom_*` non registrato nel workspace → output { skipped: ... }
 *    (NON throw — l'engine continua, workflow downstream possono branchare).
 *  - durationMs riportato in output anche su skip path.
 *
 * NB: il test "happy path" (esegue executor compilato in isolated-vm)
 * richiederebbe `ivm.Isolate` che e\` un module C++ — copertura demandata
 * a `community-node-sandbox.test.ts` e a runtime-loader.test.ts (cache hit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => { conn.exec(sql); },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

import { customNodeExecutor } from './custom-node.js';
import { invalidateAllCustomNodes } from '@/services/custom-nodes/cache.js';

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  invalidateAllCustomNodes();
});
afterEach(() => {
  invalidateAllCustomNodes();
  dbConnections.pop()?.close();
});

describe('customNodeExecutor — skip pattern (regression blocker)', () => {
  it('defId placeholder "custom_node" non registrato → skipped (NO throw)', async () => {
    const result = await customNodeExecutor(
      { __action: 'noop' },
      { hello: 'world' },
      { tenantId: 'ws-X', runId: 'r1', workflowId: 'wf', nodeId: 'n1', defId: 'custom_node', secrets: {} },
    );
    expect(result.output).toMatchObject({
      skipped: expect.stringContaining('Custom node "custom_node" non disponibile'),
    });
    expect(typeof result.durationMs).toBe('number');
  });

  it('defId draft (status=draft) → skipped (loader filtra non-runnable)', async () => {
    const conn = dbConnections[0]!;
    const now = new Date().toISOString();
    conn.prepare(`
      INSERT INTO custom_nodes (
        id, workspace_id, owner_user_id, slug, display_name, status, semver,
        source_executor, source_definition, source_schema, compiled_executor,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'id-1', 'ws-X', 'owner', 'wip_node', 'WIP', 'draft', '0.1.0',
      'x', 'x', 'x', '(function(){})()', now, now,
    );
    const result = await customNodeExecutor(
      {}, {},
      { tenantId: 'ws-X', runId: 'r1', workflowId: 'wf', nodeId: 'n1', defId: 'custom_wip_node', secrets: {} },
    );
    expect(result.output).toMatchObject({
      skipped: expect.stringContaining('non disponibile'),
    });
  });

  it('defId malformato (es. lettere maiuscole) → skipped', async () => {
    const result = await customNodeExecutor(
      {}, {},
      { tenantId: 'ws-X', runId: 'r1', workflowId: 'wf', nodeId: 'n1', defId: 'custom_Foo', secrets: {} },
    );
    expect(result.output).toMatchObject({ skipped: expect.stringContaining('non disponibile') });
  });

  it('defId vuoto → skipped (no crash)', async () => {
    const result = await customNodeExecutor(
      {}, {},
      { tenantId: 'ws-X', runId: 'r1', workflowId: 'wf', nodeId: 'n1', defId: '', secrets: {} },
    );
    expect(result.output).toMatchObject({ skipped: expect.any(String) });
  });
});
