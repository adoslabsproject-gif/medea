/**
 * HubSpot integration executor — CRM v3 API.
 * Credentials: { accessToken: "pat-..." }
 *
 * @module executors/integrations/hubspot
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const HS_API = 'https://api.hubapi.com';

interface HsCredentials { accessToken: string }

async function hsFetch<T>(token: string, path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await safeOutboundFetch(`${HS_API}${path}`, init);
  if (!res.ok) {
    let errMsg = `HubSpot HTTP ${String(res.status)} ${res.statusText}`;
    try {
      const e = await readJsonCapped<{ message?: string; category?: string }>(res);
      if (e.message) errMsg += ` — ${e.message}${e.category ? ` (${e.category})` : ''}`;
    } catch { /* not JSON */ }
    throw new IntegrationError({
      provider: 'hubspot', code: 'API_HTTP_ERROR', message: errMsg,
      httpStatus: res.status, retryable: res.status >= 500 || res.status === 429,
    });
  }
  // DELETE returns 204 No Content
  if (res.status === 204) return {} as T;
  return await readJsonCapped<T>(res);
}

function parseProperties(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('properties must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new IntegrationError({
      provider: 'hubspot', code: 'INVALID_PAYLOAD',
      message: `community_hubspot: propertiesJson parse error — ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export const hubspotExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? '').trim();
  if (!operation) throw new IntegrationError({
    provider: 'hubspot', code: 'INVALID_PAYLOAD', message: 'community_hubspot: "operation" obbligatorio',
  });

  const integration = requireIntegration({
    provider: 'hubspot', tenantId: context.tenantId,
    label: typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
  });
  const creds = integration.credentials as unknown as HsCredentials;
  if (!creds.accessToken?.startsWith('pat-')) {
    throw new IntegrationError({
      provider: 'hubspot', code: 'INVALID_CREDENTIALS',
      message: 'community_hubspot: accessToken non valido (formato pat-*)',
    });
  }

  const email = coerceString(cfg.email ?? '').trim();
  const objectId = coerceString(cfg.objectId ?? '').trim();
  const properties = parseProperties(cfg.propertiesJson);

  let data: unknown;
  let resolvedId: string | null = null;
  let count = 0;

  await withRetry(async () => {
    switch (operation) {
      case 'createContact': {
        if (email && !properties.email) properties.email = email;
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken, '/crm/v3/objects/contacts', {
          method: 'POST', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        data = r; resolvedId = r.id;
        break;
      }
      case 'updateContact': {
        let id = objectId;
        if (!id && email) {
          // Lookup per email
          const lookup = await hsFetch<{ id?: string }>(creds.accessToken,
            `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
            { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
          if (lookup.id) id = lookup.id;
        }
        if (!id) throw new IntegrationError({
          provider: 'hubspot', code: 'INVALID_PAYLOAD',
          message: 'community_hubspot: updateContact richiede objectId o email',
        });
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken,
          `/crm/v3/objects/contacts/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r; resolvedId = r.id;
        break;
      }
      case 'getContact': {
        if (!email && !objectId) throw new IntegrationError({
          provider: 'hubspot', code: 'INVALID_PAYLOAD',
          message: 'community_hubspot: getContact richiede email o objectId',
        });
        const id = objectId ? encodeURIComponent(objectId) : encodeURIComponent(email);
        const suffix = objectId ? '' : '?idProperty=email';
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken,
          `/crm/v3/objects/contacts/${id}${suffix}`,
          { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r; resolvedId = r.id;
        break;
      }
      case 'listContacts': {
        const limit = Math.min(Math.max(Number(cfg.limit ?? 50), 1), 100);
        const r = await hsFetch<{ results: unknown[] }>(creds.accessToken, `/crm/v3/objects/contacts?limit=${limit.toString()}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r.results; count = r.results.length;
        break;
      }
      case 'createDeal': {
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken, '/crm/v3/objects/deals', {
          method: 'POST', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        data = r; resolvedId = r.id;
        break;
      }
      case 'updateDeal': {
        if (!objectId) throw new IntegrationError({
          provider: 'hubspot', code: 'INVALID_PAYLOAD',
          message: 'community_hubspot: updateDeal richiede objectId',
        });
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken,
          `/crm/v3/objects/deals/${encodeURIComponent(objectId)}`,
          { method: 'PATCH', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r; resolvedId = r.id;
        break;
      }
      case 'createCompany': {
        const r = await hsFetch<{ id: string; properties: Record<string, unknown> }>(creds.accessToken, '/crm/v3/objects/companies', {
          method: 'POST', body: { properties }, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        data = r; resolvedId = r.id;
        break;
      }
      default:
        throw new IntegrationError({
          provider: 'hubspot', code: 'INVALID_PAYLOAD',
          message: `community_hubspot: operation "${operation}" non supportata`,
        });
    }
  }, { label: `hubspot.${operation}` });

  return {
    output: { ok: true, data, objectId: resolvedId, count },
    durationMs: Date.now() - start,
  };
};
