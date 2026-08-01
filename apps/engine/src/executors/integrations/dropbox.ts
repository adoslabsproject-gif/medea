/**
 * Dropbox executor — RPC API v2 (Bearer access token).
 *
 * Operazioni: listFolder, createFolder, getMetadata, createSharedLink, deletePath.
 * Credenziali vault: { accessToken }. HTTP via jsonFetch → safeOutboundFetch
 * (SSRF + breaker + timeout) + withRetry. Path Dropbox normalizzati (devono
 * iniziare con '/'). Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

interface DropboxCreds { accessToken?: string }

const RPC = 'https://api.dropboxapi.com/2';

function normPath(p: string, field: string): string {
  const v = p.trim();
  if (!v) throw new IntegrationError({ provider: 'dropbox', code: 'INVALID_PAYLOAD', message: `${field} obbligatorio` });
  // Dropbox: root = "" (vuoto), altrimenti deve iniziare con '/'.
  if (v === '/' ) return '';
  return v.startsWith('/') ? v : `/${v}`;
}

export const dropboxExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listFolder');

  const integ = requireIntegration({ provider: 'dropbox', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const token = (integ.credentials as DropboxCreds).accessToken;
  if (!token) throw new IntegrationError({ provider: 'dropbox', code: 'INVALID_CREDENTIALS', message: 'accessToken assente nel vault' });
  const headers = { Authorization: `Bearer ${token}` };

  let output: Record<string, unknown> = {};

  await withRetry(async () => {
    switch (operation) {
      case 'listFolder': {
        const path = cfg.path !== undefined && coerceString(cfg.path).trim() && coerceString(cfg.path).trim() !== '/'
          ? normPath(coerceString(cfg.path), 'path') : '';
        const r = await jsonFetch<{ entries?: Record<string, unknown>[]; has_more?: boolean }>(
          'dropbox', `${RPC}/files/list_folder`, null,
          { method: 'POST', body: { path, recursive: Boolean(cfg.recursive) }, headers },
        );
        const entries = Array.isArray(r.entries) ? r.entries : [];
        output = { entries, count: entries.length, hasMore: r.has_more ?? false };
        break;
      }
      case 'createFolder': {
        const path = normPath(coerceString(cfg.path ?? ''), 'path');
        const r = await jsonFetch<{ metadata?: { id?: string; path_display?: string } }>(
          'dropbox', `${RPC}/files/create_folder_v2`, null,
          { method: 'POST', body: { path, autorename: Boolean(cfg.autorename) }, headers },
        );
        output = { id: r.metadata?.id ?? null, path: r.metadata?.path_display ?? path };
        break;
      }
      case 'getMetadata': {
        const path = normPath(coerceString(cfg.path ?? ''), 'path');
        const r = await jsonFetch<Record<string, unknown>>(
          'dropbox', `${RPC}/files/get_metadata`, null,
          { method: 'POST', body: { path }, headers },
        );
        output = { metadata: r };
        break;
      }
      case 'createSharedLink': {
        const path = normPath(coerceString(cfg.path ?? ''), 'path');
        const r = await jsonFetch<{ url?: string }>(
          'dropbox', `${RPC}/sharing/create_shared_link_with_settings`, null,
          { method: 'POST', body: { path }, headers },
        );
        output = { sharedUrl: r.url ?? null };
        break;
      }
      case 'deletePath': {
        const path = normPath(coerceString(cfg.path ?? ''), 'path');
        const r = await jsonFetch<{ metadata?: { id?: string } }>(
          'dropbox', `${RPC}/files/delete_v2`, null,
          { method: 'POST', body: { path }, headers },
        );
        output = { deleted: true, id: r.metadata?.id ?? null };
        break;
      }
      default:
        throw new IntegrationError({ provider: 'dropbox', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata (listFolder/createFolder/getMetadata/createSharedLink/deletePath)` });
    }
  }, { label: `dropbox.${operation}` });

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
