/**
 * Route /webhooks/telegram/:workflowId — integration test (servizi stubbati,
 * stesso pattern del gemello whatsapp-trigger/route.test.ts).
 *
 * Contratti: secret header fail-closed (401), una run per update, dedup
 * update_id, filtro chatId, edited off di default, workflow disabled → 200
 * senza run (mai far accumulare la coda re-delivery Telegram).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTelegramTriggerRoutes } from './index.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { __resetWebhookIdempotency } from '@/routes/webhook-guards.js';

const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;
const SECRET = 'tg-secret-demo';

function makeWorkflow(configOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id: 'wf-tg',
    tenantId: 'tenant-1',
    name: 'Pizzeria bot TG',
    enabled: true,
    nodes: [
      { id: 'tg-node-1', defId: 'trigger_telegram', config: { secretToken: SECRET, ...configOver }, x: 0, y: 0 },
    ],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function update(updateId: number, text = 'una margherita', chatId = 42): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: 5, from: { id: 777, username: 'nicola84', first_name: 'Nicola' },
      chat: { id: chatId, type: 'private' }, date: 1751810400, text,
    },
  });
}

async function post(app: ReturnType<typeof createTelegramTriggerRoutes>, body: string, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return app.request('/telegram/wf-tg', { method: 'POST', headers, body });
}

let workflowGetAnyTenant: ReturnType<typeof vi.fn>;
let runExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetWebhookIdempotency();
  workflowGetAnyTenant = vi.fn(async (id: string) => (id === 'wf-tg' ? makeWorkflow() : null));
  runExecute = vi.fn(async () => ({ runId: 'r-1', status: 'completed', steps: [] }));
  vi.spyOn(WorkflowService.prototype, 'getByIdAnyTenant').mockImplementation(workflowGetAnyTenant as never);
  vi.spyOn(RunService.prototype, 'execute').mockImplementation(runExecute as never);
});

const makeApp = () => createTelegramTriggerRoutes(eventBus);

describe('POST /telegram/:workflowId', () => {
  it('secret corretto → 200 e una run col payload normalizzato (triggerType telegram)', async () => {
    const res = await post(makeApp(), update(1));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 1 });
    expect(runExecute).toHaveBeenCalledTimes(1);
    const arg = runExecute.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.triggerType).toBe('telegram');
    expect(arg.tenantId).toBe('tenant-1');
    expect(arg.triggerInput).toMatchObject({
      kind: 'message', updateId: 1, chatId: 42, userId: 777, text: 'una margherita',
    });
  });

  it('🚨 secret sbagliato → 401, ZERO run', async () => {
    const res = await post(makeApp(), update(2), 'WRONG');
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 header secret ASSENTE → 401, ZERO run', async () => {
    const res = await post(makeApp(), update(3), null);
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 fail-closed: nodo senza secretToken → 401 anche con header vuoto', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ secretToken: undefined }));
    const res = await post(makeApp(), update(4), '');
    expect(res.status).toBe(401);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 re-delivery (stesso update_id) → seconda consegna NON riesegue', async () => {
    const app = makeApp();
    await post(app, update(5));
    const res2 = await post(app, update(5));
    expect(await res2.json()).toMatchObject({ received: 0 });
    expect(runExecute).toHaveBeenCalledTimes(1);
  });

  it('edited_message IGNORATO di default; incluso con includeEdited=true', async () => {
    const edited = JSON.stringify({
      update_id: 6,
      edited_message: { message_id: 5, from: { id: 777 }, chat: { id: 42, type: 'private' }, date: 1751810400, text: 'edit' },
    });
    const app = makeApp();
    await post(app, edited);
    expect(runExecute).not.toHaveBeenCalled();
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ includeEdited: 'true' }));
    await post(makeApp(), JSON.stringify({ ...JSON.parse(edited), update_id: 7 }));
    expect(runExecute).toHaveBeenCalledTimes(1);
    expect((runExecute.mock.calls[0]![0] as { triggerInput: { kind: string } }).triggerInput.kind).toBe('edited');
  });

  it('chatIdFilter: update di un\'ALTRA chat → scartato', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({ chatIdFilter: '42' }));
    const res = await post(makeApp(), update(8, 'x', 999));
    expect(await res.json()).toMatchObject({ received: 0 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 workflow disabilitato → 200 con dropped (mai non-2xx: Telegram accoderebbe i retry), zero run', async () => {
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({}, { enabled: false }));
    const res = await post(makeApp(), update(9));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, received: 0, dropped: 1 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('body firmato ma non-JSON o update non gestito → 200 received 0', async () => {
    const app = makeApp();
    expect((await post(app, 'garbage')).status).toBe(200);
    const res = await post(app, JSON.stringify({ update_id: 10, poll: {} }));
    expect(await res.json()).toMatchObject({ received: 0 });
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('workflow inesistente o senza nodo trigger_telegram → 404', async () => {
    const res = await makeApp().request('/telegram/wf-nope', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: update(11),
    });
    expect(res.status).toBe(404);
    workflowGetAnyTenant.mockResolvedValue(makeWorkflow({}, { nodes: [{ id: 'n', defId: 'trigger_webhook', config: {}, x: 0, y: 0 }] }));
    const res2 = await post(makeApp(), update(12));
    expect(res2.status).toBe(404);
  });
});
