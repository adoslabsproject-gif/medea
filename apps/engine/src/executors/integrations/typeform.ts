/**
 * Typeform executor — Forms API + Responses API (Personal Access Token in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

export const typeformExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listResponses');

  const integ = requireIntegration({ provider: 'typeform', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const token = (integ.credentials as { personalAccessToken?: string }).personalAccessToken;
  if (!token) throw new IntegrationError({ provider: 'typeform', code: 'INVALID_CREDENTIALS', message: 'personalAccessToken assente' });

  let forms: unknown[] = []; let responses: unknown[] = []; let form: unknown = null; let total = 0;
  await withRetry(async () => {
    switch (operation) {
      case 'listForms': {
        const r = await jsonFetch<{ items: unknown[]; total_items: number }>('typeform', 'https://api.typeform.com/forms?page_size=200', token);
        forms = r.items; total = r.total_items;
        break;
      }
      case 'getForm': {
        const id = coerceString(cfg.formId ?? '').trim();
        if (!id) throw new IntegrationError({ provider: 'typeform', code: 'INVALID_PAYLOAD', message: 'formId obbligatorio' });
        form = await jsonFetch('typeform', `https://api.typeform.com/forms/${encodeURIComponent(id)}`, token);
        break;
      }
      case 'listResponses': {
        const id = coerceString(cfg.formId ?? '').trim();
        if (!id) throw new IntegrationError({ provider: 'typeform', code: 'INVALID_PAYLOAD', message: 'formId obbligatorio' });
        const params = new URLSearchParams();
        params.set('page_size', String(Math.min(Number(cfg.pageSize ?? 50), 1000)));
        const completed = coerceString(cfg.completed ?? 'true');
        if (completed !== 'any') params.set('completed', completed);
        if (cfg.sinceDate) params.set('since', coerceString(cfg.sinceDate));
        if (cfg.untilDate) params.set('until', coerceString(cfg.untilDate));
        const r = await jsonFetch<{ items: unknown[]; total_items: number }>('typeform', `https://api.typeform.com/forms/${encodeURIComponent(id)}/responses?${params.toString()}`, token);
        responses = r.items; total = r.total_items;
        break;
      }
      case 'getResponse': {
        const id = coerceString(cfg.formId ?? '').trim();
        const rid = coerceString(cfg.responseId ?? '').trim();
        if (!id || !rid) throw new IntegrationError({ provider: 'typeform', code: 'INVALID_PAYLOAD', message: 'formId + responseId obbligatori' });
        const r = await jsonFetch<{ items: unknown[] }>('typeform', `https://api.typeform.com/forms/${encodeURIComponent(id)}/responses?included_response_ids=${encodeURIComponent(rid)}`, token);
        responses = r.items;
        break;
      }
      case 'deleteResponses': {
        const id = coerceString(cfg.formId ?? '').trim();
        const rid = coerceString(cfg.responseId ?? '').trim();
        if (!id || !rid) throw new IntegrationError({ provider: 'typeform', code: 'INVALID_PAYLOAD', message: 'formId + responseId obbligatori' });
        await jsonFetch('typeform', `https://api.typeform.com/forms/${encodeURIComponent(id)}/responses?included_response_ids=${encodeURIComponent(rid)}`, token, { method: 'DELETE' });
        break;
      }
      default:
        throw new IntegrationError({ provider: 'typeform', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata` });
    }
  }, { label: `typeform.${operation}` });

  return { output: { ok: true, forms, form, responses, count: responses.length, total }, durationMs: Date.now() - start };
};
