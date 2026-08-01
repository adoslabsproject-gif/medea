/**
 * Observability tools — diagnostic per agent.
 *
 * STRICTLY tenant-scoped: ogni WHERE include tenant_id = ?, cross-tenant
 * peeking impossibile da qui. Step OUTPUTS redacted (PII protection).
 *
 * - listRecentRunsHandler:        N run più recenti (no payloads, solo status)
 * - readRunHandler:               singolo run con steps redacted
 * - checkSettingsHealthHandler:   aggregate health-check tenant settings
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

import { coerceString } from '@/lib/coerce.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import type { ToolResult } from '@/services/ai-scaffold/types.js';
import { redactSensitive } from '@/services/ai-scaffold/redact.js';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';
import { CredentialsService } from '@/services/credentials.service.js';
import { LlmProvidersService } from '@/services/llm-providers.service.js';
import { getDatabase } from '@/storage/db.js';

export function listRecentRunsHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const workflowFilter = typeof args.workflowId === 'string' ? args.workflowId : '';
  try {
    const { sqlite } = getDatabase();
    const params: unknown[] = [session.tenantId];
    let sql = 'SELECT id, workflow_id, status, error_count, total_duration_ms, started_at, trigger_type FROM runs WHERE tenant_id = ?';
    if (workflowFilter) {
      sql += ' AND workflow_id = ?';
      params.push(workflowFilter);
    }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(limit);
    const rows = sqlite.prepare(sql).all(...params) as { id: string; workflow_id: string; status: string; error_count: number; total_duration_ms: number; started_at: string; trigger_type: string | null }[];
    return {
      ok: true,
      data: rows.map((r) => ({
        runId: r.id,
        workflowId: r.workflow_id,
        status: r.status,
        errorCount: r.error_count,
        durationMs: r.total_duration_ms,
        startedAt: r.started_at,
        triggerType: r.trigger_type,
      })),
    };
  } catch (e) {
    return { ok: false, error: `list_recent_runs fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function readRunHandler(session: ScaffoldSession, args: Record<string, unknown>): ToolResult {
  const runId = coerceString(args.runId ?? '');
  if (!runId) return { ok: false, error: 'read_run richiede runId.' };
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT id, workflow_id, status, error_count, total_duration_ms, started_at, ended_at, steps_json FROM runs WHERE id = ? AND tenant_id = ? LIMIT 1')
      .get(runId, session.tenantId) as { id: string; workflow_id: string; status: string; error_count: number; total_duration_ms: number; started_at: string; ended_at: string | null; steps_json: string } | undefined;
    if (!row) return { ok: false, error: `Run "${runId}" non trovato (o non appartiene al tenant).` };
    let steps: Record<string, unknown>[] = [];
    try { steps = JSON.parse(row.steps_json) as Record<string, unknown>[]; } catch { steps = []; }
    // Redact step outputs — keep only diagnostic info.
    const redactedSteps = steps.map((s) => ({
      nodeId: s.nodeId,
      defId: s.defId,
      status: s.status,
      durationMs: s.durationMs,
      error: redactSensitive(s.error),
    }));
    return {
      ok: true,
      data: {
        runId: row.id,
        workflowId: row.workflow_id,
        status: row.status,
        errorCount: row.error_count,
        durationMs: row.total_duration_ms,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        steps: redactedSteps,
        note: 'Step outputs omessi per protezione PII — usa l\'UI Run Inspector per il payload completo.',
      },
    };
  } catch (e) {
    return { ok: false, error: `read_run fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function checkSettingsHealthHandler(session: ScaffoldSession): ToolResult {
  try {
    const emailSvc = new SystemEmailAccountsService();
    const credSvc = new CredentialsService();
    const llmSvc = new LlmProvidersService();
    const emails = emailSvc.list(session.tenantId);
    const creds = credSvc.list(session.tenantId);
    const llms = llmSvc.list(session.tenantId).filter((p) => p.hasKey);
    const dbs = session.dbStudio.list(session.tenantId);
    return {
      ok: true,
      data: {
        emailAccounts: { count: emails.length, hasDefault: emails.some((a) => a.isDefault) },
        secrets: { count: creds.length, names: creds.map((c) => c.name) },
        llmProviders: { count: llms.length, providers: llms.map((p) => p.provider) },
        databases: { count: dbs.length, totalTables: dbs.reduce((acc, d) => acc + (d.tables?.length ?? 0), 0) },
        warnings: [
          ...(emails.length === 0 ? ['Nessun account email configurato — workflow IMAP/SMTP non funzioneranno.'] : []),
          ...(llms.length === 0 ? ['Nessun provider LLM configurato — nodi AI/agent non funzioneranno.'] : []),
          ...(dbs.length === 0 ? ['Nessun database configurato — nodi db_* non funzioneranno.'] : []),
        ],
      },
    };
  } catch (e) {
    return { ok: false, error: `check_settings_health fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}
