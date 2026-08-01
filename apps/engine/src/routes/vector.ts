import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { VectorService } from '@/services/vector.service.js';
import { ingestText, vectorPlanLimitsFromConfig } from '@/services/vector-ingest.js';
import { embedText } from '@/services/embeddings.service.js';
import { isWorkspaceReadOnly } from '@/services/readonly-flag.service.js';
import { getTenantId } from '@/lib/tenant.js';

/**
 * Risposta 423 quando il workspace è read-only (disk over-quota grace). Gate sui
 * write-path che FANNO CRESCERE i vettori (upsert, ingest-text) — coerente col gate
 * di RunService.execute. delete/drop/search NON sono gated: l'utente deve poter
 * RIDURRE i dati per rientrare sotto quota.
 */
function readOnlyBlocked(c: Context): Response {
  return c.json(
    {
      error: 'Workspace in sola lettura (spazio disco oltre il limite): scrittura vettori bloccata. Riduci i dati o riattiva un piano.',
      code: 'WORKSPACE_READ_ONLY',
    },
    423,
  );
}

const EnsureCollectionSchema = z.object({
  collection: z.string().min(1).max(200),
  dimensions: z.number().int().positive().max(8192),
  distance: z.enum(['cosine', 'euclidean', 'dot']).default('cosine'),
});

// `vector` (embeddato dal client, legacy) OPPURE `text`+provider/model
// (embedding SERVER-SIDE, raccomandato: la API key non gira nel browser).
const SearchSchema = z.object({
  collection: z.string().min(1),
  vector: z.array(z.number()).optional(),
  text: z.string().min(1).max(10_000).optional(),
  provider: z.enum(['openai', 'voyage', 'ollama']).optional(),
  model: z.string().min(1).max(100).optional(),
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(500).optional(),
  topK: z.number().int().positive().max(1000).default(10),
  filter: z.record(z.string(), z.unknown()).optional(),
  minScore: z.number().optional(),
}).refine(
  (d) => Boolean(d.vector && d.vector.length > 0) || Boolean(d.text && d.provider && d.model),
  { message: 'Serve `vector` oppure `text`+`provider`+`model` (embedding server-side).' },
);

const DeleteSchema = z.object({
  collection: z.string().min(1),
  ids: z.array(z.string()).min(1),
});

const IngestTextSchema = z.object({
  collection: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000), // cap per-chunk: un singolo ingest non può essere un dump arbitrario
  provider: z.enum(['openai', 'voyage', 'ollama']),
  model: z.string().min(1).max(100),
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(500).optional(),
  distance: z.enum(['cosine', 'euclidean', 'dot']).optional(),
  id: z.string().min(1).max(200).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export function createVectorRoutes(): Hono {
  const app = new Hono();
  const service = new VectorService();

  app.get('/:dbId/collections', async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    if (!dbId) return c.json({ error: 'Bad request' }, 400);
    try {
      const collections = await service.listCollections(dbId, tenantId);
      return c.json({ collections });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/:dbId/collections', zValidator('json', EnsureCollectionSchema), async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    if (!dbId) return c.json({ error: 'Bad request' }, 400);
    const { collection, dimensions, distance } = c.req.valid('json');
    try {
      await service.ensureCollection(dbId, collection, dimensions, distance, tenantId);
      return c.json({ ok: true, collection, dimensions, distance }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // NB: NON esiste un endpoint raw `/upsert` HTTP. Scrivere vettori grezzi bypassando
  // scan anti-injection e quota è VIETATO e l'enforcement è strutturale (assenza di
  // surface), non un commento: l'UNICO write-path HTTP per i tenant è /ingest-text
  // (core ingestText: scan→quota→embed→upsert). VectorService.upsert resta interno,
  // chiamato SOLO da ingestText e dall'auto-embed (entrambi con scan+quota a monte).

  app.post('/:dbId/search', zValidator('json', SearchSchema), async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    if (!dbId) return c.json({ error: 'Bad request' }, 400);
    const body = c.req.valid('json');
    try {
      // Embedding SERVER-SIDE quando arriva `text` (la chiave non passa dal
      // browser); altrimenti il `vector` legacy già calcolato dal client.
      let vector = body.vector;
      if ((!vector || vector.length === 0) && body.text && body.provider && body.model) {
        vector = await embedText({
          provider: body.provider,
          model: body.model,
          text: body.text,
          ...(body.apiKey ? { apiKey: body.apiKey } : {}),
          ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        });
      }
      if (!vector || vector.length === 0) return c.json({ error: 'Query vuota: nessun vettore' }, 400);
      const query: Parameters<VectorService['search']>[2] = {
        vector,
        topK: body.topK,
      };
      if (body.filter !== undefined) query.filter = body.filter;
      if (body.minScore !== undefined) query.minScore = body.minScore;
      const result = await service.search(dbId, body.collection, query, tenantId);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/:dbId/delete', zValidator('json', DeleteSchema), async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    if (!dbId) return c.json({ error: 'Bad request' }, 400);
    const { collection, ids } = c.req.valid('json');
    try {
      const result = await service.deleteIds(dbId, collection, ids, tenantId);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // INGEST testo DIRETTO da UI — UNICO write-path HTTP per i vettori. Passa per il
  // core condiviso ingestText (scan anti-injection + quota + embed + upsert
  // server-side). Non esiste un endpoint raw di upsert: il guard NON è aggirabile.
  app.post('/:dbId/ingest-text', zValidator('json', IngestTextSchema), async (c) => {
    if (isWorkspaceReadOnly()) return readOnlyBlocked(c); // crescita vettori bloccata in grace
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    if (!dbId) return c.json({ error: 'Bad request' }, 400);
    const b = c.req.valid('json');
    try {
      const result = await ingestText({
        databaseId: dbId,
        collection: b.collection,
        content: b.content,
        tenantId,
        provider: b.provider,
        model: b.model,
        ...(b.apiKey ? { apiKey: b.apiKey } : {}),
        ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
        ...(b.distance ? { distance: b.distance } : {}),
        ...(b.id ? { id: b.id } : {}),
        ...(b.payload ? { payload: b.payload } : {}),
        planLimits: vectorPlanLimitsFromConfig(),
      });
      return c.json({ ok: true, ...result }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // DROP di una collezione — RIDUCE i dati → consentito anche in read-only (l'utente
  // deve poter pulire per rientrare sotto quota). NESSUN gate read-only.
  app.delete('/:dbId/collections/:name', async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    const name = c.req.param('name');
    if (!dbId || !name) return c.json({ error: 'Bad request' }, 400);
    try {
      await service.dropCollection(dbId, name, tenantId);
      return c.json({ ok: true, dropped: name });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get('/:dbId/collections/:name/count', async (c) => {
    const tenantId = getTenantId(c);
    const dbId = c.req.param('dbId');
    const name = c.req.param('name');
    if (!dbId || !name) return c.json({ error: 'Bad request' }, 400);
    try {
      const result = await service.count(dbId, name, tenantId);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
