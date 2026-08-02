/**
 * Route /webhooks/whatsapp/:workflowId — integration test del protocollo Meta
 * end-to-end sul router Hono reale (WorkflowService/RunService stubbate, come
 * webhooks.test.ts).
 *
 * Contratti coperti:
 *   • GET handshake: echo challenge SOLO con verify token corretto (403/404 altrove)
 *   • POST: firma X-Hub-Signature-256 obbligatoria fail-closed (401)
 *   • una run PER MESSAGGIO (batching), payload normalizzato
 *   • dedup re-delivery per wamid (nessuna doppia run)
 *   • statuses ignorati di default, inclusi con includeStatuses (dedup composto)
 *   • phoneNumberIdFilter
 *   • workflow disabled → 200 senza run (Meta non deve ritentare/disabilitare)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWhatsAppTriggerRoutes } from './index.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { __resetWebhookIdempotency } from '@/routes/webhook-guards.js';

const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;

const APP_SECRET = 'app-secret-test';
const VERIFY_TOKEN = 'verify-token-test';

function makeWorkflow(
  configOver: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) {
  return {
    id: 'wf-wa',
    tenantId: 'tenant-1',
    name: 'Pizzeria bot',
    enabled: true,
    nodes: [
      {
        id: 'wa-node-1',
        defId: 'trigger_whatsapp',
        config: { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, ...configOver },
        x: 0,
        y: 0,
      },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function metaBody(messages: unknown[], statuses: unknown[] = [], phoneNumberId = 'PNID-1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '39061234567', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '393331234567', profile: { name: 'Nicola' } }],
              ...(messages.length > 0 ? { messages } : {}),
              ...(statuses.length > 0 ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  });
}

function textMsg(id: string, body = 'una margherita'): Record<string, unknown> {
  return { from: '393331234567', id, timestamp: '1751810400', type: 'text', text: { body } };
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

async function post(
  app: ReturnType<typeof createWhatsAppTriggerRoutes>,
  body: string,
  headers: Record<string, string> = {},
) {
  return app.request('/whatsapp/wf-wa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body), ...headers },
    body,
  });
}

let workflowGetAnyTenant: ReturnType<typeof vi.fn>;
let runExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetWebhookIdempotency();
  workflowGetAnyTenant = vi.fn(async (id: string) => (id === 'wf-wa' ? makeWorkflow() : null));
  runExecute = vi.fn(async () => ({ runId: 'r-1', status: 'completed', steps: [] }));
  vi.spyOn(WorkflowService.prototype, 'getByIdAnyTenant').mockImplementation(
    workflowGetAnyTenant as never,
  );
  vi.spyOn(RunService.prototype, 'execute').mockImplementation(runExecute as never);
});

const makeApp = () => createWhatsAppTriggerRoutes(eventBus);

describe('GET handshake', () => {
  it('verify token corretto → 200 text/plain con echo del challenge', async () => {
    const res = await makeApp().request(
      `/whatsapp/wf-wa?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-42`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo-42');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('🚨 verify token sbagliato → 403, challenge NON echo-ato', async () => {
    const res = await makeApp().request(
      '/whatsapp/wf-wa?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=echo-42',
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('echo-42');
  });

  it('workflow inesistente → 404', async () => {
    const res = await makeApp().request(
      `/whatsapp/wf-nope?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
    );
    expect(res.status).toBe(404);
  });

  it('workflow senza nodo trigger_whatsapp → 404', async () => {
    workflowGetAnyTenant.mockResolvedValue(
      makeWorkflow(
        {},
        {
          nodes: [{ id: 'n1', defId: 'trigger_webhook', config: {}, x: 0, y: 0 }],
        },
      ),
    );
    const res = await makeApp().request(
      `/whatsapp/wf-wa?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
    );
    expect(res.status).toBe(404);
  });

  it('handshake funziona anche a workflow DISABILITATO (Meta si configura prima di attivare il bot)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({}, { enabled: false }));
    const res = await makeApp().request(
      `/whatsapp/wf-wa?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ok`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('POST eventi — firma', () => {
  it('firma valida → 200 e una run col payload normalizzato', async () => {
    const body = metaBody([textMsg('wamid.1')]);
    const res = await post(makeApp(), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 1 });
    expect(runExecute).toHaveBeenCalledTimes(1);
    const arg = runExecute.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.workflowId).toBe('wf-wa');
    expect(arg.tenantId).toBe('tenant-1');
    expect(arg.triggerType).toBe('whatsapp');
    expect(arg.triggerInput).toMatchObject({
      kind: 'message',
      messageId: 'wamid.1',
      from: '393331234567',
      profileName: 'Nicola',
      text: 'una margherita',
      type: 'text',
    });
  });

  it('🚨 firma invalida → 401, ZERO run', async () => {
    const body = metaBody([textMsg('wamid.1')]);
    const res = await post(makeApp(), body, { 'X-Hub-Signature-256': sign(body, 'wrong') });
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 header firma ASSENTE → 401, ZERO run', async () => {
    const body = metaBody([textMsg('wamid.1')]);
    const res = await makeApp().request('/whatsapp/wf-wa', { method: 'POST', body });
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 fail-closed: nodo senza appSecret configurato → 401 anche con firma su secret vuoto', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ appSecret: undefined }));
    const body = metaBody([textMsg('wamid.1')]);
    const res = await post(makeApp(), body, { 'X-Hub-Signature-256': sign(body, '') });
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('body firmato ma non-JSON → 200 received 0 (no retry-storm Meta), zero run', async () => {
    const body = 'not-json';
    const res = await post(makeApp(), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 0 });
    expect(runExecute).not.toHaveBeenCalled();
  });
});

describe('POST eventi — batching, dedup, filtri', () => {
  it('3 messaggi in un POST → 3 run separate, una per messaggio', async () => {
    const body = metaBody([textMsg('wamid.a'), textMsg('wamid.b'), textMsg('wamid.c')]);
    const res = await post(makeApp(), body);
    expect(await res.json()).toMatchObject({ received: 3 });
    expect(runExecute).toHaveBeenCalledTimes(3);
    const ids = runExecute.mock.calls.map(
      (call) => (call[0] as { triggerInput: { messageId: string } }).triggerInput.messageId,
    );
    expect(ids).toEqual(['wamid.a', 'wamid.b', 'wamid.c']);
  });

  it('🚨 re-delivery Meta (stesso wamid) → seconda consegna NON riesegue il workflow', async () => {
    const app = makeApp();
    const body = metaBody([textMsg('wamid.dup')]);
    await post(app, body);
    const res2 = await post(app, body);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ received: 0 });
    expect(runExecute).toHaveBeenCalledTimes(1);
  });

  it('statuses IGNORATI di default (default off = niente rumore per il bot)', async () => {
    const body = metaBody([], [{ id: 'wamid.out', status: 'delivered', timestamp: '1751810400' }]);
    const res = await post(makeApp(), body);
    expect(await res.json()).toMatchObject({ received: 0 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('includeStatuses=true → run per status, con dedup COMPOSTO (delivered e read dello stesso wamid = 2 run distinte)', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ includeStatuses: 'true' }));
    const app = makeApp();
    await post(
      app,
      metaBody([], [{ id: 'wamid.out', status: 'delivered', timestamp: '1751810400' }]),
    );
    await post(app, metaBody([], [{ id: 'wamid.out', status: 'read', timestamp: '1751810401' }]));
    // Stesso status ri-consegnato → dedup
    const res3 = await post(
      app,
      metaBody([], [{ id: 'wamid.out', status: 'read', timestamp: '1751810401' }]),
    );
    expect(runExecute).toHaveBeenCalledTimes(2);
    expect(await res3.json()).toMatchObject({ received: 0 });
  });

  it("phoneNumberIdFilter: eventi di un ALTRO numero dell'app → scartati", async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ phoneNumberIdFilter: 'PNID-GIUSTO' }));
    const res = await post(makeApp(), metaBody([textMsg('wamid.x')], [], 'PNID-ALTRO'));
    expect(await res.json()).toMatchObject({ received: 0 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 workflow disabilitato → 200 con dropped (mai non-2xx: Meta disabiliterebbe la subscription), zero run', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({}, { enabled: false }));
    const res = await post(makeApp(), metaBody([textMsg('wamid.z')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 0, dropped: 1 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it("POST su workflow inesistente → 404 (l'esistenza è protetta da UUID non-guessable)", async () => {
    const body = metaBody([textMsg('wamid.k')]);
    const res = await makeApp().request('/whatsapp/wf-nope', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(404);
  });
});
