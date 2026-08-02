/**
 * Pin data service — store mock outputs per (workflow, node).
 * When a pin exists for a node, the engine returns the pin instead of executing.
 *
 * This is the same UX as n8n's "pin data" — invaluable for iterative
 * development against slow/expensive upstream calls.
 */

import { getDatabase } from '@/storage/db.js';

interface PinRow {
  workflow_id: string;
  node_id: string;
  tenant_id: string;
  output_json: string;
  enabled: number;
  updated_at: string;
}

function ensurePinsTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_pins (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      output_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workflow_id, node_id)
    );
  `);
}

export class PinService {
  constructor() {
    ensurePinsTable();
  }

  list(
    workflowId: string,
    tenantId = 'default',
  ): { nodeId: string; output: unknown; enabled: boolean; updatedAt: string }[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT * FROM workflow_pins WHERE tenant_id = ? AND workflow_id = ? ORDER BY node_id',
      )
      .all(tenantId, workflowId) as PinRow[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      output: JSON.parse(r.output_json) as unknown,
      enabled: r.enabled === 1,
      updatedAt: r.updated_at,
    }));
  }

  set(
    workflowId: string,
    nodeId: string,
    output: unknown,
    enabled = true,
    tenantId = 'default',
  ): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO workflow_pins (workflow_id, node_id, tenant_id, output_json, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, workflow_id, node_id) DO UPDATE SET output_json = excluded.output_json, enabled = excluded.enabled, updated_at = excluded.updated_at',
      )
      .run(
        workflowId,
        nodeId,
        tenantId,
        JSON.stringify(output),
        enabled ? 1 : 0,
        new Date().toISOString(),
      );
  }

  delete(workflowId: string, nodeId: string, tenantId = 'default'): boolean {
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM workflow_pins WHERE tenant_id = ? AND workflow_id = ? AND node_id = ?')
      .run(tenantId, workflowId, nodeId);
    return info.changes > 0;
  }

  /** Single-row lookup — returns null when no pin exists for the (workflow, node) pair. */
  get(
    workflowId: string,
    nodeId: string,
    tenantId = 'default',
  ): { output: unknown; enabled: boolean; updatedAt: string } | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        'SELECT output_json, enabled, updated_at FROM workflow_pins WHERE tenant_id = ? AND workflow_id = ? AND node_id = ?',
      )
      .get(tenantId, workflowId, nodeId) as
      | { output_json: string; enabled: number; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      output: JSON.parse(row.output_json) as unknown,
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    };
  }

  getEnabledMap(workflowId: string, tenantId = 'default'): Map<string, unknown> {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT node_id, output_json FROM workflow_pins WHERE tenant_id = ? AND workflow_id = ? AND enabled = 1',
      )
      .all(tenantId, workflowId) as { node_id: string; output_json: string }[];
    const out = new Map<string, unknown>();
    for (const r of rows) {
      out.set(r.node_id, JSON.parse(r.output_json) as unknown);
    }
    return out;
  }
}
