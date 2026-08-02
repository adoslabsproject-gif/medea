/**
 * Tenant-global variables — env-like, accessible across all workflows.
 *
 * Resolved in expressions as {{ env.NAME }} or {{ globals.NAME }}.
 * Storage: separate table `tenant_variables` keyed by (tenant_id, name).
 */

import { getDatabase } from '@/storage/db.js';

interface GlobalVarRow {
  tenant_id: string;
  name: string;
  value_json: string;
  updated_at: string;
}

function ensureTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_variables (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, name)
    );
  `);
}

import type { IGlobalVariableRegistry } from '@/engine/ports.js';

/**
 * SQLite-backed adapter for the engine's IGlobalVariableRegistry port.
 * Provides `$env.KEY` resolution at expression-evaluation time, plus
 * full CRUD for the Settings → Variables UI.
 */
export class GlobalVariablesService implements IGlobalVariableRegistry {
  constructor() {
    ensureTable();
  }

  /**
   * Engine-facing API — returns a flat {KEY: value} map for the tenant.
   * Called once per node execution; cheap (one SELECT, < 1ms typical).
   */
  getEnv(tenantId: string): Record<string, unknown> {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT name, value_json FROM tenant_variables WHERE tenant_id = ?')
      .all(tenantId) as { name: string; value_json: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.name] = JSON.parse(r.value_json) as unknown;
      } catch {
        out[r.name] = r.value_json;
      }
    }
    return out;
  }

  list(tenantId = 'default'): { name: string; value: unknown; updatedAt: string }[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM tenant_variables WHERE tenant_id = ? ORDER BY name')
      .all(tenantId) as GlobalVarRow[];
    return rows.map((r) => ({
      name: r.name,
      value: JSON.parse(r.value_json) as unknown,
      updatedAt: r.updated_at,
    }));
  }

  get(name: string, tenantId = 'default'): unknown {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT value_json FROM tenant_variables WHERE tenant_id = ? AND name = ?')
      .get(tenantId, name) as { value_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value_json) as unknown;
  }

  set(name: string, value: unknown, tenantId = 'default'): void {
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO tenant_variables (tenant_id, name, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      )
      .run(tenantId, name, JSON.stringify(value), new Date().toISOString());
  }

  delete(name: string, tenantId = 'default'): boolean {
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM tenant_variables WHERE tenant_id = ? AND name = ?')
      .run(tenantId, name);
    return info.changes > 0;
  }

  /** Snapshot of all values as Record — used by the engine to inject into expression scope. */
  snapshot(tenantId = 'default'): Record<string, unknown> {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT name, value_json FROM tenant_variables WHERE tenant_id = ?')
      .all(tenantId) as { name: string; value_json: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.name] = JSON.parse(r.value_json) as unknown;
      } catch {
        out[r.name] = r.value_json;
      }
    }
    return out;
  }
}
