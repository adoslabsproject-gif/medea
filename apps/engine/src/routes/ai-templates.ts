/**
 * AI Templates routes — list / share / unshare / delete workflow templates
 * dello scaffold AI.
 *
 *   GET    /api/v1/ai-templates                  — list locale tenant
 *   GET    /api/v1/ai-templates/community        — list community gallery (portal proxy)
 *   POST   /api/v1/ai-templates/:id/share        — promote to community
 *   POST   /api/v1/ai-templates/:id/unshare      — unshare from community
 *   DELETE /api/v1/ai-templates/:id              — delete locale (GDPR)
 *
 * Auth: cookie session FF (auth middleware comune). Tenant inferred dal
 * container env (MEDEA_TENANT_ID).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { templateCache } from '@/services/ai-scaffold/template-cache/template.service.js';
import {
  promoteToCommunity,
  retrieveFromCommunity,
  unshareFromCommunity,
} from '@/services/ai-scaffold/template-cache/portal-client.js';
import { generateEmbedding } from '@/services/ai-scaffold/template-cache/embedding-client.js';
import { logger } from '@/lib/logger.js';
import { requireRole } from '@/middleware/rbac.js';
import { rateLimit } from '@/middleware/rate-limit.js';

const TENANT_ID = process.env.MEDEA_TENANT_ID ?? '';

export function createAiTemplatesRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const templates = templateCache.list({ limit: Math.min(Math.max(limit, 1), 200) });
    return Promise.resolve(c.json({
      ok: true,
      count: templates.length,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        promptText: t.promptText,
        graphSignature: t.graphSignature,
        graphDefIds: t.graphDefIds,
        language: t.language,
        importedCount: t.importedCount,
        successCount: t.successCount,
        failCount: t.failCount,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        sharedWithCommunity: t.sharedWithCommunity,
      })),
    }));
  });

  app.get('/community', async (c) => {
    const language = c.req.query('language') as 'it' | 'en' | undefined;
    const limit = Number(c.req.query('limit') ?? '20');
    const remote = await retrieveFromCommunity({
      ...(language ? { language } : {}),
      limit: Math.min(Math.max(limit, 1), 100),
    });
    if (!remote) {
      return Promise.resolve(c.json({ ok: false, error: 'Community gallery non raggiungibile', templates: [], count: 0 }));
    }
    return Promise.resolve(c.json({ ok: true, templates: remote.templates, count: remote.count }));
  });

  const ShareBody = z.object({
    description: z.string().max(2000).optional(),
    language: z.enum(['it', 'en', 'es', 'fr', 'de', 'pt']).optional(),
  });

  // Promozione/rimozione community → owner: pubblica workflow del tenant verso
  // l'esterno (effetti + GDPR), non per ruoli operativi.
  app.post('/:id/share', requireRole('owner'), async (c) => {
    const id = c.req.param('id');
    const local = templateCache.getById(id);
    if (!local) return c.json({ ok: false, error: 'template not found' }, 404);
    const body = ShareBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ ok: false, error: 'invalid body', issues: body.error.issues }, 400);
    if (!TENANT_ID) return c.json({ ok: false, error: 'tenant id missing in container env' }, 500);
    const result = await promoteToCommunity({
      name: local.name,
      ...(body.data.description ? { description: body.data.description } : {}),
      language: body.data.language ?? (local.language as 'it' | 'en'),
      graphSignature: local.graphSignature,
      graphDefIds: local.graphDefIds,
      workflowJson: JSON.parse(local.workflowJson) as Record<string, unknown>,
      promptText: local.promptText,
      promptTokens: local.promptTokens,
      sourceWorkspaceId: TENANT_ID,
    });
    if (!result) return c.json({ ok: false, error: 'community gallery non raggiungibile' }, 502);
    logger.info({ localId: id, sharedId: result.id, isNew: result.isNew }, '[ai-templates] shared to community');
    return c.json({ ok: true, sharedTemplateId: result.id, isNew: result.isNew });
  });

  const UnshareBody = z.object({
    sharedTemplateId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  });

  app.post('/:id/unshare', requireRole('owner'), async (c) => {
    const body = UnshareBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ ok: false, error: 'invalid body' }, 400);
    if (!TENANT_ID) return c.json({ ok: false, error: 'tenant id missing in container env' }, 500);
    const ok = await unshareFromCommunity({
      templateId: body.data.sharedTemplateId,
      sourceWorkspaceId: TENANT_ID,
      ...(body.data.reason ? { reason: body.data.reason } : {}),
    });
    return c.json({ ok });
  });

  app.delete('/:id', requireRole('editor'), (c) => {
    const id = c.req.param('id');
    const ok = templateCache.delete(id);
    if (!ok) return Promise.resolve(c.json({ ok: false, error: 'template not found' }, 404));
    return Promise.resolve(c.json({ ok: true }));
  });

  // N3: /metrics fa una COUNT sul cache + è ri-fetchato dalla UI ogni 30s →
  // rate-limit per-tenant generoso (copre più client del tenant) anti-DoS.
  app.get('/metrics', rateLimit({ windowMs: 60_000, perTenant: 60, label: 'ai-templates-metrics' }), (c) => {
    const m = templateCache.getMetrics();
    return Promise.resolve(c.json({
      ok: true,
      ...m,
      cacheHitRatePct: Math.round(m.cacheHitRate * 1000) / 10,
      gpuMinutesSaved: Math.round(m.gpuSecondsSaved / 60),
    }));
  });

  /**
   * GET /search?query=…&limit=3&includeCommunity=true
   *
   * Endpoint usato da Liara chat tool `search_workflow_templates` per
   * suggerire template esistenti prima di generare ex novo.
   *
   * Pipeline:
   *  1. Embed query con BGE-M3 (graceful: null se server down)
   *  2. templateCache.retrieve() locale per-tenant
   *  3. Se includeCommunity=true → portal /api/v1/internal/templates/retrieve
   *  4. Merge + sort by score → top N
   */
  app.get('/search', async (c) => {
    const query = c.req.query('query');
    if (!query || query.trim().length < 3) {
      return Promise.resolve(c.json({ ok: false, error: 'query required (min 3 chars)', templates: [] }, 400));
    }
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '3'), 1), 10);
    const includeCommunity = c.req.query('includeCommunity') === 'true';
    const language = c.req.query('language') ?? 'it';

    // 1. Embedding (graceful — cosine signal cade a 0 se server down)
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await generateEmbedding(query);
    } catch {
      /* graceful */
    }

    // 2. Local cache retrieve
    const local = templateCache.retrieve({ promptText: query, queryEmbedding });

    interface Result {
      source: 'local' | 'community';
      score: number;
      action: 'use_direct' | 'inject_fewshot' | 'fallback';
      template: {
        id: string;
        name: string;
        promptText: string;
        graphSignature: string;
        graphDefIds: string[];
        language: string;
        workflowJson: unknown;
        importedCount?: number;
        successCount?: number;
      };
      signals?: { graphOverlap: number; promptJaccard: number; successRate: number; cosine: number };
    }

    const results: Result[] = [];
    if (local) {
      results.push({
        source: 'local',
        score: local.score,
        action: local.action,
        signals: local.signals,
        template: {
          id: local.template.id,
          name: local.template.name,
          promptText: local.template.promptText,
          graphSignature: local.template.graphSignature,
          graphDefIds: local.template.graphDefIds,
          language: local.template.language,
          workflowJson: (() => { try { return JSON.parse(local.template.workflowJson) as unknown; } catch { return null; } })(),
          importedCount: local.template.importedCount,
          successCount: local.template.successCount,
        },
      });
    }

    // 3. Community gallery (opzionale)
    if (includeCommunity) {
      try {
        const remote = await retrieveFromCommunity({
          language: language as 'it' | 'en' | 'es' | 'fr' | 'de' | 'pt',
          limit: 5,
        });
        if (remote && remote.templates.length > 0) {
          for (const ct of remote.templates) {
            // Score community basato su jaccard tokens + importedCount boost
            const queryTokens = query.toLowerCase().split(/[^a-z0-9à-ÿ]+/).filter((t) => t.length >= 3);
            const intersection = queryTokens.filter((t) => ct.promptTokens.includes(t)).length;
            const union = new Set([...queryTokens, ...ct.promptTokens]).size;
            const jaccard = union > 0 ? intersection / union : 0;
            const popularityBoost = Math.min(ct.importedCount / 100, 0.2);
            const score = 0.7 * jaccard + popularityBoost;
            results.push({
              source: 'community',
              score,
              action: score >= 0.9 ? 'use_direct' : score >= 0.7 ? 'inject_fewshot' : 'fallback',
              template: {
                id: ct.id,
                name: ct.name,
                promptText: ct.promptText,
                graphSignature: ct.graphSignature,
                graphDefIds: ct.graphDefIds,
                language: ct.language,
                workflowJson: ct.workflowJson,
                importedCount: ct.importedCount,
                successCount: ct.successCount,
              },
            });
          }
        }
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[ai-templates/search] community retrieve failed');
      }
    }

    // 4. Sort by score desc + limit
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);

    return Promise.resolve(c.json({
      ok: true,
      query,
      embedded: queryEmbedding !== null,
      count: top.length,
      results: top,
    }));
  });

  return app;
}
