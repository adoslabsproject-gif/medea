/**
 * managed-db-client — il runtime tenant (NO Docker socket) chiede al PORTAL di
 * provisionare/distruggere un DB sidecar per il proprio workspace, via la route
 * interna `/api/v1/internal/tenant-db`. Stesso pattern di telemetry-emitter:
 * internalAwareFetch + X-Internal-Token = token shared del portal.
 *
 * `provisionManagedDb` ritorna la connessione (incl. password) che il chiamante
 * salva nella Database del DB Studio (sqlite tenant isolato).
 *
 * @module services/db-studio/managed-db-client
 */
import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';
import { loggerFor } from '@/lib/logger.js';

interface ProvisionBody {
  ok?: boolean;
  connection?: ManagedDbConnection;
  code?: string;
  error?: string;
}

const log = loggerFor('db-studio.managed-client');
const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://host.docker.internal:3006';
const PROVISION_TIMEOUT_MS = 180_000; // pull immagine + init DB può richiedere minuti

/** Engine che possono essere provisionati come sidecar nel tenant (managed). */
const MANAGED_ENGINES = new Set([
  'postgres',
  'pgvector',
  'mysql',
  'mssql',
  'mongodb',
  'redis',
  'qdrant',
]);
export function isManagedEngine(engine: string): boolean {
  return MANAGED_ENGINES.has(engine);
}

export interface ManagedDbConnection {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export class ManagedDbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedDbError';
  }
}

/** Provisiona (o riusa) il sidecar e ritorna la connessione interna. */
export async function provisionManagedDb(
  workspaceId: string,
  engine: string,
): Promise<ManagedDbConnection> {
  const res = await internalAwareFetch(`${PORTAL_URL}/api/v1/internal/tenant-db/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': getOutboundPortalToken() },
    body: JSON.stringify({ workspaceId, engine }),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
  });
  const body = await readJsonCapped<ProvisionBody>(res).catch((): ProvisionBody => ({}));
  if (!res.ok || !body.ok || !body.connection) {
    log.warn(
      { workspaceId, engine, status: res.status, code: body.code },
      'managed DB provision failed',
    );
    throw new ManagedDbError(
      body.code ?? `HTTP_${res.status.toString()}`,
      body.error ?? `Provisioning del DB "${engine}" non riuscito.`,
    );
  }
  log.info({ workspaceId, engine, host: body.connection.host }, 'managed DB provisioned');
  return body.connection;
}

/** Distrugge il sidecar (erasure dati). Best-effort: logga ma non lancia. */
export async function destroyManagedDb(workspaceId: string, engine: string): Promise<void> {
  try {
    await internalAwareFetch(`${PORTAL_URL}/api/v1/internal/tenant-db/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': getOutboundPortalToken() },
      body: JSON.stringify({ workspaceId, engine }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    log.warn(
      { workspaceId, engine, err: err instanceof Error ? err.message : String(err) },
      'managed DB destroy failed (best-effort)',
    );
  }
}
