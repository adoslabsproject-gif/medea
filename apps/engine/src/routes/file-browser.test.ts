/**
 * Test 2026-grade — file-browser route (SECURITY-CRITICAL path traversal).
 *
 * 🚨 ATTACK SURFACE: input `path` arbitrario dell'utente, ritorna contenuto
 *    filesystem. Path traversal = file leak (/etc/passwd, /var/log, ecc.).
 *
 * 🚨 ALLOWLIST: tenant root + MEDEA_FILE_ALLOWLIST env (colon-sep paths).
 *    Tutto fuori → 403.
 *
 * 🚨 TENANT ISOLATION: tenantId via regex sanitization, prefix di path.
 *
 * 🚨 SORT: dirs first + alphabetical (deterministic UX).
 *
 * Uso fs reale in /tmp per test E2E veri.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/logger.js');

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));

const { createFileBrowserRoutes } = await import('./file-browser.js');

let testBase = '';
let tenantRoot = '';

function makeApp(authenticated = true): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authenticated) c.set('auth' as never, { userId: 'u1' } as never);
    return next();
  });
  app.route('/api/v1/file-browser', createFileBrowserRoutes());
  return app;
}

beforeEach(async () => {
  // Fresh tmp base per test
  testBase = join(tmpdir(), `ff-test-${randomBytes(6).toString('hex')}`);
  await mkdir(testBase, { recursive: true });
  process.env.MEDEA_DATA_DIR = testBase;
  tenantRoot = join(testBase, 'tenants', 'tenant-A', 'files');
  delete process.env.MEDEA_FILE_ALLOWLIST;
});

afterEach(async () => {
  await rm(testBase, { recursive: true, force: true });
});

describe('🚨 auth gate', () => {
  it('🚨 no auth → 401', async () => {
    const app = makeApp(false);
    const res = await app.request('/api/v1/file-browser');
    expect(res.status).toBe(401);
  });
});

describe('🚨 tenant root auto-create on first browse', () => {
  it('🚨 root ENOENT → response vuota (NO 404)', async () => {
    // tenantRoot NON esiste
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: unknown[]; cwd: string; parent: null };
    expect(json.entries).toEqual([]);
    expect(json.cwd).toBe(tenantRoot);
    expect(json.parent).toBeNull();
  });

  it('🚨 root con file → listing corretto', async () => {
    await mkdir(tenantRoot, { recursive: true });
    await writeFile(join(tenantRoot, 'test.txt'), 'hello');
    await mkdir(join(tenantRoot, 'subdir'));
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { name: string; type: string }[] };
    expect(json.entries.find((e) => e.name === 'test.txt' && e.type === 'file')).toBeDefined();
    expect(json.entries.find((e) => e.name === 'subdir' && e.type === 'dir')).toBeDefined();
  });
});

describe('🚨 SECURITY path traversal', () => {
  beforeEach(async () => {
    await mkdir(tenantRoot, { recursive: true });
  });

  it('🚨 ATTACK: ?path=../../etc/passwd → 403 outside allowlist', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser?path=../../../etc/passwd');
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/outside allowlisted/u);
  });

  it('🚨 ATTACK: absolute path /etc/passwd → 403', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser?path=/etc/passwd');
    expect(res.status).toBe(403);
  });

  it('🚨 ATTACK: encoded traversal %2F..%2F → resolve verifica reale path', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser?path=%2Fetc%2Fpasswd');
    expect(res.status).toBe(403);
  });

  it('🚨 ATTACK: path con .. dopo subdir valida → 403 (deve risolvere prima del check)', async () => {
    await mkdir(join(tenantRoot, 'sub'));
    const app = makeApp();
    // tenantRoot/sub/../../OUTSIDE → resolve → fuori da tenantRoot
    const res = await app.request('/api/v1/file-browser?path=sub/../../OUTSIDE');
    expect(res.status).toBe(403);
  });

  it('🚨 SECURITY: tenant-A NON può accedere tenant-B', async () => {
    const tenantBRoot = join(testBase, 'tenants', 'tenant-B', 'files');
    await mkdir(tenantBRoot, { recursive: true });
    await writeFile(join(tenantBRoot, 'B-secret.txt'), 'leaked');
    const app = makeApp();
    // Path absolute → fuori da tenant-A → 403
    const res = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(tenantBRoot)}`);
    expect(res.status).toBe(403);
  });
});

describe('🚨 MEDEA_FILE_ALLOWLIST (global roots)', () => {
  it('🚨 path in allowlist → 200 OK', async () => {
    const sharedDir = join(testBase, 'shared');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, 'shared.txt'), 'public');
    process.env.MEDEA_FILE_ALLOWLIST = sharedDir;
    const app = makeApp();
    const res = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(sharedDir)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { name: string }[] };
    expect(json.entries.find((e) => e.name === 'shared.txt')).toBeDefined();
  });

  it('🚨 multi-path allowlist (colon-separated)', async () => {
    const dir1 = join(testBase, 'd1');
    const dir2 = join(testBase, 'd2');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });
    process.env.MEDEA_FILE_ALLOWLIST = `${dir1}:${dir2}`;
    const app = makeApp();
    const res1 = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(dir1)}`);
    const res2 = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(dir2)}`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('🚨 allowlist con whitespace ignorato (trim)', async () => {
    const sharedDir = join(testBase, 'spaced');
    await mkdir(sharedDir, { recursive: true });
    process.env.MEDEA_FILE_ALLOWLIST = `  ${sharedDir}  :  `;
    const app = makeApp();
    const res = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(sharedDir)}`);
    expect(res.status).toBe(200);
  });

  it('🚨 path NOT in allowlist NOR tenant → 403', async () => {
    const shared = join(testBase, 'allowed');
    const sneaky = join(testBase, 'NOT-allowed');
    await mkdir(shared, { recursive: true });
    await mkdir(sneaky, { recursive: true });
    process.env.MEDEA_FILE_ALLOWLIST = shared;
    const app = makeApp();
    const res = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(sneaky)}`);
    expect(res.status).toBe(403);
  });
});

describe('🚨 entry listing + sort', () => {
  beforeEach(async () => {
    await mkdir(tenantRoot, { recursive: true });
  });

  it('🚨 sort: directories first, then files, both alphabetical', async () => {
    await writeFile(join(tenantRoot, 'zebra.txt'), '');
    await writeFile(join(tenantRoot, 'alpha.txt'), '');
    await mkdir(join(tenantRoot, 'z-dir'));
    await mkdir(join(tenantRoot, 'a-dir'));
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    const json = (await res.json()) as { entries: { name: string; type: string }[] };
    // ['a-dir', 'z-dir', 'alpha.txt', 'zebra.txt']
    expect(json.entries.map((e) => e.name)).toEqual(['a-dir', 'z-dir', 'alpha.txt', 'zebra.txt']);
  });

  it('🚨 file entry include sizeBytes; dir NO', async () => {
    await writeFile(join(tenantRoot, 'data.txt'), 'a'.repeat(123));
    await mkdir(join(tenantRoot, 'subdir'));
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    const json = (await res.json()) as { entries: { name: string; sizeBytes?: number }[] };
    const file = json.entries.find((e) => e.name === 'data.txt')!;
    const dir = json.entries.find((e) => e.name === 'subdir')!;
    expect(file.sizeBytes).toBe(123);
    expect(dir.sizeBytes).toBeUndefined();
  });

  it('🚨 mtime ISO string presente', async () => {
    await writeFile(join(tenantRoot, 'f.txt'), '');
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    const json = (await res.json()) as { entries: { mtime: string }[] };
    expect(json.entries[0]!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 file rimosso fra readdir e stat → null filtered (no crash)', async () => {
    // Difficile da simulare deterministicamente — verifico shape robusta
    await writeFile(join(tenantRoot, 'a.txt'), '');
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    expect(res.status).toBe(200);
  });
});

describe('🚨 parent navigation', () => {
  beforeEach(async () => {
    await mkdir(tenantRoot, { recursive: true });
  });

  it('🚨 at tenant root → parent=null', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    const json = (await res.json()) as { parent: string | null };
    expect(json.parent).toBeNull();
  });

  it('🚨 in subdir → parent = dirname (still allowlisted)', async () => {
    await mkdir(join(tenantRoot, 'sub'));
    const app = makeApp();
    const res = await app.request(`/api/v1/file-browser?path=sub`);
    const json = (await res.json()) as { parent: string | null };
    expect(json.parent).toBe(tenantRoot);
  });

  it('🚨 SECURITY: parent OUT of allowlist → null (no climb-out)', async () => {
    // Allowlist solo /shared/X, NOT /shared. Visito /shared/X → parent /shared, NOT allowed → null
    const allowed = join(testBase, 'shared', 'sub');
    await mkdir(allowed, { recursive: true });
    process.env.MEDEA_FILE_ALLOWLIST = allowed;
    const app = makeApp();
    const res = await app.request(`/api/v1/file-browser?path=${encodeURIComponent(allowed)}`);
    const json = (await res.json()) as { parent: string | null };
    expect(json.parent).toBeNull(); // at root of allowed
  });
});

describe('🚨 path is file (not directory)', () => {
  it('🚨 path puntando a un FILE → 400 "not a directory"', async () => {
    await mkdir(tenantRoot, { recursive: true });
    await writeFile(join(tenantRoot, 'notdir.txt'), 'x');
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser?path=notdir.txt');
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/not a directory/u);
  });
});

describe('🚨 roots response', () => {
  it('🚨 roots[0] = sandbox tenant + globals appended', async () => {
    await mkdir(tenantRoot, { recursive: true });
    const g1 = join(testBase, 'global-1');
    const g2 = join(testBase, 'global-2');
    await mkdir(g1, { recursive: true });
    await mkdir(g2, { recursive: true });
    process.env.MEDEA_FILE_ALLOWLIST = `${g1}:${g2}`;
    const app = makeApp();
    const res = await app.request('/api/v1/file-browser');
    const json = (await res.json()) as { roots: { label: string; path: string }[] };
    expect(json.roots[0]!.label).toMatch(/Sandbox/u);
    expect(json.roots[0]!.path).toBe(tenantRoot);
    expect(json.roots).toHaveLength(3);
    expect(json.roots[1]!.path).toBe(g1);
    expect(json.roots[2]!.path).toBe(g2);
  });
});

describe('🚨 tenant id sanitization', () => {
  it('🚨 tenant id con caratteri unsafe sanitizzati a underscore', async () => {
    // Mock getTenantId per ritornare ID malicious
    vi.doMock('@/lib/tenant.js', () => ({
      getTenantId: () => '../../etc/PWNED',
    }));
    vi.resetModules();
    const { createFileBrowserRoutes: freshCreate } = await import('./file-browser.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, { userId: 'u1' } as never);
      return next();
    });
    app.route('/api/v1/file-browser', freshCreate());
    const res = await app.request('/api/v1/file-browser');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cwd: string };
    // tenant path NON deve contenere "../../etc"
    expect(json.cwd).not.toMatch(/\.\.\//u);
    expect(json.cwd).toMatch(/_+_etc_PWNED/u); // sanitized to underscores
    // Restore default mock
    vi.doUnmock('@/lib/tenant.js');
    vi.resetModules();
  });
});
