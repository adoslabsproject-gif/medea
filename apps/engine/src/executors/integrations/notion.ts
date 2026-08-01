/**
 * Notion integration executor — REST API v1.
 * Credentials: { integrationToken: "secret_..." }
 *
 * @module executors/integrations/notion
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

interface NotionCredentials { integrationToken: string }

async function notionFetch<T>(token: string, path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await safeOutboundFetch(`${NOTION_API}${path}`, init);
  if (!res.ok) {
    let errMsg = `Notion HTTP ${String(res.status)} ${res.statusText}`;
    try {
      const e = await readJsonCapped<{ message?: string; code?: string }>(res);
      if (e.message) errMsg += ` — ${e.message}${e.code ? ` (${e.code})` : ''}`;
    } catch { /* */ }
    throw new IntegrationError({
      provider: 'notion', code: 'API_HTTP_ERROR', message: errMsg,
      httpStatus: res.status, retryable: res.status >= 500 || res.status === 429,
    });
  }
  return await readJsonCapped<T>(res);
}

function parseJsonObj(raw: unknown, fieldName: string): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new IntegrationError({
      provider: 'notion', code: 'INVALID_PAYLOAD',
      message: `community_notion: ${fieldName} parse error — ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export const notionExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? '').trim();
  if (!operation) throw new IntegrationError({
    provider: 'notion', code: 'INVALID_PAYLOAD', message: 'community_notion: "operation" obbligatorio',
  });

  const integration = requireIntegration({
    provider: 'notion', tenantId: context.tenantId,
    label: typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
  });
  const creds = integration.credentials as unknown as NotionCredentials;
  if (!creds.integrationToken?.startsWith('secret_')) {
    throw new IntegrationError({
      provider: 'notion', code: 'INVALID_CREDENTIALS',
      message: 'community_notion: integrationToken non valido (formato secret_*)',
    });
  }

  const properties = parseJsonObj(cfg.propertiesJson, 'propertiesJson');

  let data: unknown;
  let pageId: string | null = null;
  let results: unknown[] = [];
  let hasMore = false;
  let nextCursor: string | null = null;

  await withRetry(async () => {
    switch (operation) {
      case 'createPage': {
        const parentId = coerceString(cfg.parentId ?? '').trim();
        if (!parentId) throw new IntegrationError({
          provider: 'notion', code: 'INVALID_PAYLOAD', message: 'community_notion: createPage richiede parentId',
        });
        const parentType = coerceString(cfg.parentType ?? 'database_id');
        const parent = parentType === 'page_id' ? { page_id: parentId } : { database_id: parentId };
        const r = await notionFetch<{ id: string; properties: unknown }>(creds.integrationToken, '/pages', {
          method: 'POST', body: { parent, properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        data = r; pageId = r.id;
        break;
      }
      case 'updatePage': {
        const id = coerceString(cfg.pageId ?? '').trim();
        if (!id) throw new IntegrationError({
          provider: 'notion', code: 'INVALID_PAYLOAD', message: 'community_notion: updatePage richiede pageId',
        });
        const r = await notionFetch<{ id: string; properties: unknown }>(creds.integrationToken, `/pages/${encodeURIComponent(id)}`, {
          method: 'PATCH', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        data = r; pageId = r.id;
        break;
      }
      case 'getPage': {
        const id = coerceString(cfg.pageId ?? '').trim();
        if (!id) throw new IntegrationError({
          provider: 'notion', code: 'INVALID_PAYLOAD', message: 'community_notion: getPage richiede pageId',
        });
        const r = await notionFetch<{ id: string; properties: unknown }>(creds.integrationToken, `/pages/${encodeURIComponent(id)}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r; pageId = r.id;
        break;
      }
      case 'queryDatabase': {
        const id = coerceString(cfg.databaseId ?? '').trim();
        if (!id) throw new IntegrationError({
          provider: 'notion', code: 'INVALID_PAYLOAD', message: 'community_notion: queryDatabase richiede databaseId',
        });
        const pageSize = Math.min(Math.max(Number(cfg.pageSize ?? 50), 1), 100);
        const filter = parseJsonObj(cfg.filterJson, 'filterJson');
        const body: Record<string, unknown> = { page_size: pageSize };
        if (Object.keys(filter).length > 0) body.filter = filter;
        const r = await notionFetch<{ results: unknown[]; has_more: boolean; next_cursor: string | null }>(
          creds.integrationToken, `/databases/${encodeURIComponent(id)}/query`,
          { method: 'POST', body, ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = r; results = r.results; hasMore = r.has_more; nextCursor = r.next_cursor;
        break;
      }
      default:
        throw new IntegrationError({
          provider: 'notion', code: 'INVALID_PAYLOAD',
          message: `community_notion: operation "${operation}" non supportata`,
        });
    }
  }, { label: `notion.${operation}` });

  return {
    output: { ok: true, data, pageId, results, count: results.length, hasMore, nextCursor },
    durationMs: Date.now() - start,
  };
};
