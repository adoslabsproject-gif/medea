/**
 * Public registry server endpoints.
 *
 * The flowforge.nothumanallowed.com instance ALSO acts as the community
 * registry — vendors publish .ffnode packages here and this routes serves
 * them with the manifest index. Self-hosters can either point at this URL
 * (default) or stand up their own registry by setting
 * FLOWFORGE_REGISTRY_URL.
 *
 * Endpoints (no auth — registry is public read):
 *   GET /registry/nodes.json           — the registry index (RegistryIndex)
 *   GET /registry/packages/:filename   — download a .ffnode file
 *
 * Storage:
 *   $FLOWFORGE_DATA_DIR/registry/nodes.json
 *   $FLOWFORGE_DATA_DIR/registry/packages/*.ffnode
 *
 * Why "static file + serve" instead of a database-backed catalog: the
 * registry is read-mostly (~ 1000 reads per write). A static JSON +
 * append-only directory is dead simple, free to host on a CDN, and there's
 * no schema migration risk.
 */

import { Hono } from 'hono';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger.js';

function registryDir(): string {
  return process.env.FLOWFORGE_REGISTRY_DIR?.trim()
    || join(process.env.FLOWFORGE_DATA_DIR?.trim() || process.cwd(), 'registry');
}

export function createRegistryServerRoutes(): Hono {
  const app = new Hono();

  // CORS for public registry — anyone (self-hosted FlowForge, other tools)
  // can read the index.
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  app.get('/nodes.json', async (c) => {
    const file = join(registryDir(), 'nodes.json');
    if (!existsSync(file)) {
      // Empty registry — return a valid empty index so clients don't crash.
      return c.json({ version: 1, updatedAt: new Date().toISOString(), nodes: [] });
    }
    try {
      const raw = await readFile(file, 'utf8');
      const etag = `"${createHash('sha256').update(raw).digest('hex').slice(0, 16)}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch === etag) return c.body(null, 304);
      c.header('ETag', etag);
      c.header('Cache-Control', 'public, max-age=300');
      c.header('Content-Type', 'application/json; charset=utf-8');
      return c.body(raw, 200);
    } catch (err) {
      logger.error({ err }, 'Failed to read registry index');
      return c.json({ error: 'Registry read failure' }, 500);
    }
  });

  app.get('/packages/:filename', async (c) => {
    const filename = c.req.param('filename');
    if (!filename || !/^[a-z0-9_.-]+\.ffnode$/iu.test(filename)) {
      return c.json({ error: 'Bad filename — must match [a-z0-9_.-]+.ffnode' }, 400);
    }
    const target = resolve(join(registryDir(), 'packages', filename));
    // Path-traversal defense.
    if (!target.startsWith(resolve(join(registryDir(), 'packages')))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!existsSync(target)) return c.json({ error: 'Package non trovato' }, 404);
    try {
      const buf = await readFile(target);
      const etag = `"${createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch === etag) return c.body(null, 304);
      c.header('ETag', etag);
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', `attachment; filename="${basename(target)}"`);
      return c.body(buf as unknown as ArrayBuffer, 200);
    } catch (err) {
      logger.error({ err, target }, 'Failed to serve registry package');
      return c.json({ error: 'Package read failure' }, 500);
    }
  });

  // Lightweight catalog endpoint for admins: lists files in /packages/
  // without parsing them (useful for debugging "is my .ffnode actually there?")
  app.get('/_files', async (c) => {
    const dir = join(registryDir(), 'packages');
    if (!existsSync(dir)) return c.json({ files: [] });
    try {
      const items = await readdir(dir);
      const out = await Promise.all(items
        .filter((f) => f.endsWith('.ffnode'))
        .map(async (f) => {
          const st = await stat(join(dir, f));
          return { name: f, size: st.size, mtime: st.mtime.toISOString() };
        }));
      return c.json({ files: out });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
