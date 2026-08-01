/**
 * Salesforce integration executor — REST API + OAuth2 refresh.
 *
 * Credentials shape:
 *   { instanceUrl, accessToken, refreshToken, clientId, clientSecret }
 *
 * On 401 → 1 refresh attempt via /services/oauth2/token then retry.
 *
 * @module executors/integrations/salesforce
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';
import { saveIntegration } from '@/services/integrations/store.js';
import { assertHostAllowed, HostNotAllowedError } from '@/lib/host-allowlist.js';

const API_VERSION = 'v60.0';

/**
 * Identificatore SObject/campo Salesforce: lettera iniziale + lettere/cifre/underscore
 * (copre standard `Account`/`Contact` e custom `Foo__c`/`Bar__r`). Usato per VINCOLARE
 * `sobject`/`externalIdField` PRIMA di metterli nel path: senza, un `sobject` con `/`,
 * `?`, `#` o `../` farebbe path-traversal dentro l'API Salesforce col token del tenant.
 */
const SF_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Valida un identificatore SObject/campo; lancia IntegrationError se non conforme. */
function assertSfIdentifier(value: string, field: string): string {
  if (!SF_IDENTIFIER.test(value)) {
    throw new IntegrationError({
      provider: 'salesforce', code: 'INVALID_PAYLOAD',
      message: `community_salesforce: "${field}" non valido (atteso identificatore SObject/campo: lettera iniziale poi lettere/cifre/underscore, es. Account o Foo__c)`,
    });
  }
  return value;
}

/**
 * Anti-esfiltrazione: `instanceUrl` (e un eventuale `path` assoluto) arrivano dalla config
 * del tenant. SENZA questo vincolo, alla prima 401 il refresh POSTerebbe client_secret +
 * refresh_token (credenziali OAuth PERMANENTI del CRM) a un host arbitrario. Domini ufficiali
 * Salesforce: *.salesforce.com (My Domain/instance) e *.force.com (Lightning/Experience).
 */
const SALESFORCE_HOSTS = ['salesforce.com', 'force.com'] as const;

/** assertHostAllowed → IntegrationError tipizzato del provider. */
function guardSfHost(url: string): void {
  try {
    assertHostAllowed(url, SALESFORCE_HOSTS);
  } catch (e) {
    if (e instanceof HostNotAllowedError) {
      throw new IntegrationError({ provider: 'salesforce', code: 'HOST_NOT_ALLOWED', message: e.message });
    }
    throw e;
  }
}

interface SfCredentials {
  instanceUrl: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

interface SfFetchOpts { method?: string; body?: unknown; signal?: AbortSignal | undefined }

async function refreshAccessToken(creds: SfCredentials, signal?: AbortSignal  ): Promise<string> {
  const tokenUrl = `${creds.instanceUrl}/services/oauth2/token`;
  // CRITICO: NON spedire client_secret+refresh_token a un instanceUrl arbitrario.
  guardSfHost(tokenUrl);
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await safeOutboundFetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new IntegrationError({
      provider: 'salesforce', code: 'OAUTH_REFRESH_FAILED',
      message: `Salesforce OAuth refresh failed: HTTP ${String(res.status)}`,
      httpStatus: res.status,
    });
  }
  const body = await readJsonCapped<{ access_token?: string; error?: string }>(res);
  if (!body.access_token) {
    throw new IntegrationError({
      provider: 'salesforce', code: 'OAUTH_REFRESH_FAILED',
      message: `Salesforce OAuth refresh: no access_token in response${body.error ? ` (${body.error})` : ''}`,
    });
  }
  return body.access_token;
}

