/**
 * Global runs history endpoint — list across all workflows in the tenant.
 * Supports filter by status, workflowId, date range.
 *
 * Also exposes the AI explain & fix endpoint for failed/partial runs.
 */

import { Hono } from 'hono';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import {
  aiExplainService,
  RunNotFoundError,
  RunSucceededError,
  NoFailedStepError,
  LlmResponseError,
  NoLlmProviderError,
} from '@/services/ai-explain.service.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import type { IEventBus } from '@/ports/event-bus.js';

interface RunRow {
  id: string;
  workflow_id: string;
  tenant_id: string;
  status: string;
  trigger_type: string | null;
  input: string;
  error_count: number;
  total_duration_ms: number | null;
  started_at: string;
  ended_at: string | null;
}

export function createRunHistoryRoutes(eventBus?: IEventBus): Hono {
  const app = new Hono();

  app.get('/runs', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const tenantId = getTenantId(c);
    // Vista cross-tenant per superadmin SENZA impersonate (Federico-grade):
    // stesso pattern di /dashboard/workflows. Senza header `x-tenant-id`,
    // il superadmin vede TUTTI i run del server con campo `tenantId` per
    // ogni riga, così la UI può raggruppare/filtrare.
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const status = c.req.query('status');
    const workflowId = c.req.query('workflowId');
    const since = c.req.query('since');
    // Paginazione: limit cappato a 250 (allineato col selettore frontend).
    // Default 25, offset default 0. Restituiamo anche il totalCount via
    // COUNT(*) separata così la UI può mostrare "Pagina X di Y".
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25), 1), 250);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

    const { sqlite } = getDatabase();
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (!isCrossTenant) {
      conditions.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (workflowId) {
      conditions.push('workflow_id = ?');
      params.push(workflowId);
    }
    if (since) {
      conditions.push('started_at >= ?');
      params.push(since);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // COUNT totale (su params SENZA limit/offset)
    const totalCount = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM runs ${whereSql}`).get(...params) as { c: number }
    ).c;

    const rowsParams = [...params, limit, offset];
    const rows = sqlite
      .prepare(
        `SELECT id, workflow_id, tenant_id, status, trigger_type, input, error_count, total_duration_ms, started_at, ended_at
         FROM runs
         ${whereSql}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...rowsParams) as RunRow[];

    return c.json({
      runs: rows.map((r) => ({
        id: r.id,
        workflowId: r.workflow_id,
        tenantId: r.tenant_id,
        status: r.status,
        triggerType: r.trigger_type,
        input: r.input,
        errorCount: r.error_count,
        totalDurationMs: r.total_duration_ms,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
      total: rows.length,
      totalCount,
      limit,
      offset,
      crossTenant: isCrossTenant,
    });
  });

  /**
   * DELETE /runs/:runId — eliminazione SICURA di un singolo run.
   * Tenant-isolated: il record viene cancellato SOLO se appartiene al
   * tenant del caller. Restituisce 404 anche per record di altri tenant
   * (no information disclosure). Operazione idempotente.
   */
  /**
   * POST /runs/bulk-delete — eliminazione massiva di N run in una sola
   * call. Stesso pattern di tenant scope di /runs:DELETE.
   * Body: { ids: string[] }
   * Restituisce: { deleted: number, skipped: number, ids: string[] }
   * Limit 1000 per call per evitare query mostruose.
   */
  app.post('/runs/bulk-delete', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const tenantId = getTenantId(c);
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;

    let body: { ids?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Bad JSON body' }, 400);
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    if (ids.length === 0) return c.json({ error: 'Lista "ids" vuota o mancante' }, 400);
    if (ids.length > 1000) return c.json({ error: 'Massimo 1000 run per call' }, 400);

    const { sqlite } = getDatabase();
    const placeholders = ids.map(() => '?').join(',');
    // Recupera prima i workflow_id + tenant_id per emit eventi mirati
    const foundRows = (
      isCrossTenant
        ? sqlite
            .prepare(`SELECT id, workflow_id, tenant_id FROM runs WHERE id IN (${placeholders})`)
            .all(...ids)
        : sqlite
            .prepare(
              `SELECT id, workflow_id, tenant_id FROM runs WHERE tenant_id = ? AND id IN (${placeholders})`,
            )
            .all(tenantId, ...ids)
    ) as { id: string; workflow_id: string; tenant_id: string }[];

    const result = isCrossTenant
      ? sqlite.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...ids)
      : sqlite
          .prepare(`DELETE FROM runs WHERE tenant_id = ? AND id IN (${placeholders})`)
          .run(tenantId, ...ids);
    const deleted = Number(result.changes);
    const skipped = ids.length - deleted;

    // Emit run.deleted per ogni run (la Dashboard live ripulisce locale +
    // refetcha snapshot). Limitiamo emit a 100 per evitare flood.
    if (eventBus) {
      const toEmit = foundRows.slice(0, 100);
      for (const r of toEmit) {
        eventBus.emit({
          name: 'run.deleted',
          tenantId: r.tenant_id,
          data: { runId: r.id, workflowId: r.workflow_id },
          ts: new Date().toISOString(),
        });
      }
    }
    logger.info(
      { tenantId, actor: auth?.role, deleted, skipped, requested: ids.length },
      'Bulk run delete',
    );
    return c.json({ deleted, skipped, requested: ids.length });
  });

  app.delete('/runs/:runId', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const tenantId = getTenantId(c);
    const runId = c.req.param('runId');
    if (!runId) return c.json({ error: 'Bad request' }, 400);
    // Vista cross-tenant: il superadmin senza impersonate può cancellare
    // QUALSIASI run del server (è l'operatore del server, ha bisogno di
    // questo potere). L'azione resta audit-loggata per accountability.
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;
    const { sqlite } = getDatabase();
    const found = (
      isCrossTenant
        ? sqlite.prepare('SELECT workflow_id, tenant_id FROM runs WHERE id = ?').get(runId)
        : sqlite
            .prepare('SELECT workflow_id, tenant_id FROM runs WHERE tenant_id = ? AND id = ?')
            .get(tenantId, runId)
    ) as { workflow_id: string; tenant_id: string } | undefined;
    const r = isCrossTenant
      ? sqlite.prepare('DELETE FROM runs WHERE id = ?').run(runId)
      : sqlite.prepare('DELETE FROM runs WHERE tenant_id = ? AND id = ?').run(tenantId, runId);
    if (r.changes === 0) return c.json({ error: 'Not found' }, 404);
    // Notifica SSE: la Dashboard live deve scartare il run cancellato
    // dal proprio snapshot locale + refetchare lastRun + recentRuns.
    // Senza questo evento, la Dashboard mostrerebbe ancora lo stato
    // del run cancellato finché l'utente non fa reload manuale.
    if (eventBus) {
      // Emit con il tenant REALE del run (importante in vista cross-tenant:
      // il superadmin può cancellare run di tenant diversi dal suo; l'evento
      // deve riportare il tenant reale per il filtering SSE corretto).
      eventBus.emit({
        name: 'run.deleted',
        tenantId: found?.tenant_id ?? tenantId,
        data: { runId, workflowId: found?.workflow_id ?? null },
        ts: new Date().toISOString(),
      });
    }
    return c.json({ ok: true, deleted: runId });
  });

  // ── Fase 3 (#15): cancellazione log AI (prompt/risposta) per run o nodo ──
  // I log `source:'llm'` contengono il prompt COMPLETO (system incluso) e la
  // risposta: l'utente può volerli eliminare (dati sensibili nel prompt).
  // Rimozione MIRATA dalle entry dello step (mai l'intero run) + marker onesto
  // "log AI cancellati" al posto loro — la cancellazione non è silenziosa.
  app.delete('/runs/:runId/ai-logs', (c) => {
    const tenantId = getTenantId(c);
    const runId = c.req.param('runId');
    const nodeId = c.req.query('nodeId') ?? null;
    if (!runId) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT steps_json FROM runs WHERE tenant_id = ? AND id = ?')
      .get(tenantId, runId) as { steps_json: string } | undefined;
    if (!row) return c.json({ error: 'Not found' }, 404);

    interface StepWithLogs {
      nodeId?: string;
      logs?: { source?: string }[];
      logsTotal?: number;
      [k: string]: unknown;
    }
    let steps: StepWithLogs[];
    try {
      const parsed: unknown = JSON.parse(row.steps_json);
      steps = Array.isArray(parsed) ? (parsed as StepWithLogs[]) : [];
    } catch {
      return c.json({ error: 'run record corrotto (steps_json non parseabile)' }, 500);
    }

    let removed = 0;
    for (const step of steps) {
      if (nodeId !== null && step.nodeId !== nodeId) continue;
      if (!Array.isArray(step.logs)) continue;
      const before = step.logs.length;
      const kept = step.logs.filter((l) => l.source !== 'llm');
      const stripped = before - kept.length;
      if (stripped === 0) continue;
      removed += stripped;
      kept.push({
        ts: new Date().toISOString(),
        seq: before + 1,
        level: 'info',
        source: 'engine',
        msg: `${String(stripped)} log AI (prompt/risposta) cancellati dall'utente`,
      } as unknown as { source?: string });
      step.logs = kept;
      if (typeof step.logsTotal === 'number') step.logsTotal = kept.length;
    }
    if (removed === 0) return c.json({ ok: true, removed: 0 });

    sqlite
      .prepare('UPDATE runs SET steps_json = ? WHERE tenant_id = ? AND id = ?')
      .run(JSON.stringify(steps), tenantId, runId);
    logger.info({ runId, nodeId, removed, tenantId }, 'AI logs deleted from run record');
    return c.json({ ok: true, removed, ...(nodeId !== null ? { nodeId } : {}) });
  });

  app.get('/runs/:runId', (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    const tenantId = getTenantId(c);
    const runId = c.req.param('runId');
    if (!runId) return c.json({ error: 'Bad request' }, 400);
    // Vista cross-tenant: stesso pattern di GET /runs. Il superadmin
    // senza impersonate può aprire il dettaglio di QUALSIASI run del
    // server. Una volta impersonato un tenant, resta confinato.
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth?.role === 'superadmin' && !impersonateHeader;

    const { sqlite } = getDatabase();
    const row = (
      isCrossTenant
        ? sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
        : sqlite.prepare('SELECT * FROM runs WHERE tenant_id = ? AND id = ?').get(tenantId, runId)
    ) as (RunRow & { steps_json: string }) | undefined;
    if (!row) return c.json({ error: 'Not found' }, 404);

    let steps: unknown = [];
    try {
      steps = JSON.parse(row.steps_json);
    } catch {
      steps = [];
    }
    return c.json({
      run: {
        id: row.id,
        workflowId: row.workflow_id,
        status: row.status,
        triggerType: row.trigger_type,
        input: row.input,
        errorCount: row.error_count,
        totalDurationMs: row.total_duration_ms,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        steps,
      },
    });
  });

  // POST /runs/:runId/ai-explain — thin HTTP wrapper over AiExplainService.
  // Business logic (prompt build, LLM dispatch, validation, capture) lives
  // in services/ai-explain.service.ts.
  app.post('/runs/:runId/ai-explain', llmRateLimit('run-explain'), async (c) => {
    const tenantId = getTenantId(c);
    const userIdHeader = c.req.header('x-user-id');
    const runId = c.req.param('runId');
    if (!runId) return c.json({ error: 'Bad request' }, 400);

    try {
      const result = await aiExplainService.explain({
        tenantId,
        runId,
        ...(userIdHeader ? { userId: userIdHeader } : {}),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof RunNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof RunSucceededError || err instanceof NoFailedStepError)
        return c.json({ error: err.message }, 400);
      if (err instanceof NoLlmProviderError) return c.json({ error: err.message }, err.httpStatus);
      if (err instanceof LlmResponseError) return c.json({ error: err.message, raw: err.raw }, 502);
      logger.error({ err, runId, tenantId }, 'AI explain failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
