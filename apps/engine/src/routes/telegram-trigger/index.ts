/**
 * Telegram trigger routes — endpoint webhook Bot API per workflow con nodo
 * `trigger_telegram`. Montato sotto /webhooks (server.ts) accanto al gemello
 * /whatsapp, PRIMA delle route generiche /:workflowId/:token.
 *
 * URL da registrare via setWebhook:
 *   https://<tenant>.app.automazionezeli.com/webhooks/telegram/<workflowId>
 *   (&secret_token=<secret del nodo>)
 *
 * Auth fail-closed: header X-Telegram-Bot-Api-Secret-Token confrontato
 * timing-safe col secret del nodo (verify.ts). Dedup per update_id via
 * webhookIdempotencySeen (TTL 24h). Risposta 200 immediata + run asincrona:
 * Telegram ritenta i non-2xx e accoda gli update — mai bloccare sulla durata
 * del workflow. Workflow disabilitato → 200 con drop loggato (un 5xx
 * farebbe accumulare la coda di re-delivery Telegram).
 *
 * @module routes/telegram-trigger
 */

import { Hono } from 'hono';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { publishTestEvent } from '@/services/test-event-bus.service.js';
import { webhookIdempotencySeen, bodyHash } from '@/routes/webhook-guards.js';
import { verifyTelegramSecret } from './verify.js';
import { normalizeTelegramUpdate } from './normalize.js';
import type { Workflow, CanvasNode } from '@medea/engine-core-schema';

export const TELEGRAM_TRIGGER_DEF_ID = 'trigger_telegram';

function findTelegramNode(workflow: Workflow): CanvasNode | undefined {
  return workflow.nodes.find((n) => n.defId === TELEGRAM_TRIGGER_DEF_ID);
}

function nodeString(node: CanvasNode, key: string): string {
  const v = node.config[key];
  return typeof v === 'string' ? v : '';
}

export function createTelegramTriggerRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);
  const runs = new RunService(eventBus);

  app.post('/telegram/:workflowId', async (c) => {
    const workflowId = c.req.param('workflowId') ?? '';
    if (!workflowId) return c.json({ error: 'Bad request' }, 400);
    // Route PUBBLICA (come /webhooks): lookup cross-tenant, l'auth vera è il
    // secret header verificato sul nodo stesso.
    const workflow = await workflows.getByIdAnyTenant(workflowId);
    if (!workflow) return c.json({ error: 'Not found' }, 404);
    const node = findTelegramNode(workflow);
    if (!node) return c.json({ error: 'Not found' }, 404);
    const tenantId = workflow.tenantId ?? 'default';

    const headerToken = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!verifyTelegramSecret(headerToken, nodeString(node, 'secretToken'))) {
      logger.warn({ workflowId }, 'Telegram secret token verification failed');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const rawBody = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn({ workflowId }, 'Telegram payload is not JSON — dropped');
      return c.json({ ok: true, received: 0 }, 200);
    }

    const event = normalizeTelegramUpdate(payload);
    if (!event) return c.json({ ok: true, received: 0 }, 200);

    const includeEdited = node.config.includeEdited === 'true';
    if (event.kind === 'edited' && !includeEdited) {
      return c.json({ ok: true, received: 0 }, 200);
    }
    const chatFilter = nodeString(node, 'chatIdFilter');
    if (chatFilter !== '' && String(event.chatId) !== chatFilter) {
      return c.json({ ok: true, received: 0 }, 200);
    }
    // Dedup re-delivery Telegram: stesso update_id entro 24h = già processato.
    if (webhookIdempotencySeen(node.id, `tg:${String(event.updateId)}`)) {
      logger.info({ workflowId, updateId: event.updateId }, 'Telegram duplicate update — skip run');
      return c.json({ ok: true, received: 0 }, 200);
    }

    if (!workflow.enabled) {
      // 200 comunque: un non-2xx fa ritentare Telegram e accumula la coda.
      logger.warn({ workflowId, updateId: event.updateId }, 'Telegram update dropped: workflow disabled');
      return c.json({ ok: true, received: 0, dropped: 1 }, 200);
    }

    // Envelope webhook-shaped per il pannello "listen" dell'editor.
    publishTestEvent(tenantId, workflow.id, { method: 'POST', headers: {}, query: {}, body: event });
    void runs.execute({
      workflowId: workflow.id,
      triggerType: 'telegram',
      triggerInput: event,
      tenantId,
    })
      .then((r) => { logger.info({ runId: r.runId, status: r.status, workflowId }, 'Telegram-triggered run completed'); })
      .catch((err: unknown) => { logger.error({ err, workflowId }, 'Telegram-triggered run failed'); });

    logger.info({ workflowId, updateId: event.updateId, bodyHash: bodyHash(rawBody) }, 'Telegram webhook hit');
    return c.json({ ok: true, received: 1 }, 200);
  });

  return app;
}
