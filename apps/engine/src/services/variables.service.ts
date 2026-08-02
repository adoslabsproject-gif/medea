/**
 * Workflow-level variables. Mutable state that persists across runs.
 * Variables can be read/written from any node via the interpreter scope
 * as `vars.<name>`.
 *
 * Storage: KV table per (tenant_id, workflow_id, name). Values are JSON.
 */

import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from './audit.service.js';

const audit = new AuditLogService();

function ensureVariablesTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_variables (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (tenant_id, workflow_id, name)
    );
    CREATE INDEX IF NOT EXISTS workflow_variables_workflow_idx ON workflow_variables(workflow_id);
  `);
}

interface VariableRow {
  tenant_id: string;
  workflow_id: string;
  name: string;
  value_json: string;
  updated_at: string;
  updated_by: string | null;
}

export class VariablesService {
  constructor() {
    ensureVariablesTable();
  }

  list(workflowId: string, tenantId = 'default'): Record<string, unknown> {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM workflow_variables WHERE tenant_id = ? AND workflow_id = ?')
      .all(tenantId, workflowId) as VariableRow[];
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.name] = JSON.parse(row.value_json) as unknown;
      } catch {
        result[row.name] = row.value_json;
      }
    }
    return result;
  }

  get(workflowId: string, name: string, tenantId = 'default'): unknown {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        'SELECT * FROM workflow_variables WHERE tenant_id = ? AND workflow_id = ? AND name = ?',
      )
      .get(tenantId, workflowId, name) as VariableRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return row.value_json;
    }
  }

  async set(
    workflowId: string,
    name: string,
    value: unknown,
    tenantId = 'default',
    actorId?: string,
  ): Promise<void> {
    const { sqlite } = getDatabase();
    const valueJson = JSON.stringify(value);
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'INSERT INTO workflow_variables (tenant_id, workflow_id, name, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, workflow_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(tenantId, workflowId, name, valueJson, now, actorId ?? null);

    await audit.append({
      tenantId,
      action: 'variable.set',
      resourceType: 'workflow_variable',
      resourceId: `${workflowId}.${name}`,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { workflowId, name },
    });
  }

  async delete(
    workflowId: string,
    name: string,
    tenantId = 'default',
    actorId?: string,
  ): Promise<boolean> {
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare(
        'DELETE FROM workflow_variables WHERE tenant_id = ? AND workflow_id = ? AND name = ?',
      )
      .run(tenantId, workflowId, name);
    if (info.changes === 0) return false;

    await audit.append({
      tenantId,
      action: 'variable.delete',
      resourceType: 'workflow_variable',
      resourceId: `${workflowId}.${name}`,
      ...(actorId !== undefined ? { actorId } : {}),
    });
    return true;
  }
}
