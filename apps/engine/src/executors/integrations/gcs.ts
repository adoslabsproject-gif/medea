/**
 * Google Cloud Storage executor — JSON API v1 (Bearer OAuth2 access token).
 *
 * Operazioni: listObjects (bucket, prefix opzionale), getObjectMetadata,
 * deleteObject, createSignedReadLink (via metadata mediaLink). Credenziali
 * vault: { accessToken } (OAuth2 scope devstorage.read_write). HTTP via
 * jsonFetch → safeOutboundFetch (SSRF + breaker + timeout) + withRetry.
 * Bucket name validato (RFC GCS). Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

interface GcsCreds {
  accessToken?: string;
}

const BASE = 'https://storage.googleapis.com/storage/v1';

function assertBucket(v: string): string {
  const b = v.trim();
  // GCS bucket: 3-63 char, lowercase/digit/-/_/., no maiuscole.
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(b)) {
    throw new IntegrationError({
      provider: 'gcs',
      code: 'INVALID_PAYLOAD',
      message: `bucket non valido (3-63 char, lowercase): "${v}"`,
    });
  }
  return b;
}

export const gcsExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'listObjects');
  const bucket = assertBucket(coerceString(cfg.bucket ?? ''));

  const integ = requireIntegration({
    provider: 'gcs',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const token = (integ.credentials as GcsCreds).accessToken;
  if (!token)
    throw new IntegrationError({
      provider: 'gcs',
      code: 'INVALID_CREDENTIALS',
      message: 'accessToken (OAuth2) assente nel vault',
    });
  const headers = { Authorization: `Bearer ${token}` };

  let output: Record<string, unknown> = {};

  await withRetry(
    async () => {
      switch (operation) {
        case 'listObjects': {
          const prefix = coerceString(cfg.prefix ?? '').trim();
          const maxResults = Math.min(Math.max(Number(cfg.maxResults ?? 100), 1), 1000);
          const qs = new URLSearchParams({ maxResults: String(maxResults) });
          if (prefix) qs.set('prefix', prefix);
          const r = await jsonFetch<{ items?: Record<string, unknown>[]; nextPageToken?: string }>(
            'gcs',
            `${BASE}/b/${bucket}/o?${qs.toString()}`,
            null,
            { method: 'GET', headers },
          );
          const items = Array.isArray(r.items) ? r.items : [];
          output = { objects: items, count: items.length, nextPageToken: r.nextPageToken ?? null };
          break;
        }
        case 'getObjectMetadata': {
          const objectName = coerceString(cfg.objectName ?? '').trim();
          if (!objectName)
            throw new IntegrationError({
              provider: 'gcs',
              code: 'INVALID_PAYLOAD',
              message: 'objectName obbligatorio',
            });
          const r = await jsonFetch<Record<string, unknown>>(
            'gcs',
            `${BASE}/b/${bucket}/o/${encodeURIComponent(objectName)}`,
            null,
            { method: 'GET', headers },
          );
          output = { metadata: r, mediaLink: r.mediaLink ?? null };
          break;
        }
        case 'deleteObject': {
          const objectName = coerceString(cfg.objectName ?? '').trim();
          if (!objectName)
            throw new IntegrationError({
              provider: 'gcs',
              code: 'INVALID_PAYLOAD',
              message: 'objectName obbligatorio',
            });
          await jsonFetch<unknown>(
            'gcs',
            `${BASE}/b/${bucket}/o/${encodeURIComponent(objectName)}`,
            null,
            { method: 'DELETE', headers },
          );
          output = { deleted: true, objectName };
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'gcs',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata (listObjects/getObjectMetadata/deleteObject)`,
          });
      }
    },
    { label: `gcs.${operation}` },
  );

  return { output: { ok: true, operation, bucket, ...output }, durationMs: Date.now() - start };
};
