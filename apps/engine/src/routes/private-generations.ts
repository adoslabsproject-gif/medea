/**
 * Route INTERNA S2S per lo storage privato delle generazioni (chiamata da
 * gen-studio dopo aver generato via ComfyUI).
 *
 * Auth: header `x-internal-token` (timing-safe, `requireInternalToken`) — gate
 * PER-ROUTE (non app.use: in Hono il middleware su sub-app montato leakerebbe).
 * Il prefisso `/api/v1/internal/` è in PUBLIC_PREFIXES (bypassa authMiddleware),
 * quindi il gate interno è l'UNICA barriera → fail-closed.
 *
 * Tutto è tenant-scoped sul tenant del container (config.FLOWFORGE_TENANT_ID,
 * dentro il service) — nessun parametro tenant accettato dall'esterno.
 *
 * @module routes/private-generations
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireInternalToken } from '../lib/internal-token.js';
import { getBinaryStore } from '../services/binary-store.service.js';
import { createPrivateGenerationsService } from '../services/private-generations/index.js';
import { loggerFor } from '../lib/logger.js';

const log = loggerFor('routes.private-generations');

const SaveSchema = z.object({
  kind: z.enum(['image', 'video']),
  prompt: z.string().min(1).max(8000),
  negative: z.string().max(4000).optional(),
  params: z.record(z.unknown()).optional(),
  seed: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  checkpoint: z.string().max(300).optional(),
  mime: z.string().min(1).max(120),
  /** Byte del media in base64 (da gen-studio dopo ComfyUI). */
  dataBase64: z.string().min(1),
});

const RateSchema = z.object({
  id: z.string().min(1).max(64),
  rating: z.enum(['up', 'down']).nullable(),
});

export function createPrivateGenerationsRoutes(): Hono {
  const app = new Hono();
  const gate = requireInternalToken();

  // POST /api/v1/internal/private-gen/save
  app.post('/internal/private-gen/save', gate, zValidator('json', SaveSchema), async (c) => {
    const body = c.req.valid('json');
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length === 0) return c.json({ ok: false, error: 'media base64 non valido o vuoto' }, 400);
    try {
      const service = createPrivateGenerationsService();
      const res = await service.save({
        kind: body.kind,
        prompt: body.prompt,
        negative: body.negative,
        params: body.params,
        seed: body.seed,
        width: body.width,
        height: body.height,
        checkpoint: body.checkpoint,
        mime: body.mime,
        bytes,
      });
      return c.json({ ok: true, ...res }, 201);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'save generazione fallito');
      return c.json({ ok: false, error: 'salvataggio fallito' }, 500);
    }
  });

  // POST /api/v1/internal/private-gen/rate
  app.post('/internal/private-gen/rate', gate, zValidator('json', RateSchema), async (c) => {
    const { id, rating } = c.req.valid('json');
    try {
      await createPrivateGenerationsService().rate(id, rating);
      return c.json({ ok: true }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'rate generazione fallito');
      return c.json({ ok: false, error: 'voto fallito' }, 500);
    }
  });

  // GET /api/v1/internal/private-gen/list?limit=50
  app.get('/internal/private-gen/list', gate, async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    try {
      const items = await createPrivateGenerationsService().list(Number.isFinite(limit) ? limit : 50);
      return c.json({ ok: true, items }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'list generazioni fallito');
      return c.json({ ok: false, error: 'lista fallita' }, 500);
    }
  });

  // GET /api/v1/internal/private-gen/media/:ref?mime=image/png — serve il blob.
  app.get('/internal/private-gen/media/:ref', gate, async (c) => {
    const ref = c.req.param('ref');
    const mime = c.req.query('mime') ?? 'application/octet-stream';
    try {
      const bytes = await getBinaryStore().read(ref); // valida ref (sha256) → anti-traversal
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': mime,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=86400',
        },
      });
    } catch {
      return c.json({ ok: false, error: 'media non trovato' }, 404);
    }
  });

  return app;
}
