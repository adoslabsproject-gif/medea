/**
 * Test del client managed-db (runtime → portal). Mock di internalAwareFetch:
 * inchioda URL, header X-Internal-Token, body, e la gestione errori.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/internal-service-fetch.js', () => ({ internalAwareFetch: (...a: unknown[]) => fetchMock(...a) as unknown }));
vi.mock('@/lib/internal-token.js', () => ({ getOutboundPortalToken: () => 'shared-portal-token' }));

import { provisionManagedDb, destroyManagedDb, isManagedEngine, ManagedDbError } from './managed-db-client.js';

const okResp = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => { fetchMock.mockReset(); });

describe('isManagedEngine', () => {
  it('riconosce i sidecar, rifiuta embedded', () => {
    for (const e of ['postgres', 'mysql', 'mongodb', 'redis', 'mssql', 'qdrant', 'pgvector']) expect(isManagedEngine(e)).toBe(true);
    for (const e of ['sqlite', 'duckdb', 'vector-embedded', 'oracle']) expect(isManagedEngine(e)).toBe(false);
  });
});

describe('provisionManagedDb', () => {
  it('POST /internal/tenant-db/provision con token + body, ritorna connection', async () => {
    fetchMock.mockResolvedValue(okResp({ ok: true, connection: { engine: 'mongodb', host: 'ff-db-mongodb-w', port: 27017, database: 'tenant_db', username: 'ff_app', password: 'P-w0rd_x' }, status: 'ready' }));
    const conn = await provisionManagedDb('ws-1', 'mongodb');
    expect(conn).toMatchObject({ host: 'ff-db-mongodb-w', port: 27017, username: 'ff_app', password: 'P-w0rd_x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/internal/tenant-db/provision');
    expect((init as { headers: Record<string, string> }).headers['X-Internal-Token']).toBe('shared-portal-token');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ workspaceId: 'ws-1', engine: 'mongodb' });
  });

  it('risposta ok:false → ManagedDbError col code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, code: 'NOT_READY', error: 'non pronto' }), { status: 504 }));
    await expect(provisionManagedDb('ws-1', 'mssql')).rejects.toBeInstanceOf(ManagedDbError);
  });

  it('HTTP error senza body → ManagedDbError', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 502 }));
    await expect(provisionManagedDb('ws-1', 'postgres')).rejects.toBeInstanceOf(ManagedDbError);
  });
});

describe('destroyManagedDb', () => {
  it('best-effort: non lancia mai (anche se il portal fallisce)', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(destroyManagedDb('ws-1', 'redis')).resolves.toBeUndefined();
  });
});
