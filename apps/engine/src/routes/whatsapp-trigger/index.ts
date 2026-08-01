/**
 * WhatsApp trigger routes — endpoint webhook Meta Cloud API per workflow
 * con nodo `trigger_whatsapp`. Montato sotto /webhooks (server.ts) PRIMA
 * delle route generiche /:workflowId/:token, così il segmento statico
 * /whatsapp/ non viene catturato dai param del webhook generico.
 *
 * URL da incollare nel pannello Meta (Configurazione → Webhook):
 *   https://<tenant>.app.automazionezeli.com/webhooks/whatsapp/<workflowId>
 *
 * Protocollo:
 *   GET  = verification handshake — 200 text/plain col hub.challenge SOLO se
 *          hub.verify_token combacia (timing-safe) col verifyToken del nodo.
 *          Funziona anche a workflow disabilitato: la subscription Meta si
 *          configura PRIMA di abilitare il bot.
 *   POST = eventi firmati X-Hub-Signature-256 (HMAC-SHA256 App Secret sui
 *          byte esatti del body). Firma invalida/assente = 401 fail-closed.
 *          Un POST può batchare N messaggi → UNA RUN PER MESSAGGIO, payload
 *          normalizzato (vedi normalize.ts). Risposta 200 immediata + run
 *          fire-and-forget: Meta ritenta i non-2xx e disabilita i webhook
 *          lenti, quindi mai bloccare sulla durata del workflow.
 *
 * Dedup: Meta ri-consegna gli eventi non ACK-ati → webhookIdempotencySeen
 * (TTL 24h) su message-id; gli status condividono il wamid del messaggio
 * inviato → chiave composta con lo status per non collassare sent/delivered/read.
 *
 * Sicurezza rete: eredita il rate-limit publicHookLimiter di /webhooks/*
 * (server.ts). Nessun token in URL: l'auth è la firma HMAC obbligatoria.
 *
 * @module routes/whatsapp-trigger
 */

import { Hono } from 'hono';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { publishTestEvent } from '@/services/test-event-bus.service.js';
import { webhookIdempotencySeen, bodyHash } from '@/routes/webhook-guards.js';
import { verifyMetaSignature, evaluateHandshake } from './verify.js';
import { extractWhatsAppEvents, type NormalizedWhatsAppMessage, type NormalizedWhatsAppStatus } from './normalize.js';
import type { Workflow, CanvasNode } from '@flowforge/core-schema';

export const WHATSAPP_TRIGGER_DEF_ID = 'trigger_whatsapp';

function findWhatsAppNode(workflow: Workflow): CanvasNode | undefined {
  return workflow.nodes.find((n) => n.defId === WHATSAPP_TRIGGER_DEF_ID);
}

function nodeSecret(node: CanvasNode, key: string): string {
  const v = node.config[key];
  return typeof v === 'string' ? v : '';
}

