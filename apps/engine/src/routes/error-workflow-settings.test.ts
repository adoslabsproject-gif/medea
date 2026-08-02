/**
 * Test 2026-grade — GAP 5 (d): settings catch-all error-workflow.
 *
 * Stack REALE (WorkflowService + flag service + SQLite del worker): le
 * validazioni sono il punto — un catch-all fantasma o senza trigger_error
 * fallirebbe IN SILENZIO a ogni run errore del tenant. RBAC: PUT admin-only.
 */
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createErrorWorkflowSettingsRoutes } from './error-workflow-settings.js';
import { WorkflowService } from '@/services/workflow.service.js';
import {
  getTenantErrorWorkflowId,
  setTenantErrorWorkflowId,
  resetErrorWorkflowFlagForTests,
} from '@/services/error-workflow-flag.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';

const bus = new InMemoryEventBus();
const workflows = new WorkflowService(bus);
let handlerId = '';
let noTriggerId = '';

function makeApp(role: 'owner' | 'viewer'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { tenantId: 'default', userId: 'u-settings', role } as never);
    await next();
  });
  app.route('/api/v1', createErrorWorkflowSettingsRoutes(bus));
  return app;
}

async function put(role: 'owner' | 'viewer', body: unknown): Promise<Response> {
  return makeApp(role).request('/api/v1/settings/error-workflow', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  runMigrations();
  const handler = await workflows.create({
    name: 'settings-handler',
    enabled: true,
    tenantId: 'default',
    nodes: [{ id: 't', defId: 'trigger_error', x: 0, y: 0, config: {} }],
    edges: [],
  });
  handlerId = handler.id;
  const noTrigger = await workflows.create({
    name: 'settings-no-trigger',
    enabled: true,
    tenantId: 'default',
    nodes: [{ id: 'a', defId: 'trigger_manual', x: 0, y: 0, config: {} }],
    edges: [],
  });
  noTriggerId = noTrigger.id;
}, 30_000);

afterEach(() => {
  setTenantErrorWorkflowId(null);
  resetErrorWorkflowFlagForTests();
});

describe('🚨 PUT — validazioni che evitano il catch-all rotto-in-silenzio', () => {
  it('🚨 workflow valido con trigger_error → 200, flag settato, audit row scritta', async () => {
    const res = await put('owner', { errorWorkflowId: handlerId });
    expect(res.status).toBe(200);
    resetErrorWorkflowFlagForTests();
    expect(getTenantErrorWorkflowId()).toBe(handlerId);
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = 'settings.error_workflow.updated' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ next: handlerId });
  });

  it('🚨 workflow FANTASMA → 400, flag INTOCCATO', async () => {
    const res = await put('owner', { errorWorkflowId: 'wf-ghost' });
    expect(res.status).toBe(400);
    expect(getTenantErrorWorkflowId()).toBeNull();
  });

  it('🚨 workflow SENZA trigger_error → 400 con messaggio chiaro (quasi certamente una svista)', async () => {
    const res = await put('owner', { errorWorkflowId: noTriggerId });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/trigger_error/u);
    expect(getTenantErrorWorkflowId()).toBeNull();
  });

  it('🚨 null rimuove il catch-all', async () => {
    setTenantErrorWorkflowId(handlerId);
    const res = await put('owner', { errorWorkflowId: null });
    expect(res.status).toBe(200);
    expect(getTenantErrorWorkflowId()).toBeNull();
  });

  it('🚨 RBAC: PUT da non-admin → 403, flag intoccato', async () => {
    const res = await put('viewer', { errorWorkflowId: handlerId });
    expect(res.status).toBe(403);
    expect(getTenantErrorWorkflowId()).toBeNull();
  });

  it('body non-stringa/non-null → 400', async () => {
    const res = await put('owner', { errorWorkflowId: 42 });
    expect(res.status).toBe(400);
  });
});

describe('🚨 GET', () => {
  it('🚨 riflette lo stato del flag (null e valorizzato)', async () => {
    const app = makeApp('viewer');
    let res = await app.request('/api/v1/settings/error-workflow');
    expect(await res.json()).toEqual({ errorWorkflowId: null });
    setTenantErrorWorkflowId(handlerId);
    res = await app.request('/api/v1/settings/error-workflow');
    expect(await res.json()).toEqual({ errorWorkflowId: handlerId });
  });

  // #8: il GET era senza requireRole (pass-through), asimmetrico col PUT owner.
  it('🔴 GET senza auth → 401', async () => {
    const app = new Hono();
    app.route('/api/v1', createErrorWorkflowSettingsRoutes(bus));
    const res = await app.request('/api/v1/settings/error-workflow');
    expect(res.status).toBe(401);
  });

  it('🔴 GET ruolo ignoto → 403 (fail-closed, non pass-through)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, { tenantId: 'default', userId: 'x', role: 'alien' } as never);
      await next();
    });
    app.route('/api/v1', createErrorWorkflowSettingsRoutes(bus));
    const res = await app.request('/api/v1/settings/error-workflow');
    expect(res.status).toBe(403);
  });
});

describe('🚨 wiring — la route è MONTATA nel server reale', () => {
  it('🚨 server.ts importa e monta createErrorWorkflowSettingsRoutes', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
      'utf8',
    );
    expect(src).toContain("from './routes/error-workflow-settings.js'");
    expect(src).toContain('createErrorWorkflowSettingsRoutes(deps.eventBus)');
  });
});
