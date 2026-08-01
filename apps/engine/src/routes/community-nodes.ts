/**
 * Community Nodes routes — backs the marketplace UI's install/uninstall/list
 * operations.
 *
 * Endpoints (all under /api/v1/community-nodes, owner-only):
 *   GET    /installed          — list installed packages
 *   POST   /install            — install from URL or upload
 *   DELETE /:vendor/:id        — uninstall (all versions)
 *   GET    /:vendor/:id        — detail (manifest + readme)
 *
 * Install body shape (one of):
 *   { "url": "https://registry.flowforge.io/nodes/foo.ffnode" }
 *   { "base64": "<bytes of the .ffnode zip>" }
 *
 * On successful install OR uninstall the in-memory node registry is updated
 * AND a `community-nodes:changed` event is emitted so the WebSocket layer
 * can push it to connected editors (palette refresh).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '@/middleware/rbac.js';
import {
  installFromBuffer,
  installFromUrl,
  uninstall,
  listInstalled,
  getInstalled,
} from '@/services/community-nodes.service.js';
import { emitCommunityNodesChanged } from '@/services/community-nodes-events.js';
import { fetchRegistry, findEntry, clearRegistryCache } from '@/services/community-registry.service.js';
import { logger } from '@/lib/logger.js';

const InstallSchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ base64: z.string().min(1) }),
  z.object({ registryId: z.string().min(1), vendor: z.string().min(1) }),
]);

export function createCommunityNodesRoutes(): Hono {
  const app = new Hono();

  // Owner-only: installing third-party code is privileged.
  app.use('*', requireRole('owner'));

  app.get('/installed', (c) => {
    const installed = listInstalled().map((n) => ({
      vendor: n.manifest.vendor,
      id: n.manifest.id,
      version: n.manifest.version,
      displayName: n.manifest.displayName,
      description: n.manifest.description,
      license: n.manifest.license,
      homepage: n.manifest.homepage,
      category: n.manifest.category,
      installedAt: n.installedAt,
      verified: n.verified,
      actionsCount: n.def.actions?.length ?? 0,
    }));
    return c.json({ nodes: installed, total: installed.length });
  });

  app.get('/:vendor/:id', (c) => {
    const vendor = c.req.param('vendor');
    const id = c.req.param('id');
    const entry = getInstalled(vendor, id);
    if (!entry) return c.json({ error: 'Nodo non installato' }, 404);
    return c.json({
      manifest: entry.manifest,
      def: entry.def,
      readme: entry.readmeMd ?? null,
      iconSvg: entry.iconSvg ?? null,
      verified: entry.verified,
      installedAt: entry.installedAt,
    });
  });

  app.post('/install', zValidator('json', InstallSchema), async (c) => {
    const body = c.req.valid('json');
    try {
      let installed;
      if ('url' in body) {
        installed = await installFromUrl(body.url);
      } else if ('base64' in body) {
        installed = await installFromBuffer(Buffer.from(body.base64, 'base64'));
      } else {
        // registryId path: resolve via the registry then install from the
        // downloadUrl. The marketplace UI's "Install" button uses THIS path
        // so users never deal with raw URLs.
        const entry = await findEntry(body.vendor, body.registryId);
        if (!entry) {
          return c.json({ error: `Nodo "${body.vendor}/${body.registryId}" non trovato nel registry` }, 404);
        }
        installed = await installFromUrl(entry.downloadUrl);
      }
      emitCommunityNodesChanged();
      return c.json({
        ok: true,
        vendor: installed.manifest.vendor,
        id: installed.manifest.id,
        version: installed.manifest.version,
        verified: installed.verified,
      }, 201);
    } catch (err) {
      logger.warn({ err }, 'Community node install failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ───── Registry browse ─────
  app.get('/registry', async (c) => {
    try {
      const reg = await fetchRegistry();
      // Enrich each entry with `installed: true|false` so the UI can show
      // the right CTA without a second roundtrip.
      const installedKeys = new Set(listInstalled().map((n) => `${n.manifest.vendor}/${n.manifest.id}`));
      const nodes = reg.nodes.map((n) => ({
        ...n,
        installed: installedKeys.has(`${n.vendor}/${n.id}`),
      }));
      return c.json({ updatedAt: reg.updatedAt, nodes, total: nodes.length });
    } catch (err) {
      return c.json({
        error: 'Registry non raggiungibile. Riprova tra qualche minuto o configura FLOWFORGE_REGISTRY_URL.',
        details: err instanceof Error ? err.message : String(err),
      }, 502);
    }
  });

  app.post('/registry/refresh', async (c) => {
    clearRegistryCache();
    try {
      const reg = await fetchRegistry(true);
      return c.json({ ok: true, total: reg.nodes.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.delete('/:vendor/:id', async (c) => {
    const vendor = c.req.param('vendor');
    const id = c.req.param('id');
    try {
      await uninstall(vendor, id);
      emitCommunityNodesChanged();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  return app;
}
