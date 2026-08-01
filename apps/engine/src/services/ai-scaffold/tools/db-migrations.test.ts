/**
 * Tests createDatabaseHandler — fix 2026-05-29.
 *
 * Bug: scaffold faceva abort se l'utente non aveva DB configurati →
 * "Stream chiuso senza un risultato". Fix: nuovo tool create_database
 * che istanzia un SQLite locale on-demand (no host/credentials).
 *
 * Invarianti 2026-grade:
 *  - name required + regex valida (a-z + _ + max 63)
 *  - kind: 'sqlite' default (no setup esterno)
 *  - tenantId injected dalla session (cross-tenant safety)
 *  - error path: dbStudio.create throws → ToolResult.ok=false
 *  - SECURITY: name injection (`; DROP TABLE`) refused dal regex
 */
import { describe, it, expect, vi } from 'vitest';
import { createDatabaseHandler } from './db-migrations.js';

vi.mock('@/lib/logger.js');

function makeSession(opts: { tenantId?: string; createImpl?: (input: unknown) => unknown } = {}) {
  const tenantId = opts.tenantId ?? 'tenant-test';
  const createFn = vi.fn(opts.createImpl ?? ((input: unknown) => ({
    id: 'db_abc123',
    createdAt: '2026-05-29T00:00:00Z',
    updatedAt: '2026-05-29T00:00:00Z',
    ...(input as object),
  })));
  return {
    tenantId,
    dbStudio: { create: createFn },
    createCalls: createFn,
  } as unknown as Parameters<typeof createDatabaseHandler>[0] & { createCalls: typeof createFn };
}

describe('createDatabaseHandler — happy path', () => {
  it('crea SQLite database con name + tenant injected', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: 'workflow_data' });
    expect(r.ok).toBe(true);
    expect(s.createCalls).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-test',
      name: 'workflow_data',
      connection: expect.objectContaining({ engine: 'sqlite', embedded: true }),
    }));
    if (r.ok) {
      const data = r.data as { databaseId: string; name: string };
      expect(data.databaseId).toBe('db_abc123');
      expect(data.name).toBe('workflow_data');
    }
  });

  it('description default se omessa', async () => {
    const s = makeSession();
    await createDatabaseHandler(s, { name: 'mydb' });
    expect(s.createCalls).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Database creato da AI scaffold',
    }));
  });

  it('description custom rispettata', async () => {
    const s = makeSession();
    await createDatabaseHandler(s, { name: 'mydb', description: 'Custom note' });
    expect(s.createCalls).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Custom note',
    }));
  });

  it('SQLite embedded — no host/credentials necessari', async () => {
    const s = makeSession();
    await createDatabaseHandler(s, { name: 'workflow_data' });
    const arg = s.createCalls.mock.calls[0]?.[0] as {
      connection: { engine: string; embedded: boolean; hostname?: string; username?: string };
      tables: unknown[];
      relations: unknown[];
    };
    expect(arg.connection.engine).toBe('sqlite');
    expect(arg.connection.embedded).toBe(true);
    expect(arg.connection.hostname).toBeUndefined();
    expect(arg.connection.username).toBeUndefined();
    expect(arg.tables).toEqual([]);
    expect(arg.relations).toEqual([]);
  });
});

describe('createDatabaseHandler — validation', () => {
  it('name vuoto → error', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
  });

  it('name missing → error', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, {});
    expect(r.ok).toBe(false);
  });

  it('name solo whitespace → error', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: '   ' });
    expect(r.ok).toBe(false);
  });

  it('SECURITY: name con SQL injection chars → error', async () => {
    const s = makeSession();
    const attacks = [
      "'; DROP TABLE users; --",
      'data"; DELETE FROM',
      'name OR 1=1',
      '../path/traversal',
      'data with spaces',
    ];
    for (const name of attacks) {
      const r = await createDatabaseHandler(s, { name });
      expect(r.ok, `name "${name}" should be rejected`).toBe(false);
    }
  });

  it('name inizio con cifra → error', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: '1data' });
    expect(r.ok).toBe(false);
  });

  it('name underscore + lettere ok', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: 'workflow_data_v2' });
    expect(r.ok).toBe(true);
  });

  it('name >63 char → error', async () => {
    const s = makeSession();
    const r = await createDatabaseHandler(s, { name: 'a'.repeat(64) });
    expect(r.ok).toBe(false);
  });
});

describe('createDatabaseHandler — error propagation', () => {
  it('dbStudio.create throws → ToolResult ok=false con msg utile', async () => {
    const s = makeSession({
      createImpl: () => { throw new Error('SQLite: database already exists'); },
    });
    const r = await createDatabaseHandler(s, { name: 'workflow_data' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/create_database fallita/i);
      expect(r.error).toMatch(/already exists/);
    }
  });

  it('non-Error throw → string fallback', async () => {
    const s = makeSession({
      createImpl: () => { throw 'string error'; },
    });
    const r = await createDatabaseHandler(s, { name: 'mydb' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('string error');
  });
});
