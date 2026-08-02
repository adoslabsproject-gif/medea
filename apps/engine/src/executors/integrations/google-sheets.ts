/**
 * Google Sheets executor — Sheets API v4 (OAuth2 access token in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseSheetValues } from './saas-shared.js';

export const googleSheetsExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'getValues');
  const spreadsheetId = coerceString(cfg.spreadsheetId ?? '').trim();
  const range = coerceString(cfg.range ?? '').trim();
  if (!spreadsheetId) throw new IntegrationError({ provider: 'google_sheets', code: 'INVALID_PAYLOAD', message: 'spreadsheetId obbligatorio' });

  const integ = requireIntegration({ provider: 'google_sheets', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const token = (integ.credentials as { accessToken?: string }).accessToken;
  if (!token) throw new IntegrationError({ provider: 'google_sheets', code: 'INVALID_CREDENTIALS', message: 'accessToken assente' });

  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  let data: unknown; let rows: unknown[] = []; let updatedCells = 0;

  await withRetry(async () => {
    switch (operation) {
      case 'getValues': {
        if (!range) throw new IntegrationError({ provider: 'google_sheets', code: 'INVALID_PAYLOAD', message: 'range obbligatorio' });
        const r = await jsonFetch<{ values?: unknown[][]; range: string }>('google_sheets', `${base}/values/${encodeURIComponent(range)}`, token);
        data = r; rows = r.values ?? [];
        break;
      }
      case 'updateValues': {
        const values = parseSheetValues(cfg.valuesJson);
        const vio = coerceString(cfg.valueInputOption ?? 'USER_ENTERED');
        const r = await jsonFetch<{ updatedCells: number; updatedRange: string }>(
          'google_sheets',
          `${base}/values/${encodeURIComponent(range)}?valueInputOption=${vio}`,
          token,
          { method: 'PUT', body: { values } },
        );
        data = r; updatedCells = r.updatedCells ?? 0;
        break;
      }
      case 'appendValues': {
        const values = parseSheetValues(cfg.valuesJson);
        const vio = coerceString(cfg.valueInputOption ?? 'USER_ENTERED');
        const r = await jsonFetch<{ updates?: { updatedCells: number } }>(
          'google_sheets',
          `${base}/values/${encodeURIComponent(range)}:append?valueInputOption=${vio}&insertDataOption=INSERT_ROWS`,
          token,
          { method: 'POST', body: { values } },
        );
        data = r; updatedCells = r.updates?.updatedCells ?? 0;
        break;
      }
      case 'batchGet': {
        const ranges = range.split(',').map((s) => s.trim()).filter(Boolean);
        const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
        const r = await jsonFetch<{ valueRanges?: { range: string; values?: unknown[][] }[] }>(
          'google_sheets', `${base}/values:batchGet?${qs}`, token,
        );
        data = r;
        break;
      }
      default:
        throw new IntegrationError({ provider: 'google_sheets', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata` });
    }
  }, { label: `sheets.${operation}` });

  return { output: { ok: true, data, rows, count: rows.length, updatedCells, spreadsheetId }, durationMs: Date.now() - start };
};