export function createWhatsAppTriggerRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);
  const runs = new RunService(eventBus);

  /**
   * Risolve workflow + nodo trigger. Route PUBBLICA (come /webhooks): lookup
   * cross-tenant, l'auth vera è handshake/firma sul nodo stesso.
   */
  async function resolve(workflowId: string): Promise<{ workflow: Workflow; node: CanvasNode } | null> {
    if (!workflowId) return null;
    const workflow = await workflows.getByIdAnyTenant(workflowId);
    if (!workflow) return null;
    const node = findWhatsAppNode(workflow);
    if (!node) return null;
    return { workflow, node };
  }

  // ── GET: verification handshake Meta ────────────────────────────────
  app.get('/whatsapp/:workflowId', async (c) => {
    const resolved = await resolve(c.req.param('workflowId') ?? '');
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    const challenge = evaluateHandshake(
      {
        mode: c.req.query('hub.mode') ?? '',
        verifyToken: c.req.query('hub.verify_token') ?? '',
        challenge: c.req.query('hub.challenge') ?? '',
      },
      nodeSecret(resolved.node, 'verifyToken'),
    );
    if (challenge === null) {
      logger.warn({ workflowId: resolved.workflow.id }, 'WhatsApp handshake rejected (verify token mismatch or bad mode)');
      return c.json({ error: 'Forbidden' }, 403);
    }
    logger.info({ workflowId: resolved.workflow.id }, 'WhatsApp handshake OK');
    return c.text(challenge, 200);
  });

  // ── POST: eventi firmati ────────────────────────────────────────────
  app.post('/whatsapp/:workflowId', async (c) => {
    const resolved = await resolve(c.req.param('workflowId') ?? '');
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    const { workflow, node } = resolved;
    const tenantId = workflow.tenantId ?? 'default';

    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256') ?? '';
    if (!verifyMetaSignature(rawBody, signature, nodeSecret(node, 'appSecret'))) {
      logger.warn({ workflowId: workflow.id, bodyHash: bodyHash(rawBody) }, 'WhatsApp signature verification failed');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Firma valida ma body non-JSON: impossibile da Meta reale, ma 200
      // (payload vuoto) evita retry-storm su un evento comunque inutilizzabile.
      logger.warn({ workflowId: workflow.id }, 'WhatsApp signed payload is not JSON — dropped');
      return c.json({ ok: true, received: 0 }, 200);
    }

    const events = extractWhatsAppEvents(payload);
    const phoneFilter = nodeSecret(node, 'phoneNumberIdFilter');
    // NodeConfig è string|undefined dopo il round-trip JSON (boolean UI → 'true'/'false').
    const includeStatuses = node.config.includeStatuses === 'true';

    const toRun: (NormalizedWhatsAppMessage | NormalizedWhatsAppStatus)[] = [];
    for (const msg of events.messages) {
      if (phoneFilter !== '' && msg.phoneNumberId !== phoneFilter) continue;
      // Dedup re-delivery Meta: stesso wamid entro 24h = già processato.
      if (webhookIdempotencySeen(node.id, `wa:${msg.messageId}`)) {
        logger.info({ workflowId: workflow.id, messageId: msg.messageId }, 'WhatsApp duplicate message — skip run');
        continue;
      }
      toRun.push(msg);
    }
    if (includeStatuses) {
      for (const st of events.statuses) {
        if (phoneFilter !== '' && st.phoneNumberId !== phoneFilter) continue;
        // Gli status sent/delivered/read condividono il wamid → chiave composta.
        if (webhookIdempotencySeen(node.id, `wa-status:${st.messageId}:${st.status}`)) continue;
        toRun.push(st);
      }
    }

    if (!workflow.enabled) {
      // 200 comunque: un non-2xx fa ritentare Meta e, se persiste, DISABILITA
      // la subscription dell'app → si perderebbe il webhook per TUTTI i
      // workflow. Il drop è loggato per diagnosi.
      if (toRun.length > 0) {
        logger.warn({ workflowId: workflow.id, dropped: toRun.length }, 'WhatsApp events dropped: workflow disabled');
      }
      return c.json({ ok: true, received: 0, dropped: toRun.length }, 200);
    }

    for (const event of toRun) {
      // Envelope webhook-shaped per il pannello "listen" dell'editor: il
      // payload normalizzato viaggia come body (headers/query non pertinenti).
      publishTestEvent(tenantId, workflow.id, { method: 'POST', headers: {}, query: {}, body: event });
      void runs.execute({
        workflowId: workflow.id,
        triggerType: 'whatsapp',
        triggerInput: event,
        tenantId,
      })
        .then((r) => { logger.info({ runId: r.runId, status: r.status, workflowId: workflow.id }, 'WhatsApp-triggered run completed'); })
        .catch((err: unknown) => { logger.error({ err, workflowId: workflow.id }, 'WhatsApp-triggered run failed'); });
    }

    logger.info({ workflowId: workflow.id, received: toRun.length, bodyHash: bodyHash(rawBody) }, 'WhatsApp webhook hit');
    return c.json({ ok: true, received: toRun.length }, 200);
  });

  return app;
}
