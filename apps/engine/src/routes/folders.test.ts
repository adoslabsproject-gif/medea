/**
 * Test 2026-grade — folders route (hierarchical workflow organization).
 *
 * 🚨 BUG SURFACE:
 *  - Parent validation: solo se parentId stringa NON-vuota → check
 *  - Self-parenting prevention: cannot parent under itself
 *  - DELETE refuse se workflows pinnati (count > 0 → 409)
 *  - DELETE re-parent children to null (no orphan dangling)
 *  - TENANT isolation: ogni query WHERE tenant_id (no cross-tenant)
 *
 * 🚨 INPUT: name.trim() richiesto non-vuoto (whitespace only → 400)
 *
 * Uso SQLite REALE :memory: per testare query/transazioni vere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const mockDb = { sqlite: null as DB | null };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: mockDb.sqlite }),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'tenant-A',
}));

const { createFolderRoutes } = await import('./folders.js');

function setupSchema(db: DB): void {
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      folder_id TEXT
    );
  `);
  // F2 (2026-06-10): workflow_folders NON è più creata on-first-call dal route
  // (DDL inline rimosso → ora in SCHEMA_SQL/runMigrations). Il test la semina
  // qui con lo schema CANONICO identico a migrate.schema.ts. Il drift-guard
  // vero è in storage/migrate.test.ts (verifica runMigrations contro DB reale).
  db.exec(`
    CREATE TABLE workflow_folders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      parent_id TEXT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX workflow_folders_tenant_idx ON workflow_folders(tenant_id, parent_id);
  `);
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/v1', createFolderRoutes());
  return app;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  tenantId = 'tenant-A',
): Promise<Response> {
  return makeApp().request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.sqlite = new Database(':memory:');
  setupSchema(mockDb.sqlite);
});

describe('🚨 GET /folders — list', () => {
  it('🚨 lista vuota → []', async () => {
    const res = await req('GET', '/api/v1/folders');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { folders: unknown[] };
    expect(json.folders).toEqual([]);
  });

  it('🚨 ritorna folders del tenant ORDERED by name', async () => {
    await req('POST', '/api/v1/folders', { name: 'Zebra' });
    await req('POST', '/api/v1/folders', { name: 'Alpha' });
    await req('POST', '/api/v1/folders', { name: 'Mango' });
    const res = await req('GET', '/api/v1/folders');
    const json = (await res.json()) as {
      folders: { name: string; parentId: string | null; createdAt: string }[];
    };
    expect(json.folders.map((f) => f.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('🚨 SECURITY tenant isolation: folder tenant-B NOT visible to tenant-A', async () => {
    await req('POST', '/api/v1/folders', { name: 'B-folder' }, 'tenant-B');
    const res = await req('GET', '/api/v1/folders', undefined, 'tenant-A');
    const json = (await res.json()) as { folders: unknown[] };
    expect(json.folders).toEqual([]);
  });

  it('🚨 mapping snake_case → camelCase (parentId, createdAt, updatedAt)', async () => {
    await req('POST', '/api/v1/folders', { name: 'X' });
    const res = await req('GET', '/api/v1/folders');
    const json = (await res.json()) as {
      folders: { parentId: unknown; createdAt: string; updatedAt: string }[];
    };
    expect(json.folders[0]).toHaveProperty('parentId');
    expect(json.folders[0]).toHaveProperty('createdAt');
    expect(json.folders[0]).toHaveProperty('updatedAt');
  });
});

describe('🚨 POST /folders — create', () => {
  it('🚨 happy: 201 + id + name + parentId=null + timestamps', async () => {
    const res = await req('POST', '/api/v1/folders', { name: 'My Folder' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      id: string;
      name: string;
      parentId: null;
      createdAt: string;
      updatedAt: string;
    };
    expect(json.id).toMatch(/^[A-Za-z0-9_-]+$/u); // nanoid
    expect(json.name).toBe('My Folder');
    expect(json.parentId).toBeNull();
    expect(json.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 body assente / null → 400', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 name assente → 400', async () => {
    const res = await req('POST', '/api/v1/folders', {});
    expect(res.status).toBe(400);
  });

  it('🚨 name whitespace only → 400 (trim → empty)', async () => {
    const res = await req('POST', '/api/v1/folders', { name: '   \t  ' });
    expect(res.status).toBe(400);
  });

  it('🚨 name con whitespace → trimmed', async () => {
    const res = await req('POST', '/api/v1/folders', { name: '  Trimmed Name  ' });
    const json = (await res.json()) as { name: string };
    expect(json.name).toBe('Trimmed Name');
  });

  it('🚨 parentId stringa NON-empty + non esiste → 404', async () => {
    const res = await req('POST', '/api/v1/folders', { name: 'X', parentId: 'ghost-parent' });
    expect(res.status).toBe(404);
  });

  it('🚨 parentId stringa empty "" → trattato come null (no check)', async () => {
    const res = await req('POST', '/api/v1/folders', { name: 'X', parentId: '' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { parentId: null };
    expect(json.parentId).toBeNull();
  });

  it('🚨 parentId valido → 201 + parentId preservato', async () => {
    const parent = await req('POST', '/api/v1/folders', { name: 'Parent' });
    const parentJson = (await parent.json()) as { id: string };
    const child = await req('POST', '/api/v1/folders', { name: 'Child', parentId: parentJson.id });
    const childJson = (await child.json()) as { parentId: string };
    expect(childJson.parentId).toBe(parentJson.id);
  });

  it('🚨 SECURITY: parentId di altro tenant → 404 (no cross-tenant)', async () => {
    const tA = await req('POST', '/api/v1/folders', { name: 'A-Parent' }, 'tenant-A');
    const tAJson = (await tA.json()) as { id: string };
    const tB = await req(
      'POST',
      '/api/v1/folders',
      { name: 'B-Child', parentId: tAJson.id },
      'tenant-B',
    );
    expect(tB.status).toBe(404);
  });
});

describe('🚨 PATCH /folders/:id — update', () => {
  let folderId: string;

  beforeEach(async () => {
    const res = await req('POST', '/api/v1/folders', { name: 'Original' });
    folderId = ((await res.json()) as { id: string }).id;
  });

  it('🚨 folder non esiste → 404', async () => {
    const res = await req('PATCH', '/api/v1/folders/non-existent', { name: 'X' });
    expect(res.status).toBe(404);
  });

  it('🚨 body null → 400', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v1/folders/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 name update + updatedAt ISO refreshed', async () => {
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { name: 'Renamed' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; updatedAt: string };
    expect(json.name).toBe('Renamed');
    expect(json.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 name empty/whitespace → keep current (no overwrite con vuoto)', async () => {
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { name: '   ' });
    const json = (await res.json()) as { name: string };
    expect(json.name).toBe('Original');
  });

  it('🚨 parentId=null EXPLICITLY → detach (parentId → null)', async () => {
    const parent = await req('POST', '/api/v1/folders', { name: 'P' });
    const parentId = ((await parent.json()) as { id: string }).id;
    await req('PATCH', `/api/v1/folders/${folderId}`, { parentId });
    // Ora detach
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { parentId: null });
    const json = (await res.json()) as { parentId: string | null };
    expect(json.parentId).toBeNull();
  });

  it('🚨 SECURITY: parent SE STESSO → 400 "Cannot parent under itself"', async () => {
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { parentId: folderId });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/parent.*itself/u);
  });

  it('🚨 SECURITY tenant isolation: PATCH altro tenant → 404', async () => {
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { name: 'pwn' }, 'tenant-B');
    expect(res.status).toBe(404);
  });

  it('🚨 parentId vuoto + name change → preserva current parentId', async () => {
    const parent = await req('POST', '/api/v1/folders', { name: 'P' });
    const parentId = ((await parent.json()) as { id: string }).id;
    await req('PATCH', `/api/v1/folders/${folderId}`, { parentId });
    // Update solo name
    const res = await req('PATCH', `/api/v1/folders/${folderId}`, { name: 'Newer' });
    const json = (await res.json()) as { parentId: string | null };
    expect(json.parentId).toBe(parentId);
  });
});

describe('🚨 DELETE /folders/:id', () => {
  let folderId: string;

  beforeEach(async () => {
    const res = await req('POST', '/api/v1/folders', { name: 'ToDelete' });
    folderId = ((await res.json()) as { id: string }).id;
  });

  it('🚨 happy: folder vuoto → removed:true', async () => {
    const res = await req('DELETE', `/api/v1/folders/${folderId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { removed: boolean };
    expect(json.removed).toBe(true);
    // Verify gone
    const list = await req('GET', '/api/v1/folders');
    const listJson = (await list.json()) as { folders: unknown[] };
    expect(listJson.folders).toEqual([]);
  });

  it('🚨 REFUSE: workflow pinnato → 409 con count', async () => {
    mockDb
      .sqlite!.prepare('INSERT INTO workflows (id, tenant_id, folder_id) VALUES (?, ?, ?)')
      .run('wf-1', 'tenant-A', folderId);
    const res = await req('DELETE', `/api/v1/folders/${folderId}`);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/1 workflow\(s\)/u);
  });

  it('🚨 DELETE re-parent children → null (no orphan dangling)', async () => {
    const child = await req('POST', '/api/v1/folders', { name: 'Child', parentId: folderId });
    const childId = ((await child.json()) as { id: string }).id;
    await req('DELETE', `/api/v1/folders/${folderId}`);
    // Child esiste ancora con parent_id=NULL
    const list = await req('GET', '/api/v1/folders');
    const listJson = (await list.json()) as { folders: { id: string; parentId: string | null }[] };
    const remaining = listJson.folders.find((f) => f.id === childId);
    expect(remaining).toBeDefined();
    expect(remaining!.parentId).toBeNull();
  });

  it('🚨 SECURITY tenant isolation: DELETE altro tenant → no-op (removed:false)', async () => {
    const res = await req('DELETE', `/api/v1/folders/${folderId}`, undefined, 'tenant-B');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { removed: boolean };
    expect(json.removed).toBe(false);
    // Folder ancora esiste per tenant-A
    const list = await req('GET', '/api/v1/folders');
    const listJson = (await list.json()) as { folders: unknown[] };
    expect(listJson.folders).toHaveLength(1);
  });

  it('🚨 DELETE folder NON-esistente → removed:false (no 404, idempotent)', async () => {
    const res = await req('DELETE', '/api/v1/folders/ghost');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { removed: boolean };
    expect(json.removed).toBe(false);
  });
});

describe('🚨 multi-tenant isolation E2E', () => {
  it('🚨 tenant A e B operano in silos completamente isolati', async () => {
    await req('POST', '/api/v1/folders', { name: 'A1' }, 'tenant-A');
    await req('POST', '/api/v1/folders', { name: 'A2' }, 'tenant-A');
    await req('POST', '/api/v1/folders', { name: 'B1' }, 'tenant-B');

    const listA = (await (await req('GET', '/api/v1/folders', undefined, 'tenant-A')).json()) as {
      folders: unknown[];
    };
    const listB = (await (await req('GET', '/api/v1/folders', undefined, 'tenant-B')).json()) as {
      folders: unknown[];
    };
    expect(listA.folders).toHaveLength(2);
    expect(listB.folders).toHaveLength(1);
  });
});
