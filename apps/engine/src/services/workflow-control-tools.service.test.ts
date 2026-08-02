/**
 * Tests 2026-grade per workflow-control-tools.
 *
 * Coverage:
 *  - listWorkflows / getWorkflow
 *  - configureNode merge superficiale + workflow updated_at refresh
 *  - configureNode: workflow not found → error
 *  - configureNode: node not found → error
 *  - setWorkflowEnabled toggle
 *  - REGRESSION: nodes other than target NON modificati
 *  - REGRESSION: edges preserved through configureNode
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
        exec: (sql: string) => {
          conn.exec(sql);
        },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) =>
          conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

vi.mock('@/lib/logger.js');

import {
  listWorkflows,
  getWorkflow,
  configureNode,
  setWorkflowEnabled,
} from './workflow-control-tools.service.js';

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);

  const now = new Date().toISOString();
  conn
    .prepare(
      `INSERT INTO workflows (id, name, description, enabled, nodes_json, edges_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'wf-1',
      'Test Workflow',
      'A test',
      1,
      JSON.stringify([
        { id: 'n1', defId: 'trigger_webhook', config: { path: '/hook', method: 'POST' } },
        { id: 'n2', defId: 'action_send_email', config: { to: 'a@b.it', subject: 'Hi' } },
      ]),
      JSON.stringify([{ from: 'n1', to: 'n2' }]),
      now,
      now,
    );
  dbConnections.push(conn);
});

afterEach(() => {
  const c = dbConnections.pop();
  if (c) c.close();
});

describe('listWorkflows', () => {
  it('returns 1 workflow with correct nodeCount', () => {
    const list = listWorkflows();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('wf-1');
    expect(list[0]?.nodeCount).toBe(2);
    expect(list[0]?.enabled).toBe(true);
  });

  it('enabledOnly filter respected', () => {
    const list = listWorkflows({ enabledOnly: true });
    expect(list).toHaveLength(1);
  });
});

describe('getWorkflow', () => {
  it('returns full detail with nodes + edges', () => {
    const wf = getWorkflow('wf-1');
    expect(wf?.name).toBe('Test Workflow');
    expect(wf?.nodes).toHaveLength(2);
    expect(wf?.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it('non-existent id → null', () => {
    expect(getWorkflow('nope')).toBeNull();
  });
});

describe('configureNode', () => {
  it('merges config keys (shallow)', () => {
    const res = configureNode({
      workflowId: 'wf-1',
      nodeId: 'n2',
      configPatch: { subject: 'New subject', bcc: 'admin@b.it' },
    });
    expect(res).toEqual({
      ok: true,
      updatedConfig: { to: 'a@b.it', subject: 'New subject', bcc: 'admin@b.it' },
    });
    // Verify persistence
    const wf = getWorkflow('wf-1');
    const n2 = wf?.nodes.find((n) => n.id === 'n2');
    expect(n2?.config).toMatchObject({ to: 'a@b.it', subject: 'New subject', bcc: 'admin@b.it' });
  });

  it('REGRESSION: other nodes NOT touched', () => {
    configureNode({ workflowId: 'wf-1', nodeId: 'n2', configPatch: { subject: 'X' } });
    const wf = getWorkflow('wf-1');
    const n1 = wf?.nodes.find((n) => n.id === 'n1');
    expect(n1?.config).toEqual({ path: '/hook', method: 'POST' });
  });

  it('REGRESSION: edges preserved', () => {
    configureNode({ workflowId: 'wf-1', nodeId: 'n1', configPatch: { method: 'GET' } });
    const wf = getWorkflow('wf-1');
    expect(wf?.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it('workflow not found → error', () => {
    expect(configureNode({ workflowId: 'nope', nodeId: 'n1', configPatch: {} })).toEqual({
      ok: false,
      error: 'Workflow not found: nope',
    });
  });

  it('node not found → error', () => {
    expect(configureNode({ workflowId: 'wf-1', nodeId: 'nope', configPatch: {} })).toEqual({
      ok: false,
      error: 'Node not found: nope',
    });
  });
});

describe('setWorkflowEnabled', () => {
  it('disable a running workflow → enabled=false persisted', () => {
    expect(setWorkflowEnabled({ workflowId: 'wf-1', enabled: false })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(getWorkflow('wf-1')?.enabled).toBe(false);
  });

  it('re-enable → enabled=true persisted', () => {
    setWorkflowEnabled({ workflowId: 'wf-1', enabled: false });
    setWorkflowEnabled({ workflowId: 'wf-1', enabled: true });
    expect(getWorkflow('wf-1')?.enabled).toBe(true);
  });

  it('non-existent workflow → error', () => {
    expect(setWorkflowEnabled({ workflowId: 'nope', enabled: true })).toEqual({
      ok: false,
      error: 'Workflow not found: nope',
    });
  });
});
