/**
 * Airtable executor — REST API v0 (Personal Access Token in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseJsonObj } from './saas-shared.js';

export const airtableExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listRecords');
  const baseId = coerceString(cfg.baseId ?? '').trim();
  const tableName = coerceString(cfg.tableName ?? '').trim();
  if (!baseId || !tableName) throw new IntegrationError({ provider: 'airtable', code: 'INVALID_PAYLOAD', message: 'baseId e tableName obbligatori' });

  const integ = requireIntegration({ provider: 'airtable', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const token = (integ.credentials as { personalAccessToken?: string }).personalAccessToken;
  if (!token) throw new IntegrationError({ provider: 'airtable', code: 'INVALID_CREDENTIALS', message: 'personalAccessToken assente' });

  const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  let records: unknown[] = []; let record: unknown = null; let deleted = false;

  await withRetry(async () => {
    switch (operation) {
      case 'listRecords': {
        const filter = coerceString(cfg.filterByFormula ?? '').trim();
        const maxRec = Math.min(Number(cfg.maxRecords ?? 1000), 10_000);
        let offset: string | undefined;
        do {
          const params = new URLSearchParams();
          if (filter) params.set('filterByFormula', filter);
          if (offset) params.set('offset', offset);
          params.set('pageSize', '100');
          const r = await jsonFetch<{ records: unknown[]; offset?: string }>('airtable', `${base}?${params.toString()}`, token);
          records.push(...r.records);
          offset = r.offset;
        } while (offset && records.length < maxRec);
        records = records.slice(0, maxRec);
        break;
      }
      case 'getRecord': {
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!id) throw new IntegrationError({ provider: 'airtable', code: 'INVALID_PAYLOAD', message: 'recordId obbligatorio' });
        record = await jsonFetch('airtable', `${base}/${id}`, token);
        break;
      }
      case 'createRecord': {
        const fields = parseJsonObj('airtable', cfg.fieldsJson, 'fieldsJson');
        record = await jsonFetch('airtable', base, token, { method: 'POST', body: { fields, typecast: true } });
        break;
      }
      case 'updateRecord': {
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!id) throw new IntegrationError({ provider: 'airtable', code: 'INVALID_PAYLOAD', message: 'recordId obbligatorio' });
        const fields = parseJsonObj('airtable', cfg.fieldsJson, 'fieldsJson');
        record = await jsonFetch('airtable', `${base}/${id}`, token, { method: 'PATCH', body: { fields, typecast: true } });
        break;
      }
      case 'deleteRecord': {
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!id) throw new IntegrationError({ provider: 'airtable', code: 'INVALID_PAYLOAD', message: 'recordId obbligatorio' });
        await jsonFetch('airtable', `${base}/${id}`, token, { method: 'DELETE' });
        deleted = true;
        break;
      }
      default:
        throw new IntegrationError({ provider: 'airtable', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata` });
    }
  }, { label: `airtable.${operation}` });

  return { output: { ok: true, records, count: records.length, record, deleted }, durationMs: Date.now() - start };
};
