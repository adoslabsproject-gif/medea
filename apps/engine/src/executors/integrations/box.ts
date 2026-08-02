/**
 * Box executor — Content API 2.0 (Bearer access token).
 *
 * Operazioni: listFolder (items di una cartella), createFolder, getItem
 * (metadata file/cartella), createSharedLink (open|company|collaborators),
 * deleteFile. Credenziali vault: { accessToken }. Root folder = "0".
 * HTTP via jsonFetch → safeOutboundFetch (SSRF + breaker + timeout) + withRetry.
 * Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

interface BoxCreds { accessToken?: string }

const BASE = 'https://api.box.com/2.0';
const VALID_ACCESS = new Set(['open', 'company', 'collaborators']);

function reqId(v: unknown, field: string): string {
  const s = coerceString(v ?? '').trim();
  if (!s) throw new IntegrationError({ provider: 'box', code: 'INVALID_PAYLOAD', message: `${field} obbligatorio` });
  if (!/^\d+$/.test(s)) throw new IntegrationError({ provider: 'box', code: 'INVALID_PAYLOAD', message: `${field} deve essere un ID numerico Box: "${s}"` });
  return s;
}

export const boxExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listFolder');

  const integ = requireIntegration({ provider: 'box', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const token = (integ.credentials as BoxCreds).accessToken;
  if (!token) throw new IntegrationError({ provider: 'box', code: 'INVALID_CREDENTIALS', message: 'accessToken assente nel vault' });
  const headers = { Authorization: `Bearer ${token}` };

  let output: Record<string, unknown> = {};

  await withRetry(async () => {
    switch (operation) {
      case 'listFolder': {
        const folderId = coerceString(cfg.folderId ?? '0').trim() || '0';
        if (!/^\d+$/.test(folderId)) throw new IntegrationError({ provider: 'box', code: 'INVALID_PAYLOAD', message: 'folderId deve essere numerico (0 = root)' });
        const limit = Math.min(Math.max(Number(cfg.limit ?? 100), 1), 1000);
        const r = await jsonFetch<{ entries?: Record<string, unknown>[]; total_count?: number }>(
          'box', `${BASE}/folders/${folderId}/items?limit=${String(limit)}`, null,
          { method: 'GET', headers },
        );
        const entries = Array.isArray(r.entries) ? r.entries : [];
        output = { entries, count: entries.length, totalCount: r.total_count ?? entries.length };
        break;
      }
      case 'createFolder': {
        const name = coerceString(cfg.name ?? '').trim();
        if (!name) throw new IntegrationError({ provider: 'box', code: 'INVALID_PAYLOAD', message: 'name (nome cartella) obbligatorio' });
        const parentId = coerceString(cfg.parentId ?? '0').trim() || '0';
        const r = await jsonFetch<{ id?: string; name?: string }>(
          'box', `${BASE}/folders`, null,
          { method: 'POST', body: { name, parent: { id: parentId } }, headers },
        );
        output = { id: r.id ?? null, name: r.name ?? name };
        break;
      }
      case 'getItem': {
        const itemId = reqId(cfg.itemId, 'itemId');
        const kind = coerceString(cfg.itemType ?? 'files') === 'folders' ? 'folders' : 'files';
        const r = await jsonFetch<Record<string, unknown>>(
          'box', `${BASE}/${kind}/${itemId}`, null, { method: 'GET', headers },
        );
        output = { item: r };
        break;
      }
      case 'createSharedLink': {
        const fileId = reqId(cfg.itemId, 'itemId');
        const access = VALID_ACCESS.has(coerceString(cfg.access ?? 'open')) ? coerceString(cfg.access ?? 'open') : 'open';
        const r = await jsonFetch<{ shared_link?: { url?: string; download_url?: string } }>(
          'box', `${BASE}/files/${fileId}?fields=shared_link`, null,
          { method: 'PUT', body: { shared_link: { access } }, headers },
        );
        output = { sharedUrl: r.shared_link?.url ?? null, downloadUrl: r.shared_link?.download_url ?? null };
        break;
      }
      case 'deleteFile': {
        const fileId = reqId(cfg.itemId, 'itemId');
        await jsonFetch<unknown>(
          'box', `${BASE}/files/${fileId}`, null, { method: 'DELETE', headers },
        );
        output = { deleted: true, id: fileId };
        break;
      }
      default:
        throw new IntegrationError({ provider: 'box', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata (listFolder/createFolder/getItem/createSharedLink/deleteFile)` });
    }
  }, { label: `box.${operation}` });

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
