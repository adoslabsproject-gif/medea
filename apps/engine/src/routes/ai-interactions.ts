/**
 * /api/v1/ai-interactions — CRUD + export of the AI training-set capture.
 *
 *   GET    /                       — list (pagination + filters)
 *   GET    /stats                  — aggregated counts for the Settings panel
 *   GET    /settings               — per-tenant capture preferences
 *   PUT    /settings               — update preferences (opt-in/out, retention)
 *   GET    /:id                    — single interaction full row
 *   POST   /:id/outcome            — user accepted/rejected/edited the proposal
 *   POST   /:id/review             — human reviewer assigns quality + split
 *   GET    /export.jsonl           — export training-ready JSONL
 *
 * Tenant scope: `getTenantId(c)` (env del container MEDEA_TENANT_ID / JWT,
 * NON header — gli header mentono). RBAC: la LETTURA del dataset (list/:id) e la
 * REVIEW sono `editor`+; il toggle del CONSENSO e l'EXPORT massivo sono `owner`
 * (operazioni di compliance/data-portability, non per ruoli operativi).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  AIInteractionsService,
  type InteractionType,
  type Outcome,
  type TrainingSplit,
} from '@/services/ai-interactions.service.js';
import { AISignalsService } from '@/services/ai-signals.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { requireRole } from '@/middleware/rbac.js';
import { rateLimit } from '@/middleware/rate-limit.js';

const OutcomeSchema = z.object({
  outcome: z.enum(['accepted', 'rejected', 'edited', 'ignored', 'failed']),
  patchApplied: z.unknown().optional(),
  followupRunId: z.string().optional(),
  followupRunStatus: z.string().optional(),
});

const ReviewSchema = z.object({
  qualityScore: z.number().int().min(0).max(5),
  reviewerNotes: z.string().max(2000).optional(),
  trainingSplit: z.enum(['train', 'val', 'test', 'excluded']).optional(),
});

const SettingsSchema = z.object({
  captureEnabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(365).optional(),
});

export function createAiInteractionsRoutes(): Hono {
  const app = new Hono();
  const service = new AIInteractionsService();
  const signals = new AISignalsService();

  app.get('/', requireRole('editor'), (c) => {
    const tenantId = getTenantId(c);
    const args: Parameters<typeof service.list>[0] = { tenantId };
    const type = c.req.query('type');
    const outcome = c.req.query('outcome');
    const split = c.req.query('split');
    const minQuality = c.req.query('minQuality');
    const limit = c.req.query('limit');
    const offset = c.req.query('offset');
    if (type) args.interactionType = type as InteractionType;
    if (outcome) args.outcome = outcome as Outcome;
    if (split) args.trainingSplit = split as TrainingSplit;
    if (minQuality) args.minQuality = Number(minQuality);
    if (limit) args.limit = Number(limit);
    if (offset) args.offset = Number(offset);
    const result = service.list(args);
    return c.json(result);
  });

  app.get('/stats', (c) => {
    const tenantId = getTenantId(c);
    return c.json(service.stats(tenantId));
  });

  // Track A — aggregati del segnale NON-personale (sempre attivo, no opt-in).
  app.get('/signals/stats', (c) => {
    const tenantId = getTenantId(c);
    return c.json(signals.stats(tenantId));
  });

  app.get('/settings', (c) => {
    const tenantId = getTenantId(c);
    return c.json(service.getCaptureSettings(tenantId));
  });

  app.put('/settings', requireRole('owner'), zValidator('json', SettingsSchema), (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    // L'utente che abilita È il consenso registrato (accountability art.7 GDPR).
    service.setCapturePreference(
      tenantId,
      body.captureEnabled,
      body.retentionDays ?? 90,
      getActorId(c),
    );
    return c.json({ ok: true, ...service.getCaptureSettings(tenantId) });
  });

  // Export massivo del dataset (data-portability) → owner. Query validate:
  // `minQuality` non-numerico generava `Number()=NaN` → filtro SQL silenziosamente
  // vuoto (undefined behavior). Coercizione+clamp espliciti.
  const ExportQuerySchema = z.object({
    split: z.enum(['train', 'val', 'test', 'excluded']).optional(),
    minQuality: z.coerce.number().int().min(0).max(5).optional(),
  });
  // N3: export massivo del dataset → costoso (serializza tutte le righe). Rate-limit
  // per evitare dump ripetuti (DoS + scraping). 5/min/user, 10/min/tenant.
  const exportRateLimit = rateLimit({
    windowMs: 60_000,
    perUser: 5,
    perTenant: 10,
    label: 'ai-interactions-export',
  });
  app.get(
    '/export.jsonl',
    requireRole('owner'),
    exportRateLimit,
    zValidator('query', ExportQuerySchema),
    (c) => {
      const tenantId = getTenantId(c);
      const q = c.req.valid('query');
      const args: Parameters<typeof service.exportJsonl>[0] = { tenantId };
      const split = q.split;
      if (split) args.trainingSplit = split;
      if (q.minQuality !== undefined) args.minQuality = q.minQuality;
      const jsonl = service.exportJsonl(args);
      return new Response(jsonl, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': `attachment; filename="ai-training-${tenantId}-${split ?? 'all'}.jsonl"`,
        },
      });
    },
  );

  app.get('/:id', requireRole('editor'), (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const row = service.get(id, tenantId);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ interaction: row });
  });

  app.post('/:id/outcome', zValidator('json', OutcomeSchema), (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const updateArgs: Parameters<typeof service.updateOutcome>[0] = {
      interactionId: id,
      tenantId,
      outcome: body.outcome,
    };
    if (body.patchApplied !== undefined) updateArgs.patchApplied = body.patchApplied;
    if (body.followupRunId !== undefined) updateArgs.followupRunId = body.followupRunId;
    if (body.followupRunStatus !== undefined) updateArgs.followupRunStatus = body.followupRunStatus;
    const updated = service.updateOutcome(updateArgs);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/review', requireRole('editor'), zValidator('json', ReviewSchema), (c) => {
    const tenantId = getTenantId(c);
    // N4 audit (2026-05-29): leggi reviewer da auth context (JWT/SSO),
    // non da header `x-user-id` (header injection bypass se nginx
    // upstream non sanitizza — defense-in-depth gap).
    const reviewerUserId = getActorId(c) ?? 'anonymous';
    const id = c.req.param('id');
    const body = c.req.valid('json');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const reviewArgs: Parameters<typeof service.updateReview>[0] = {
      interactionId: id,
      tenantId,
      reviewerUserId,
      qualityScore: body.qualityScore,
    };
    if (body.reviewerNotes !== undefined) reviewArgs.reviewerNotes = body.reviewerNotes;
    if (body.trainingSplit !== undefined) reviewArgs.trainingSplit = body.trainingSplit;
    const updated = service.updateReview(reviewArgs);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
