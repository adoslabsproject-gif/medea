/**
 * GET /workflows/:id/webhook-url — contract test dell'SSOT backend dell'URL
 * webhook (fix "no-token").
 *
 * Contract istituzionalizzati:
 *   • il token per authMode=none è ESATTAMENTE deriveDefaultWebhookToken
 *     (stesso valore che authorize() verificherà) — mai un placeholder
 *   • dopo rotazione del secret l'endpoint restituisce il token NUOVO
 *     (l'editor mostra sempre l'URL vivo, mai uno stantio)
 *   • fail-visible: senza secret → 503, MAI un URL fasullo copiabile
 *   • tenant gate: id di altro tenant → 404
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { registerWorkflowWebhookUrlRoutes } from './workflow-webhook-url.routes.js';
import { deriveDefaultWebhookToken } from '@/lib/webhook-token.js';
import { resetConfigForTests } from '@/config.js';
import type { WorkflowService } from '@/services/workflow.service.js';

const SECRET_A = 'route-secret-A-abcdefghijklmnopqrstuvwx';
const SECRET_B = 'route-secret-B-abcdefghijklmnopqrstuvwx';

interface StubNode { id: string; defId: string; config: Record<string, unknown> }

function makeWorkflow(id: string, tenantId: string, nodes: StubNode[]): Record<string, unknown> {
  return { id, tenantId, name: 'wf', enabled: true, nodes, edges: [] };
}

function webhookNode(config: Record<string, unknown> = {}): StubNode {
  return { id: 'n1', defId: 'trigger_webhook', config: { authMode: 'none', ...config } };
}

function makeApp(opts: {
  auth?: { tenantId: string; role?: string } | null;
  workflows?: Record<string, Record<string, unknown>>; // id → workflow (tenant check nel finto get)
} = {}): Hono {
  const auth = opts.auth === undefined ? { tenantId: 't1' } : opts.auth;
  const store = opts.workflows ?? {};
  const service = {
    get: vi.fn(async (id: string, tenantId = 'default') => {
      const wf = store[id];
      return wf && wf.tenantId === tenantId ? wf : null;
    }),
    getByIdAnyTenant: vi.fn(async (id: string) => store[id] ?? null),
  } as unknown as WorkflowService;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  registerWorkflowWebhookUrlRoutes(app, service);
  return app;
}

const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.MEDEA_SSO_SECRET = process.env.MEDEA_SSO_SECRET;
  envBackup.MEDEA_PUBLIC_BASE_URL = process.env.MEDEA_PUBLIC_BASE_URL;
  process.env.MEDEA_SSO_SECRET = SECRET_A;
  delete process.env.MEDEA_PUBLIC_BASE_URL;
  resetConfigForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigForTests();
});

interface Payload {
  ok: true;
  webhook: { path: string; url: string | null; token: string; authMode: string; customPath: string | null; ref: string | null };
}

describe('GET /:id/webhook-url — gates', () => {
  it('401 senza auth', async () => {
    const app = makeApp({ auth: null });
    expect((await app.request('/wf1/webhook-url')).status).toBe(401);
  });

  it('404 per id sconosciuto E per workflow di ALTRO tenant (isolation)', async () => {
    const app = makeApp({ workflows: { wfX: makeWorkflow('wfX', 'altro-tenant', [webhookNode()]) } });
    expect((await app.request('/sconosciuto/webhook-url')).status).toBe(404);
    expect((await app.request('/wfX/webhook-url')).status).toBe(404);
  });

  it('409 se il workflow non ha trigger_webhook', async () => {
    const app = makeApp({
      workflows: { wf1: makeWorkflow('wf1', 't1', [{ id: 'n1', defId: 'trigger_cron', config: {} }]) },
    });
    expect((await app.request('/wf1/webhook-url')).status).toBe(409);
  });

  it('superadmin senza impersonate legge cross-tenant (stesso pattern di GET /:id)', async () => {
    const app = makeApp({
      auth: { tenantId: 't1', role: 'superadmin' },
      workflows: { wfX: makeWorkflow('wfX', 'altro-tenant', [webhookNode()]) },
    });
    expect((await app.request('/wfX/webhook-url')).status).toBe(200);
  });
});

describe('GET /:id/webhook-url — authMode none (il fix "no-token")', () => {
  it('il token è ESATTAMENTE quello che authorize() verificherà — mai "no-token"', async () => {
    const app = makeApp({ workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode()]) } });
    const res = await app.request('/wf1/webhook-url');
    expect(res.status).toBe(200);
    const body = await res.json() as Payload;
    const expected = deriveDefaultWebhookToken('wf1');
    expect(body.webhook.token).toBe(expected);
    expect(body.webhook.path).toBe(`/webhooks/wf1/${expected}`);
    expect(body.webhook.token).not.toBe('no-token');
    expect(body.webhook.ref).toBe('ref://wf/wf1/webhook');
  });

  it('ANTI-REGRESSIONE rotazione: dopo il cambio secret l\'endpoint dà il token NUOVO', async () => {
    const app = makeApp({ workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode()]) } });
    const before = (await (await app.request('/wf1/webhook-url')).json() as Payload).webhook.token;
    process.env.MEDEA_SSO_SECRET = SECRET_B;
    const after = (await (await app.request('/wf1/webhook-url')).json() as Payload).webhook.token;
    expect(after).not.toBe(before);
    expect(after).toBe(deriveDefaultWebhookToken('wf1'));
  });

  it('customPath: path /webhooks/c/… + ref col path custom + slash esterni normalizzati', async () => {
    const app = makeApp({
      workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode({ customPath: '/streammy/search/' })]) },
    });
    const body = await (await app.request('/wf1/webhook-url')).json() as Payload;
    const token = deriveDefaultWebhookToken('wf1');
    expect(body.webhook.path).toBe(`/webhooks/c/streammy/search/${token}`);
    expect(body.webhook.customPath).toBe('streammy/search');
    expect(body.webhook.ref).toBe('ref://wf/wf1/webhook/c/streammy/search');
  });

  it('customPath fuori charset ref: path costruito, ref null (indirection non disponibile)', async () => {
    const app = makeApp({
      workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode({ customPath: 'spazio non valido' })]) },
    });
    const body = await (await app.request('/wf1/webhook-url')).json() as Payload;
    expect(body.webhook.ref).toBeNull();
    expect(body.webhook.path).toContain('/webhooks/c/spazio non valido/');
  });

  it('503 fail-visible senza secret container — MAI un URL fasullo', async () => {
    delete process.env.MEDEA_SSO_SECRET;
    const app = makeApp({ workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode()]) } });
    expect((await app.request('/wf1/webhook-url')).status).toBe(503);
  });

  it('url assoluto quando MEDEA_PUBLIC_BASE_URL è configurata, null altrimenti', async () => {
    const app = makeApp({ workflows: { wf1: makeWorkflow('wf1', 't1', [webhookNode()]) } });
    expect((await (await app.request('/wf1/webhook-url')).json() as Payload).webhook.url).toBeNull();
    process.env.MEDEA_PUBLIC_BASE_URL = 'https://cucurachi.app.automazionezeli.com/';
    resetConfigForTests();
    const body = await (await app.request('/wf1/webhook-url')).json() as Payload;
    expect(body.webhook.url).toBe(`https://cucurachi.app.automazionezeli.com/webhooks/wf1/${deriveDefaultWebhookToken('wf1')}`);
  });
});

describe('GET /:id/webhook-url — altri authMode (semantica allineata ad authorize())', () => {
  it('header-token: segmento = authSecret; senza secret → 503', async () => {
    const app = makeApp({
      workflows: {
        wf1: makeWorkflow('wf1', 't1', [webhookNode({ authMode: 'header-token', authSecret: 'tok-segreto' })]),
        wf2: makeWorkflow('wf2', 't1', [webhookNode({ authMode: 'header-token' })]),
      },
    });
    const body = await (await app.request('/wf1/webhook-url')).json() as Payload;
    expect(body.webhook.token).toBe('tok-segreto');
    expect(body.webhook.ref).toBeNull(); // indirection solo per token derivati
    expect((await app.request('/wf2/webhook-url')).status).toBe(503);
  });

  it('hmac-signature → "placeholder", basic-auth → "no-token" (slug cosmetici, auth via header)', async () => {
    const app = makeApp({
      workflows: {
        wf1: makeWorkflow('wf1', 't1', [webhookNode({ authMode: 'hmac-signature', hmacSecret: 's' })]),
        wf2: makeWorkflow('wf2', 't1', [webhookNode({ authMode: 'basic-auth', authSecret: 'u:p' })]),
      },
    });
    expect((await (await app.request('/wf1/webhook-url')).json() as Payload).webhook.token).toBe('placeholder');
    expect((await (await app.request('/wf2/webhook-url')).json() as Payload).webhook.token).toBe('no-token');
  });
});
