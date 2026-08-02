/**
 * Workflow Control Tools — deterministic tool registry per Liara/chat AI
 * per gestire workflow programmaticamente:
 *   • configure_node    — modifica config di un nodo
 *   • run_workflow      — esegue manualmente un workflow
 *   • set_workflow_enabled — attiva/disattiva
 *   • list_workflows    — elenca tutti
 *   • get_workflow      — dettagli + config nodi
 *
 * Usato come tool deterministico dai chat endpoint. NON sostituisce le
 * route REST esistenti — riusa i service interni con audit log.
 *
 * Security: ogni tool richiede tenant context. Container-per-tenant SQLite
 * garantisce isolation (no cross-tenant by infrastructure).
 */

import { getDatabase } from '@/storage/db.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { logger } from '@/lib/logger.js';
import { getLoopbackInternalToken } from '@/lib/internal-token.js';

export interface ConfigureNodeInput {
  workflowId: string;
  nodeId: string;
  configPatch: Record<string, unknown>;
}

export interface RunWorkflowInput {
  workflowId: string;
  triggerInput?: unknown;
}

export interface ToggleWorkflowInput {
  workflowId: string;
  enabled: boolean;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  nodeCount: number;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  nodes: { id: string; defId: string; config: Record<string, unknown> }[];
  edges: { from: string; to: string; fromPort?: string }[];
}

function parseJsonSafe<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Lista workflow del tenant. Filtra eventualmente per `enabledOnly`.
 */
export function listWorkflows(opts: { enabledOnly?: boolean } = {}): WorkflowSummary[] {
  const { sqlite } = getDatabase();
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
  const rows = sqlite
    .prepare(
      `SELECT id, name, description, enabled, nodes_json, updated_at FROM workflows ${where} ORDER BY updated_at DESC LIMIT 200`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    enabled: Boolean(Number(r.enabled ?? 0)),
    nodeCount: parseJsonSafe<unknown[]>(r.nodes_json as string, []).length,
    updatedAt: r.updated_at as string,
  }));
}

/**
 * Dettagli completi di un workflow (per il modello).
 */
export function getWorkflow(workflowId: string): WorkflowDetail | null {
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare(
      `SELECT id, name, description, enabled, nodes_json, edges_json, updated_at FROM workflows WHERE id = ?`,
    )
    .get(workflowId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const nodes = parseJsonSafe<{ id: string; defId: string; config?: Record<string, unknown> }[]>(
    row.nodes_json as string,
    [],
  ).map((n) => ({ id: n.id, defId: n.defId, config: n.config ?? {} }));
  const edges = parseJsonSafe<{ from: string; to: string; fromPort?: string }[]>(
    row.edges_json as string,
    [],
  );
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    enabled: Boolean(Number(row.enabled ?? 0)),
    nodeCount: nodes.length,
    updatedAt: row.updated_at as string,
    nodes,
    edges,
  };
}

/**
 * Modifica config di un nodo. Merge superficiale (nuovi field sostituiscono
 * vecchi). Non valida il config schema — il chiamante deve passare valori
 * conformi al NodeDef.
 */
export function configureNode(
  input: ConfigureNodeInput,
): { ok: true; updatedConfig: Record<string, unknown> } | { ok: false; error: string } {
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare(`SELECT nodes_json FROM workflows WHERE id = ?`)
    .get(input.workflowId) as { nodes_json: string } | undefined;
  if (!row) return { ok: false, error: `Workflow not found: ${input.workflowId}` };
  const nodes = parseJsonSafe<{ id: string; defId: string; config?: Record<string, unknown> }[]>(
    row.nodes_json,
    [],
  );
  const target = nodes.find((n) => n.id === input.nodeId);
  if (!target) return { ok: false, error: `Node not found: ${input.nodeId}` };

  const mergedConfig = { ...(target.config ?? {}), ...input.configPatch };
  target.config = mergedConfig;
  const now = new Date().toISOString();
  sqlite
    .prepare(`UPDATE workflows SET nodes_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(nodes), now, input.workflowId);
  logger.info(
    { workflowId: input.workflowId, nodeId: input.nodeId, keys: Object.keys(input.configPatch) },
    '[workflow-control] node configured',
  );
  return { ok: true, updatedConfig: mergedConfig };
}

/**
 * Attiva/disattiva il workflow (toggle enabled flag).
 */
export function setWorkflowEnabled(
  input: ToggleWorkflowInput,
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  const { sqlite } = getDatabase();
  const row = sqlite.prepare(`SELECT id FROM workflows WHERE id = ?`).get(input.workflowId) as
    | { id: string }
    | undefined;
  if (!row) return { ok: false, error: `Workflow not found: ${input.workflowId}` };
  const now = new Date().toISOString();
  sqlite
    .prepare(`UPDATE workflows SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(input.enabled ? 1 : 0, now, input.workflowId);
  logger.info(
    { workflowId: input.workflowId, enabled: input.enabled },
    '[workflow-control] enabled flag updated',
  );
  return { ok: true, enabled: input.enabled };
}

/**
 * Esegue manualmente un workflow. Dispatch via RunService stesso pattern
 * usato da /runs route. Il run e\` async — ritorna runId immediatamente.
 */
export async function runWorkflow(
  input: RunWorkflowInput,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const wf = getWorkflow(input.workflowId);
  if (!wf) return { ok: false, error: `Workflow not found: ${input.workflowId}` };

  // Loopback al PROPRIO runtime → token interno (single source: internal-token.ts).
  const internalToken = getLoopbackInternalToken();
  const port = process.env.PORT ?? '3100';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify({
        workflowId: input.workflowId,
        triggerType: 'manual',
        triggerPayload: input.triggerInput ?? {},
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text;
      return { ok: false, error: `Run dispatch ${res.status.toString()}: ${txt.slice(0, 200)}` };
    }
    const data = await readJsonCapped<{ runId?: string; id?: string }>(res);
    const runId = data.runId ?? data.id ?? '';
    if (!runId) return { ok: false, error: 'Run created but no id returned' };
    return { ok: true, runId };
  } catch (err) {
    logger.warn(
      { workflowId: input.workflowId, err: err instanceof Error ? err.message : String(err) },
      '[workflow-control] run failed',
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