async function sfFetch<T>(
  creds: SfCredentials,
  tenantId: string,
  integrationLabel: string | null,
  path: string,
  opts: SfFetchOpts = {},
  isRetry = false,
): Promise<T> {
  const url = path.startsWith('http') ? path : `${creds.instanceUrl}/services/data/${API_VERSION}${path}`;
  // Anti-esfiltrazione: l'access token non deve finire su un host non-Salesforce
  // (instanceUrl o `path` assoluto derivati da config).
  guardSfHost(url);
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    signal: opts.signal ?? AbortSignal.timeout(30_000),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await safeOutboundFetch(url, init);

  // 401: try refresh once
  if (res.status === 401 && !isRetry) {
    const newToken = await refreshAccessToken(creds, opts.signal);
    const updatedCreds: SfCredentials = { ...creds, accessToken: newToken };
    // Persist refreshed token to vault
    try {
      await saveIntegration({
        provider: 'salesforce',
        tenantId,
        ...(integrationLabel ? { label: integrationLabel } : {}),
        credentials: updatedCreds as unknown as Record<string, unknown>,
        expiresAt: null,
      });
    } catch { /* best-effort persist */ }
    return await sfFetch<T>(updatedCreds, tenantId, integrationLabel, path, opts, true);
  }

  if (res.status === 204) return {} as T;
  if (!res.ok) {
    let errMsg = `Salesforce HTTP ${String(res.status)} ${res.statusText}`;
    try {
      const e = await readJsonCapped<{ message?: string; errorCode?: string }[] | { message?: string }>(res);
      const arr: { message?: string; errorCode?: string }[] = Array.isArray(e) ? e : [e];
      const first = arr[0];
      if (first?.message) errMsg += ` — ${first.message}${first.errorCode ? ` (${first.errorCode})` : ''}`;
    } catch { /* not JSON */ }
    throw new IntegrationError({
      provider: 'salesforce', code: 'API_HTTP_ERROR', message: errMsg,
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
    const p = JSON.parse(raw) as unknown;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error('not object');
    return p as Record<string, unknown>;
  } catch (e) {
    throw new IntegrationError({
      provider: 'salesforce', code: 'INVALID_PAYLOAD',
      message: `community_salesforce: ${fieldName} parse error — ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export const salesforceExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? '').trim();
  if (!operation) throw new IntegrationError({
    provider: 'salesforce', code: 'INVALID_PAYLOAD', message: 'community_salesforce: "operation" obbligatorio',
  });

  const integrationLabel = typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null;
  const integration = requireIntegration({
    provider: 'salesforce', tenantId: context.tenantId, label: integrationLabel,
  });
  const creds = integration.credentials as unknown as SfCredentials;
  if (!creds.instanceUrl || !creds.accessToken || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
    throw new IntegrationError({
      provider: 'salesforce', code: 'INVALID_CREDENTIALS',
      message: 'community_salesforce: credentials incomplete (instanceUrl + accessToken + refreshToken + clientId + clientSecret tutti required)',
    });
  }

  let data: unknown;
  let records: unknown[] = [];
  let totalSize = 0;
  let recordId: string | null = null;
  let created = false;

  await withRetry(async () => {
    switch (operation) {
      case 'query': {
        const soql = coerceString(cfg.soql ?? '').trim();
        if (!soql) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD', message: 'community_salesforce: "soql" obbligatorio per query',
        });
        const r = await sfFetch<{ records: unknown[]; totalSize: number; done: boolean }>(
          creds, context.tenantId, integrationLabel,
          `/query?q=${encodeURIComponent(soql)}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = r; records = r.records; totalSize = r.totalSize;
        break;
      }
      case 'create': {
        const sobject = coerceString(cfg.sobject ?? '').trim();
        if (!sobject) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD', message: 'community_salesforce: "sobject" obbligatorio per create',
        });
        const record = parseJsonObj(cfg.recordJson, 'recordJson');
        const r = await sfFetch<{ id: string; success: boolean }>(
          creds, context.tenantId, integrationLabel,
          `/sobjects/${assertSfIdentifier(sobject, 'sobject')}`,
          { method: 'POST', body: record, ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = r; recordId = r.id; created = true;
        break;
      }
      case 'update': {
        const sobject = coerceString(cfg.sobject ?? '').trim();
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!sobject || !id) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD',
          message: 'community_salesforce: update richiede sobject + recordId',
        });
        const record = parseJsonObj(cfg.recordJson, 'recordJson');
        await sfFetch<unknown>(
          creds, context.tenantId, integrationLabel,
          `/sobjects/${assertSfIdentifier(sobject, 'sobject')}/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: record, ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = { id, updated: true }; recordId = id;
        break;
      }
      case 'upsert': {
        const sobject = coerceString(cfg.sobject ?? '').trim();
        const extField = coerceString(cfg.externalIdField ?? '').trim();
        const extValue = coerceString(cfg.externalIdValue ?? '').trim();
        if (!sobject || !extField || !extValue) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD',
          message: 'community_salesforce: upsert richiede sobject + externalIdField + externalIdValue',
        });
        const record = parseJsonObj(cfg.recordJson, 'recordJson');
        const r = await sfFetch<{ id?: string; created?: boolean }>(
          creds, context.tenantId, integrationLabel,
          `/sobjects/${assertSfIdentifier(sobject, 'sobject')}/${assertSfIdentifier(extField, 'externalIdField')}/${encodeURIComponent(extValue)}`,
          { method: 'PATCH', body: record, ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = r; recordId = r.id ?? null; created = r.created ?? false;
        break;
      }
      case 'delete': {
        const sobject = coerceString(cfg.sobject ?? '').trim();
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!sobject || !id) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD',
          message: 'community_salesforce: delete richiede sobject + recordId',
        });
        await sfFetch<unknown>(
          creds, context.tenantId, integrationLabel,
          `/sobjects/${assertSfIdentifier(sobject, 'sobject')}/${encodeURIComponent(id)}`,
          { method: 'DELETE', ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = { id, deleted: true }; recordId = id;
        break;
      }
      case 'get': {
        const sobject = coerceString(cfg.sobject ?? '').trim();
        const id = coerceString(cfg.recordId ?? '').trim();
        if (!sobject || !id) throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD',
          message: 'community_salesforce: get richiede sobject + recordId',
        });
        const r = await sfFetch<Record<string, unknown>>(
          creds, context.tenantId, integrationLabel,
          `/sobjects/${assertSfIdentifier(sobject, 'sobject')}/${encodeURIComponent(id)}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) },
        );
        data = r; recordId = id;
        break;
      }
      default:
        throw new IntegrationError({
          provider: 'salesforce', code: 'INVALID_PAYLOAD',
          message: `community_salesforce: operation "${operation}" non supportata`,
        });
    }
  }, { label: `salesforce.${operation}` });

  return {
    output: {
      ok: true, data, records, count: records.length, totalSize, recordId, created,
    },
    durationMs: Date.now() - start,
  };
};
