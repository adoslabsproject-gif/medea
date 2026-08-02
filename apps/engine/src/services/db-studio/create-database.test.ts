/**
 * Test — createTenantDatabase (logica condivisa route + tool DB-agent).
 * provisionManagedDb è mockato (niente portal reale); DbStudioService è un fake
 * che cattura la connection con cui il DB viene creato.
 *
 * @module services/db-studio/create-database.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '@medea/engine-db-studio-core';

const provisionMock = vi.fn<(...a: unknown[]) => Promise<unknown>>();
class ManagedDbError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ManagedDbError'; }
}
vi.mock('./managed-db-client.js', () => ({
  isManagedEngine: (e: string) => ['postgres', 'pgvector', 'mysql', 'mssql', 'mongodb', 'redis', 'qdrant'].includes(e),
  provisionManagedDb: (...a: unknown[]) => provisionMock(...a),
  ManagedDbError,
}));

const { createTenantDatabase, CreateDatabaseError, isEmbeddedEngine } = await import('./create-database.js');

interface CreateCall { connection: Database['connection']; name: string; tenantId: string }
let lastCreate: CreateCall | null = null;
function fakeDbStudio() {
  return {
    create: (input: Omit<Database, 'id' | 'createdAt' | 'updatedAt'>): Database => {
      lastCreate = { connection: input.connection, name: input.name, tenantId: input.tenantId };
      return { ...input, id: 'db-new', createdAt: '', updatedAt: '' };
    },
  } as unknown as Parameters<typeof createTenantDatabase>[0]['dbStudio'];
}

beforeEach(() => { provisionMock.mockReset(); lastCreate = null; });

describe('createTenantDatabase — EMBEDDED', () => {
  it('sqlite (default) → connection embedded, niente provisioning', async () => {
    const db = await createTenantDatabase({ tenantId: 't', name: 'app', engine: 'sqlite', managed: false, dbStudio: fakeDbStudio() });
    expect(db.id).toBe('db-new');
    expect(lastCreate?.connection).toMatchObject({ engine: 'sqlite', embedded: true });
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('duckdb e vector-embedded sono embedded validi', async () => {
    expect(isEmbeddedEngine('duckdb')).toBe(true);
    expect(isEmbeddedEngine('vector-embedded')).toBe(true);
    await createTenantDatabase({ tenantId: 't', name: 'a', engine: 'duckdb', managed: false, dbStudio: fakeDbStudio() });
    expect(lastCreate?.connection.engine).toBe('duckdb');
  });

  it('🚨 engine server SENZA managed → ENGINE_NEEDS_CONNECTION (no credenziali inventate)', async () => {
    await expect(createTenantDatabase({ tenantId: 't', name: 'a', engine: 'postgres', managed: false, dbStudio: fakeDbStudio() }))
      .rejects.toMatchObject({ code: 'ENGINE_NEEDS_CONNECTION' });
    expect(provisionMock).not.toHaveBeenCalled();
  });
});

describe('createTenantDatabase — MANAGED (sidecar nel tenant)', () => {
  it('postgres managed → provisiona + salva la connection risolta al sidecar', async () => {
    provisionMock.mockResolvedValueOnce({ engine: 'postgres', host: 'ff-db-postgres-t', port: 5432, database: 'app', username: 'u', password: 'SECRET' });
    const db = await createTenantDatabase({ tenantId: 't', name: 'crm', engine: 'postgres', managed: true, dbStudio: fakeDbStudio() });
    expect(provisionMock).toHaveBeenCalledWith('t', 'postgres');
    expect(db.id).toBe('db-new');
    expect(lastCreate?.connection).toMatchObject({
      engine: 'postgres', embedded: false, managed: true, provisionStatus: 'ready',
      hostname: 'ff-db-postgres-t', port: 5432, database: 'app', username: 'u',
      passwordSecretRef: 'SECRET', sslMode: 'disable',
    });
  });

  it('🚨 engine non installabile (sqlite) con managed=true → ENGINE_NOT_MANAGEABLE, niente provision', async () => {
    await expect(createTenantDatabase({ tenantId: 't', name: 'a', engine: 'sqlite', managed: true, dbStudio: fakeDbStudio() }))
      .rejects.toMatchObject({ code: 'ENGINE_NOT_MANAGEABLE' });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(lastCreate).toBeNull();
  });

  it('🚨 provisioning fallito (ManagedDbError) → propagato, nessun DB creato (no riga orfana)', async () => {
    provisionMock.mockRejectedValueOnce(new ManagedDbError('PULL_FAILED', 'immagine non scaricata'));
    await expect(createTenantDatabase({ tenantId: 't', name: 'a', engine: 'mongodb', managed: true, dbStudio: fakeDbStudio() }))
      .rejects.toThrow(/immagine non scaricata/u);
    expect(lastCreate).toBeNull();
  });

  it('CreateDatabaseError è esportato e tipizzato col code', () => {
    const e = new CreateDatabaseError('ENGINE_NOT_MANAGEABLE', 'x');
    expect(e.code).toBe('ENGINE_NOT_MANAGEABLE');
    expect(e).toBeInstanceOf(Error);
  });
});
