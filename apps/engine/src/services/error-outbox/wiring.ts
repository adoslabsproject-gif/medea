/**
 * Composizione dei dispatcher dell'outbox errori con le dipendenze REALI del runtime.
 *
 * Plumbing puro: i singoli dispatcher sono già testati in isolamento (DI); qui li si
 * lega ai servizi. Punti che restano significativi (testati):
 *  - loadOnError: mappa workflow.onError → webhookUrl/emailTo/workflowName (config CORRENTE
 *    al dispatch, niente URL/secret persistiti nell'outbox).
 *  - webhook: usa il fetch SSRF-SAFE (`safeOutboundFetch`), NON `internalAwareFetch` — il
 *    webhookUrl è user-controlled, non deve poter colpire host interni.
 *  - fanout: resolveErrorWorkflowId = per-workflow → tenant catch-all (GAP-5 a due livelli).
 *
 * safeFetch/sendViaPortal sono iniettabili (default = reali) per testare la composizione
 * senza rete.
 */

import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import type { ErrorOutboxChannel } from '@/storage/schema.js';
import type { ChannelDispatcher } from './worker.js';
import { makeWebhookDispatcher, type WebhookDispatcherDeps } from './dispatchers/webhook.dispatcher.js';
import { makeEmailDispatcher, type EmailDispatcherDeps } from './dispatchers/email.dispatcher.js';
import { makeFanoutDispatcher, type FanoutStartParams } from './dispatchers/fanout.dispatcher.js';
import { sendFailureEmailViaPortal } from './portal-email-client.js';

export interface WorkflowOnErrorView {
  name?: string | undefined;
  onError?: { webhookUrl?: string | undefined; emailTo?: string | undefined } | undefined;
}

export interface OutboxWiringDeps {
  getWorkflow: (workflowId: string, tenantId: string) => Promise<WorkflowOnErrorView | null>;
  getErrorWorkflowId: (workflowId: string, tenantId: string) => Promise<string | null>;
  getTenantErrorWorkflowId: () => string | null;
  checkRateLimit: (sourceWorkflowId: string) => boolean;
  startErrorHandler: (p: FanoutStartParams) => Promise<void>;
  /** Override per test (default = safeOutboundFetch SSRF-safe). */
  safeFetch?: WebhookDispatcherDeps['safeFetch'];
  /** Override per test (default = invio via portal S2S). */
  sendViaPortal?: EmailDispatcherDeps['sendViaPortal'];
}

function defaultSafeFetch(): WebhookDispatcherDeps['safeFetch'] {
  return async (url, opts) => {
    const res = await safeOutboundFetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
    });
    return { ok: res.ok, status: res.status, body: res.body };
  };
}

export function buildOutboxDispatchers(deps: OutboxWiringDeps): Record<ErrorOutboxChannel, ChannelDispatcher> {
  const loadOnError = async (
    workflowId: string,
    tenantId: string,
  ): Promise<{ webhookUrl?: string | undefined; emailTo?: string | undefined; workflowName?: string | undefined } | null> => {
    const wf = await deps.getWorkflow(workflowId, tenantId);
    if (!wf) return null;
    return { webhookUrl: wf.onError?.webhookUrl, emailTo: wf.onError?.emailTo, workflowName: wf.name };
  };

  return {
    webhook: makeWebhookDispatcher({ loadOnError, safeFetch: deps.safeFetch ?? defaultSafeFetch() }),
    email: makeEmailDispatcher({ loadOnError, sendViaPortal: deps.sendViaPortal ?? sendFailureEmailViaPortal }),
    fanout: makeFanoutDispatcher({
      resolveErrorWorkflowId: async (src, tenant) =>
        (await deps.getErrorWorkflowId(src, tenant)) ?? deps.getTenantErrorWorkflowId(),
      checkRateLimit: deps.checkRateLimit,
      startErrorHandler: deps.startErrorHandler,
      onRateLimited: (src, errWf) =>
        logger.warn(
          { sourceWorkflowId: src, errorWorkflowId: errWf },
          '[WE-14] error-workflow fan-out RATE-LIMITED (durevole) — drop',
        ),
    }),
  };
}
