/**
 * GET /workflows/:id/webhook-url — SSOT dell'URL pubblico del webhook.
 *
 * FIX SISTEMICO "no-token" (post-mortem Streammy 2026-07): il token del
 * webhook authMode=none è derivato dal secret del container — il secret vive
 * SOLO nel backend (giusto), quindi il frontend non può calcolarlo e mostrava
 * il placeholder "no-token" su OGNI webhook. Questo endpoint è il canale
 * corretto: il backend, che ha il secret, calcola il token CORRENTE e
 * restituisce path/URL completi + il ref simbolico da usare nei link interni
 * (indirection, vedi `lib/webhook-ref.ts`).
 *
 * Il token NON è un secret ulteriore per chi chiama: l'endpoint è dietro la
 * stessa auth tenant di GET /workflows/:id, e chi legge il workflow vede già
 * la config del trigger (authSecret incluso).
 */

import type { Hono } from 'hono';
import type { Workflow, CanvasNode } from '@medea/engine-core-schema';
import type { WorkflowService } from '@/services/workflow.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { loadConfig } from '@/config.js';
import { deriveDefaultWebhookToken } from '@/lib/webhook-token.js';
import { buildWebhookRef, WebhookRefSchema } from '@/lib/webhook-ref.js';

/** Shape della risposta — consumata dall'editor (WebhookTester). */
export interface WebhookUrlPayload {
  /** Path relativo pronto: /webhooks/<id>/<segment> o /webhooks/c/<path>/<segment>. */
  path: string;
  /** URL assoluto quando MEDEA_PUBLIC_BASE_URL è configurata, altrimenti null. */
  url: string | null;
  /** Segmento token del path (derivato per `none`, secret per `header-token`, cosmetico altrove). */
  token: string;
  authMode: string;
  customPath: string | null;
  /** Riferimento simbolico per link interni (solo authMode `none`), altrimenti null. */
  ref: string | null;
}

function findWebhookNode(workflow: Workflow): CanvasNode | undefined {
  return workflow.nodes.find((n) => n.defId === 'trigger_webhook');
}

/**
 * Segmento token del path per ogni authMode — STESSA semantica del
 * verificatore (`routes/webhooks.ts authorize()`): per `none` il segmento È
 * l'auth (derivato); per `header-token` è confrontato con authSecret; per
 * basic/hmac/jwt l'auth avviene via header e il segmento è uno slug cosmetico.
 */
function tokenSegment(workflowId: string, node: CanvasNode): { segment: string | null; authMode: string } {
  const authMode = typeof node.config.authMode === 'string' && node.config.authMode !== '' ? node.config.authMode : 'none';
  if (authMode === 'none') {
    const derived = deriveDefaultWebhookToken(workflowId);
    return { segment: derived === '' ? null : derived, authMode };
  }
  if (authMode === 'header-token') {
    const secret = typeof node.config.authSecret === 'string' ? node.config.authSecret : '';
    return { segment: secret === '' ? null : secret, authMode };
  }
  if (authMode === 'hmac-signature') return { segment: 'placeholder', authMode };
  return { segment: 'no-token', authMode }; // basic-auth, jwt
}

export function registerWorkflowWebhookUrlRoutes(app: Hono, service: WorkflowService): void {
  app.get('/:id/webhook-url', async (c) => {
    const auth = c.get('auth') as { tenantId: string; role?: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const impersonateHeader = c.req.header('x-tenant-id');
    const isCrossTenant = auth.role === 'superadmin' && !impersonateHeader;
    const tenantId = getTenantId(c);
    const id = c.req.param('id');

    const workflow = isCrossTenant
      ? await service.getByIdAnyTenant(id)
      : await service.get(id, tenantId);
    if (!workflow) return c.json({ error: 'Not found' }, 404);

    const node = findWebhookNode(workflow);
    if (!node) return c.json({ error: 'Workflow has no webhook trigger' }, 409);

    const { segment, authMode } = tokenSegment(workflow.id, node);
    if (segment === null) {
      // authMode none senza secret container (dev) o header-token senza
      // authSecret configurato: nessun URL VERO esiste — fail-visible, mai
      // un placeholder copiabile spacciato per token.
      return c.json({ error: authMode === 'none'
        ? 'SSO secret non configurato: il token webhook non è derivabile'
        : 'authSecret non configurato per header-token' }, 503);
    }

    const rawCustomPath = typeof node.config.customPath === 'string' ? node.config.customPath.trim().replace(/^\/+|\/+$/gu, '') : '';
    const customPath = rawCustomPath === '' ? null : rawCustomPath;

    const path = customPath !== null
      ? `/webhooks/c/${customPath}/${segment}`
      : `/webhooks/${workflow.id}/${segment}`;

    const base = loadConfig().MEDEA_PUBLIC_BASE_URL;
    const url = base ? `${base.replace(/\/+$/u, '')}${path}` : null;

    // Il ref esiste solo dove il token è derivato (indirection possibile) e
    // solo se il customPath rispetta il charset dello schema ref.
    let ref: string | null = null;
    if (authMode === 'none') {
      const candidate = customPath !== null
        ? { workflowId: workflow.id, customPath }
        : { workflowId: workflow.id };
      if (WebhookRefSchema.safeParse(candidate).success) ref = buildWebhookRef(candidate);
    }

    const payload: WebhookUrlPayload = { path, url, token: segment, authMode, customPath, ref };
    return c.json({ ok: true, webhook: payload });
  });
}
