/**
 * /templates/:id/instantiate — provisioning tabelle dichiarate (2026-07-06).
 *
 * Prima i template NON creavano le tabelle ("tabelle comprese" era falso su
 * questo path — le creava solo il wizard via POST /workflows). Contratti:
 *   • tablesToCreate del template → create via provisioning condiviso + seed
 *   • nodi CLONATI e rimappati al databaseId reale
 *   • 🚨 il template in memoria (condiviso dal processo) NON viene mutato:
 *     senza clone, il remap del tenant A avvelenerebbe l'instantiate del tenant B
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKFLOW_TEMPLATES } from '@flowforge/templates';
import { createTemplateRoutes } from './templates.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';

const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;

// DbStudioService fake: un DB embedded reale + registrazione di migrazioni/insert.
const dbCalls = vi.hoisted(() => ({
  migrations: [] as { dbId: string }[],
  inserts: [] as { dbId: string; table: string }[],
}));
vi.mock('@/services/db-studio.service.js', () => ({
  DbStudioService: class {
    list() { return [{ id: 'db-real-1', connection: { embedded: true } }]; }
    create() { throw new Error('non deve creare DB: ne esiste uno'); }
    applyMigration(dbId: string) { dbCalls.migrations.push({ dbId }); }
    insert(dbId: string, table: string) { dbCalls.inserts.push({ dbId, table }); }
  },
}));

let createSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dbCalls.migrations.length = 0;
  dbCalls.inserts.length = 0;
  createSpy = vi.fn(async (input: Record<string, unknown>) => ({ id: 'wf-new', ...input }));
  vi.spyOn(WorkflowService.prototype, 'create').mockImplementation(createSpy as never);
});

const PIZZA_ID = 'tmpl_pizzeria_whatsapp_bot';

async function instantiate(id: string) {
  const { Hono } = await import('hono');
  const app = new Hono();
  // Contesto auth come lo monta authMiddleware in server.ts (tenant-scoped).
  app.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'u1', tenantId: 'tenant-test', email: 'o@x.it', role: 'owner' } as never);
    await next();
  });
  app.route('/', createTemplateRoutes(eventBus));
  return app.request(`/${id}/instantiate`, { method: 'POST' });
}

describe('POST /templates/:id/instantiate — tabelle dichiarate', () => {
  it('crea le 5 tabelle del template pizzeria + seed (16 menu + 1 info) e risponde tablesCreated', async () => {
    const res = await instantiate(PIZZA_ID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tablesCreated?: { name: string; ok: boolean }[] };
    expect(body.tablesCreated).toHaveLength(5);
    expect(body.tablesCreated!.every((t) => t.ok)).toBe(true);
    expect(dbCalls.migrations).toHaveLength(5);
    expect(dbCalls.migrations.every((m) => m.dbId === 'db-real-1')).toBe(true);
    // Seed: 16 pizze + 1 riga info = 17 insert, tutte sul DB reale
    expect(dbCalls.inserts).toHaveLength(17);
    expect(dbCalls.inserts.filter((i) => i.table === 'pizzeria_menu')).toHaveLength(16);
    expect(dbCalls.inserts.filter((i) => i.table === 'pizzeria_info')).toHaveLength(1);
  });

  it('🚨 i nodi del workflow creato puntano al databaseId REALE, non al placeholder', async () => {
    await instantiate(PIZZA_ID);
    const input = createSpy.mock.calls[0]![0] as { nodes: { config: Record<string, unknown> }[] };
    const dbIds = input.nodes
      .map((n) => n.config.databaseId)
      .filter((v): v is string => typeof v === 'string');
    expect(dbIds.length).toBeGreaterThan(0);
    expect(new Set(dbIds)).toEqual(new Set(['db-real-1']));
  });

  it('🚨 ANTI-POISONING cross-tenant: il template condiviso in memoria NON viene mutato', async () => {
    const tmpl = WORKFLOW_TEMPLATES.find((t) => t.id === PIZZA_ID)!;
    const before = JSON.stringify(tmpl.nodes);
    await instantiate(PIZZA_ID);
    expect(JSON.stringify(tmpl.nodes)).toBe(before);
    // E i nodi del template ORIGINALE hanno ancora il placeholder:
    const stillPlaceholder = tmpl.nodes.some(
      (n) => (n.config as Record<string, unknown>).databaseId === 'pizzeria_db',
    );
    expect(stillPlaceholder).toBe(true);
  });

  it('template SENZA tablesToCreate → nessuna migrazione, risposta senza tablesCreated (back-compat)', async () => {
    const plain = WORKFLOW_TEMPLATES.find((t) => !t.tablesToCreate)!;
    const res = await instantiate(plain.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tablesCreated).toBeUndefined();
    expect(dbCalls.migrations).toHaveLength(0);
  });

  it('template inesistente → 404, zero side-effect', async () => {
    const res = await instantiate('tmpl_non_esiste');
    expect(res.status).toBe(404);
    expect(createSpy).not.toHaveBeenCalled();
    expect(dbCalls.migrations).toHaveLength(0);
  });

  it('workflow creato DISABILITATO + tag from-template', async () => {
    await instantiate(PIZZA_ID);
    const input = createSpy.mock.calls[0]![0] as { enabled: boolean; tags: string[] };
    expect(input.enabled).toBe(false);
    expect(input.tags).toContain(`from-template:${PIZZA_ID}`);
  });
});
