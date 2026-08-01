import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { getLoopbackInternalToken } from '@/lib/internal-token.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

const RUNTIME_BASE = process.env.FLOWFORGE_RUNTIME_URL ?? 'http://127.0.0.1:3100';

/**
 * Vincola il databaseId prima di metterlo nel PATH verso l'API interna (loopback con
 * X-Internal-Token): un id con `../`/`/`/`%2e` traverserebbe verso endpoint interni
 * portandosi dietro il token di servizio (privilege-escalation). Allowlist + encode,
 * coerente col fix subworkflow/db (Ondata 4). Difesa-in-profondità: ridondante con la
 * validazione lato API, ma chiude la superficie qui prima di emettere la richiesta.
 */
const DATABASE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function assertDatabaseId(id: string, node: string): string {
  if (!DATABASE_ID_RE.test(id)) {
    throw new Error(`${node}: databaseId non valido "${id}" (ammessi: lettere, cifre, _ e -, max 128).`);
  }
  return id;
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return value as T;
  if (value.trim() === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function callDb<T>(path: string, body: unknown, tenantId: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };
  // Loopback al PROPRIO runtime → token interno (single source: internal-token.ts).
  const internalToken = getLoopbackInternalToken();
  if (internalToken) headers['X-Internal-Token'] = internalToken;
  // Runtime loopback interno (RUNTIME_BASE = 127.0.0.1:3100) → internalAwareFetch
  // concede il bypass SSRF perché è un servizio registrato.
  const res = await internalAwareFetch(`${RUNTIME_BASE}/api/v1/db${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`db ${String(res.status)}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 400)}`);
  return await readJsonCapped<T>(res);
}

export const dbUpdateExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const databaseId = typeof config.databaseId === 'string' ? config.databaseId : '';
  const table = typeof config.table === 'string' ? config.table : '';
  if (!databaseId || !table) throw new Error('db_update: missing databaseId or table');
  const where = jsonParse<Record<string, unknown>>(config.whereJson, {});
  const patch = jsonParse<Record<string, unknown>>(config.patchJson, {});
  if (Object.keys(where).length === 0) throw new Error('db_update: where clause cannot be empty (refusing to update all rows)');
  if (Object.keys(patch).length === 0) throw new Error('db_update: patch cannot be empty');

  // Endpoint reale: POST /api/v1/db/databases/:id/update (db-studio.ts), schema
  // UpdateRowSchema = { table, where, patch }, tenant-scoped via service.updateRow.
  // Contratto verificato in db-write.contract.test.ts.
  const result = await callDb(`/databases/${encodeURIComponent(assertDatabaseId(databaseId, 'db_update'))}/update`, { table, where, patch }, context.tenantId);
  return { output: result, durationMs: Date.now() - start };
};

export const dbDeleteExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const databaseId = typeof config.databaseId === 'string' ? config.databaseId : '';
  const table = typeof config.table === 'string' ? config.table : '';
  if (!databaseId || !table) throw new Error('db_delete: missing databaseId or table');
  const where = jsonParse<Record<string, unknown>>(config.whereJson, {});
  if (Object.keys(where).length === 0) throw new Error('db_delete: where clause cannot be empty (refusing to delete all rows)');
  const confirmed = config.confirmDelete === true || config.confirmDelete === 'true';
  if (!confirmed) throw new Error('db_delete: confirmDelete must be true (idiot-proof guard)');

  const result = await callDb(`/databases/${encodeURIComponent(assertDatabaseId(databaseId, 'db_delete'))}/delete`, { table, where }, context.tenantId);
  return { output: result, durationMs: Date.now() - start };
};
