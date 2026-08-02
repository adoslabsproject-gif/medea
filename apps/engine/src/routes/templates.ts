import { Hono } from 'hono';
import { WORKFLOW_TEMPLATES, findTemplate } from '@medea/engine-templates';
import { WorkflowService } from '@/services/workflow.service.js';
import { provisionDeclaredTables, remapNodeDatabaseIds } from '@/services/ai-scaffold/scaffold-table-provision.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { logger } from '@/lib/logger.js';

export function createTemplateRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  app.get('/', (c) => {
    const category = c.req.query('category');
    const language = c.req.query('language');
    let list = WORKFLOW_TEMPLATES.slice();
    if (category) list = list.filter((t) => t.category === category);
    if (language) list = list.filter((t) => t.language === language);
    return c.json({ templates: list, total: list.length });
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const template = findTemplate(id);
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json({ template });
  });

  app.post('/:id/instantiate', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const template = findTemplate(id);
    if (!template) return c.json({ error: 'Template not found' }, 404);

    // Tabelle dichiarate dal template → create PRIMA del workflow (stessa
    // pipeline del wizard: best-effort, idempotenti, DB SQLite on-demand,
    // seedRows solo su tabelle appena create). I nodi del template usano un
    // databaseId PLACEHOLDER → remap all'id reale, altrimenti db_query/insert
    // fallirebbero con "database non trovato". Nodi CLONATI (deep-copy): il
    // template in memoria è condiviso dal processo — mutarlo in-place
    // avvelenerebbe le instantiate successive di ALTRI tenant col dbId nostro.
    const nodes = structuredClone(template.nodes);
    let tablesCreated: { name: string; ok: boolean; error?: string }[] = [];
    if (template.tablesToCreate && template.tablesToCreate.length > 0) {
      const { DbStudioService } = await import('@/services/db-studio.service.js');
      const provision = await provisionDeclaredTables(
        new DbStudioService(), tenantId, template.tablesToCreate, logger,
      );
      tablesCreated = provision.tablesCreated;
      remapNodeDatabaseIds(nodes, provision.dbRemap);
    }

    const input: Parameters<WorkflowService['create']>[0] = {
      name: template.name,
      description: template.description,
      enabled: false,
      nodes,
      edges: template.edges,
      nodeDefs: [],
      tags: [...template.tags, `from-template:${template.id}`],
      tenantId,
    };
    if (actorId !== undefined) input.createdBy = actorId;
    const created = await workflows.create(input);
    return c.json({
      workflow: created,
      templateId: template.id,
      ...(tablesCreated.length > 0 ? { tablesCreated } : {}),
    }, 201);
  });

  return app;
}
