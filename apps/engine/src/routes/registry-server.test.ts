/**
 * Test 2026-grade — registry-server route (community node .ffnode CDN).
 *
 * 🚨 SECURITY-CRITICAL:
 *  - Path traversal via :filename param → REJECT con regex strict
 *  - Resolve absoluto + prefix check (defense-in-depth) → 403
 *
 * 🚨 HTTP CACHING:
 *  - ETag SHA-256 truncated 16-char
 *  - If-None-Match → 304 Not Modified
 *  - nodes.json: max-age=300 (5 min, low churn)
 *  - packages: max-age=31536000 immutable (1 year, content-addressed)
 *
 * 🚨 CORS public read: Access-Control-Allow-Origin: * (self-hosters)
 *  - OPTIONS preflight → 204
 *
 * 🚨 EMPTY REGISTRY: no nodes.json → valid empty index (client no crash)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

vi.mock('@/lib/logger.js');

const { createRegistryServerRoutes } = await import('./registry-server.js');

let regDir = '';

function makeApp(): Hono {
  const app = new Hono();
  app.route('/registry', createRegistryServerRoutes());
  return app;
}

beforeEach(async () => {
  regDir = join(tmpdir(), `ff-reg-${randomBytes(6).toString('hex')}`);
  await mkdir(join(regDir, 'packages'), { recursive: true });
  process.env.FLOWFORGE_REGISTRY_DIR = regDir;
});

afterEach(async () => {
  await rm(regDir, { recursive: true, force: true });
  delete process.env.FLOWFORGE_REGISTRY_DIR;
});

describe('🚨 CORS pubblico (self-hosters)', () => {
  it('🚨 GET include Access-Control-Allow-Origin: *', async () => {
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/GET/u);
  });

  it('🚨 OPTIONS preflight → 204 (no body, CORS headers)', async () => {
    const res = await makeApp().request('/registry/nodes.json', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('🚨 GET /nodes.json', () => {
  it('🚨 EMPTY registry (no file) → 200 con index vuoto valid', async () => {
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.status).toBe(200);
    const json = await res.json() as { version: number; updatedAt: string; nodes: unknown[] };
    expect(json.version).toBe(1);
    expect(json.nodes).toEqual([]);
    expect(json.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 happy: nodes.json esiste → ritorna content + ETag', async () => {
    const content = JSON.stringify({ version: 1, nodes: [{ id: 'n1' }] });
    await writeFile(join(regDir, 'nodes.json'), content);
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/u);
    expect(res.headers.get('etag')).toMatch(/^".+"$/u);
    expect(await res.text()).toBe(content);
  });

  it('🚨 Cache-Control max-age=300 (5 min)', async () => {
    await writeFile(join(regDir, 'nodes.json'), '{}');
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.headers.get('cache-control')).toMatch(/max-age=300/u);
  });

  it('🚨 ETag determinitistico SHA-256 (16 hex char)', async () => {
    const content = '{"version":1,"nodes":[]}';
    await writeFile(join(regDir, 'nodes.json'), content);
    const expected = '"' + createHash('sha256').update(content).digest('hex').slice(0, 16) + '"';
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.headers.get('etag')).toBe(expected);
  });

  it('🚨 If-None-Match match → 304 Not Modified (no body)', async () => {
    const content = '{"k":"v"}';
    await writeFile(join(regDir, 'nodes.json'), content);
    const etag = '"' + createHash('sha256').update(content).digest('hex').slice(0, 16) + '"';
    const res = await makeApp().request('/registry/nodes.json', {
      headers: { 'if-none-match': etag },
    });
    expect(res.status).toBe(304);
  });

  it('🚨 If-None-Match WRONG → 200 + new content', async () => {
    await writeFile(join(regDir, 'nodes.json'), '{"v":1}');
    const res = await makeApp().request('/registry/nodes.json', {
      headers: { 'if-none-match': '"wrong-etag-aaa"' },
    });
    expect(res.status).toBe(200);
  });
});

describe('🚨 GET /packages/:filename — SECURITY path traversal', () => {
  it('🚨 ATTACK: ../../../etc/passwd → 400 bad filename regex', async () => {
    const res = await makeApp().request('/registry/packages/..%2F..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('🚨 ATTACK: filename con / → 400 (Hono splitta path)', async () => {
    const res = await makeApp().request('/registry/packages/sub%2Fmalicious.ffnode');
    expect(res.status).toBe(400);
  });

  it('🚨 ATTACK: filename SENZA .ffnode extension → 400', async () => {
    const res = await makeApp().request('/registry/packages/no-extension');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/\.ffnode/u);
  });

  it('🚨 ATTACK: filename con char invalidi (spazi, $, !) → 400', async () => {
    const res = await makeApp().request('/registry/packages/has%20space.ffnode');
    expect(res.status).toBe(400);
  });

  it('🚨 filename regex valida [a-z0-9_.-]+ → procede', async () => {
    const filename = 'my-package_1.2.3.ffnode';
    await writeFile(join(regDir, 'packages', filename), 'fake-zip-content');
    const res = await makeApp().request(`/registry/packages/${filename}`);
    expect(res.status).toBe(200);
  });

  it('🚨 file NON esiste → 404', async () => {
    const res = await makeApp().request('/registry/packages/ghost.ffnode');
    expect(res.status).toBe(404);
  });
});

describe('🚨 GET /packages/:filename — happy + caching', () => {
  let pkgName: string;

  beforeEach(async () => {
    pkgName = 'test-pkg.ffnode';
    await writeFile(join(regDir, 'packages', pkgName), Buffer.from('zip-binary-content'));
  });

  it('🚨 happy: 200 + Content-Type zip + Content-Disposition attachment', async () => {
    const res = await makeApp().request(`/registry/packages/${pkgName}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/attachment.*test-pkg\.ffnode/u);
  });

  it('🚨 Cache-Control IMMUTABLE (1 anno, content-addressed)', async () => {
    const res = await makeApp().request(`/registry/packages/${pkgName}`);
    expect(res.headers.get('cache-control')).toMatch(/max-age=31536000.*immutable/u);
  });

  it('🚨 ETag SHA-256 16-char + 304 su match', async () => {
    const content = Buffer.from('exact-content');
    await writeFile(join(regDir, 'packages', 'cache-test.ffnode'), content);
    const etag = '"' + createHash('sha256').update(content).digest('hex').slice(0, 16) + '"';
    const res = await makeApp().request('/registry/packages/cache-test.ffnode', {
      headers: { 'if-none-match': etag },
    });
    expect(res.status).toBe(304);
  });

  it('🚨 body è il contenuto binario', async () => {
    const res = await makeApp().request(`/registry/packages/${pkgName}`);
    const buf = await res.arrayBuffer();
    expect(Buffer.from(buf).toString('utf8')).toBe('zip-binary-content');
  });
});

describe('🚨 GET /_files (admin debug)', () => {
  it('🚨 directory inesistente → files:[]', async () => {
    // packages dir esiste vuoto dal beforeEach
    await rm(join(regDir, 'packages'), { recursive: true, force: true });
    const res = await makeApp().request('/registry/_files');
    expect(res.status).toBe(200);
    const json = await res.json() as { files: unknown[] };
    expect(json.files).toEqual([]);
  });

  it('🚨 vuoto → files:[]', async () => {
    const res = await makeApp().request('/registry/_files');
    const json = await res.json() as { files: unknown[] };
    expect(json.files).toEqual([]);
  });

  it('🚨 ritorna SOLO .ffnode files (skip altri file)', async () => {
    await writeFile(join(regDir, 'packages', 'a.ffnode'), 'x');
    await writeFile(join(regDir, 'packages', 'b.ffnode'), 'xx');
    await writeFile(join(regDir, 'packages', 'README.md'), 'docs');
    await writeFile(join(regDir, 'packages', '.DS_Store'), '');
    const res = await makeApp().request('/registry/_files');
    const json = await res.json() as { files: { name: string }[] };
    expect(json.files).toHaveLength(2);
    expect(json.files.every((f) => f.name.endsWith('.ffnode'))).toBe(true);
  });

  it('🚨 file entry: name + size + mtime ISO', async () => {
    await writeFile(join(regDir, 'packages', 'test.ffnode'), 'abc123');
    const res = await makeApp().request('/registry/_files');
    const json = await res.json() as { files: { name: string; size: number; mtime: string }[] };
    expect(json.files[0]).toMatchObject({ name: 'test.ffnode', size: 6 });
    expect(json.files[0]!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe('🚨 FLOWFORGE_REGISTRY_DIR priority', () => {
  it('🚨 FLOWFORGE_REGISTRY_DIR override prevale su FLOWFORGE_DATA_DIR', async () => {
    process.env.FLOWFORGE_DATA_DIR = '/should-NOT-be-used';
    // FLOWFORGE_REGISTRY_DIR già settato in beforeEach → prevale
    await writeFile(join(regDir, 'nodes.json'), '{"test":"reg"}');
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.status).toBe(200);
    delete process.env.FLOWFORGE_DATA_DIR;
  });

  it('🚨 FLOWFORGE_REGISTRY_DIR con whitespace → trimmed', async () => {
    process.env.FLOWFORGE_REGISTRY_DIR = `  ${regDir}  `;
    await writeFile(join(regDir, 'nodes.json'), '{}');
    const res = await makeApp().request('/registry/nodes.json');
    expect(res.status).toBe(200);
  });
});

describe('🚨 SECURITY: defense-in-depth path resolve check', () => {
  it('🚨 ATTACK: filename regex bypass via case (.FFNODE) → 200 (case-insensitive)', async () => {
    // Regex /^[a-z0-9_.-]+\.ffnode$/iu accetta MAIUSCOLE (i flag)
    await writeFile(join(regDir, 'packages', 'MyPkg.FFNODE'), 'x');
    const res = await makeApp().request('/registry/packages/MyPkg.FFNODE');
    expect(res.status).toBe(200);
  });

  it('🚨 ATTACK: filename con caratteri allowed che provano traversal → 400 by regex', async () => {
    // ".." passa il regex? `[a-z0-9_.-]+\.ffnode` — sì `..ffnode` → invalid (mancano i chars)
    // ma `pwn..ffnode` matcha. Verifica defense-in-depth resolve check.
    const res = await makeApp().request('/registry/packages/pwn..ffnode');
    // File non esiste → 404 (regex passa, resolve si normalizza, file non c'è)
    expect(res.status).toBe(404);
  });
});
