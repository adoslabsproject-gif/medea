/**
 * Asana executor — REST API 1.0 (Bearer Personal Access Token).
 *
 * Operazioni: createTask (name/notes/projects/assignee/dueOn), getTask,
 * addComment (story). Credenziali vault: { accessToken } (PAT "1/...").
 * HTTP via jsonFetch → safeOutboundFetch (SSRF + breaker + timeout) + withRetry.
 * Body Asana sempre wrappato in { data: {...} }. Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

interface AsanaCreds {
  accessToken?: string;
}

const BASE = 'https://app.asana.com/api/1.0';

export const asanaExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'createTask');

  const integ = requireIntegration({
    provider: 'asana',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const token = (integ.credentials as AsanaCreds).accessToken;
  if (!token)
    throw new IntegrationError({
      provider: 'asana',
      code: 'INVALID_CREDENTIALS',
      message: 'accessToken (PAT) assente nel vault',
    });
  const headers = { Authorization: `Bearer ${token}` };

  let output: Record<string, unknown> = {};

  await withRetry(
    async () => {
      switch (operation) {
        case 'createTask': {
          const name = coerceString(cfg.name ?? '').trim();
          if (!name)
            throw new IntegrationError({
              provider: 'asana',
              code: 'INVALID_PAYLOAD',
              message: 'name (titolo task) obbligatorio per createTask',
            });
          const data: Record<string, unknown> = { name };
          const notes = coerceString(cfg.notes ?? '').trim();
          if (notes) data.notes = notes;
          const projectId = coerceString(cfg.projectId ?? '').trim();
          if (projectId)
            data.projects = projectId
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean);
          const assignee = coerceString(cfg.assignee ?? '').trim();
          if (assignee) data.assignee = assignee;
          const dueOn = coerceString(cfg.dueOn ?? '').trim();
          if (dueOn) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn))
              throw new IntegrationError({
                provider: 'asana',
                code: 'INVALID_PAYLOAD',
                message: 'dueOn deve essere YYYY-MM-DD',
              });
            data.due_on = dueOn;
          }
          const workspace = coerceString(cfg.workspace ?? '').trim();
          if (workspace && !data.projects) data.workspace = workspace;
          const r = await jsonFetch<{ data?: { gid?: string; permalink_url?: string } }>(
            'asana',
            `${BASE}/tasks`,
            null,
            { method: 'POST', body: { data }, headers },
          );
          output = { taskId: r.data?.gid ?? null, url: r.data?.permalink_url ?? null };
          break;
        }
        case 'getTask': {
          const taskId = coerceString(cfg.taskId ?? '').trim();
          if (!taskId)
            throw new IntegrationError({
              provider: 'asana',
              code: 'INVALID_PAYLOAD',
              message: 'taskId obbligatorio per getTask',
            });
          const r = await jsonFetch<{ data?: Record<string, unknown> }>(
            'asana',
            `${BASE}/tasks/${encodeURIComponent(taskId)}`,
            null,
            { method: 'GET', headers },
          );
          output = { task: r.data ?? null };
          break;
        }
        case 'addComment': {
          const taskId = coerceString(cfg.taskId ?? '').trim();
          const text = coerceString(cfg.commentText ?? '').trim();
          if (!taskId || !text)
            throw new IntegrationError({
              provider: 'asana',
              code: 'INVALID_PAYLOAD',
              message: 'taskId e commentText obbligatori per addComment',
            });
          const r = await jsonFetch<{ data?: { gid?: string } }>(
            'asana',
            `${BASE}/tasks/${encodeURIComponent(taskId)}/stories`,
            null,
            { method: 'POST', body: { data: { text } }, headers },
          );
          output = { commentId: r.data?.gid ?? null };
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'asana',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata (createTask/getTask/addComment)`,
          });
      }
    },
    { label: `asana.${operation}` },
  );

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
