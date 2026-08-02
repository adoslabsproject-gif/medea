/**
 * GAP 5 — error-workflow CATCH-ALL a livello tenant.
 *
 * E4 (per-workflow) resta la scelta prioritaria: `workflows.error_workflow_id`.
 * QUESTO flag è il fallback di tenant: quando un workflow fallisce e NON ha un
 * error-workflow proprio, il run errore fan-outa sul catch-all del tenant
 * (stessa semantica E4: anti-loop su triggerType='error-handler', anti-self,
 * rate-cap WE-14 — tutte applicate dal chiamante in run.service).
 *
 * Persistito in `system_flags` (sopravvive al restart) + cache in-memory
 * invalidata sul set — stesso pattern di readonly-flag.service.ts. Il runtime
 * è per-tenant (un container = un tenant) → una chiave singola basta.
 */
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

const FLAG_KEY = 'error_workflow_id';
let cached: string | null | undefined;

/** Workflow catch-all del tenant, o null se non configurato. Fail-soft → null. */
export function getTenantErrorWorkflowId(): string | null {
  if (cached !== undefined) return cached;
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get(FLAG_KEY) as
      | { value: string }
      | undefined;
    cached = row?.value && row.value !== '' ? row.value : null;
  } catch (err) {
    logger.warn({ err: String(err) }, 'error-workflow-flag: read failed, fail-soft (no catch-all)');
    cached = null;
  }
  return cached;
}

/** Imposta (o rimuove con null/'') il catch-all del tenant. */
export function setTenantErrorWorkflowId(workflowId: string | null): void {
  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      `INSERT INTO system_flags (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(FLAG_KEY, workflowId ?? '');
  cached = workflowId && workflowId !== '' ? workflowId : null;
  logger.info({ errorWorkflowId: cached }, 'tenant error-workflow catch-all updated');
}

/** Reset cache per i test. */
export function resetErrorWorkflowFlagForTests(): void {
  cached = undefined;
}
