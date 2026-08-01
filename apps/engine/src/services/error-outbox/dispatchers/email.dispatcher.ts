/**
 * Dispatcher canale 'email' della notifica errore.
 *
 * #1 (review): l'email NON viene inviata via SMTP dal container (il vecchio
 * failure-notifier apriva un transport su porta da env — 465 è bloccata in egress
 * dal container → 120s di timeout → coda bruciata; e quell'env nel container non
 * c'era nemmeno → email MAI inviata). Qui l'invio è DELEGATO al PORTAL via S2S: il
 * portal manda con Orion su 587/STARTTLS (transport già configurato, anti-downgrade).
 * Risultato: ZERO SMTP nel runtime → nessun rischio 465, canale finalmente vivo.
 *
 * Re-risolve onError.emailTo al dispatch (config corrente). `sendViaPortal` DEVE
 * throware sul fallimento → il worker ritenta/dead (#2). Iniettato → testabile.
 */

import type { ErrorOutboxRecord } from '../repository.js';
import type { ChannelDispatcher } from '../worker.js';

export interface EmailResolvedTarget {
  emailTo?: string | undefined;
  /** Nome del workflow al dispatch (config corrente) — per un'email leggibile. */
  workflowName?: string | undefined;
}

export interface FailureEmailPayload {
  to: string;
  workflowId: string;
  workflowName?: string | undefined;
  runId: string;
  tenantId: string;
  errorNodeId: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  startedAt: string;
}

export interface EmailDispatcherDeps {
  /** Re-risolve onError del workflow (config CORRENTE). null → workflow sparito. */
  loadOnError: (workflowId: string, tenantId: string) => Promise<EmailResolvedTarget | null>;
  /** Invio DELEGATO al portal (Orion 587/STARTTLS). DEVE throware sul fallimento. */
  sendViaPortal: (payload: FailureEmailPayload) => Promise<void>;
}

export function makeEmailDispatcher(deps: EmailDispatcherDeps): ChannelDispatcher {
  return async (ev: ErrorOutboxRecord): Promise<void> => {
    const target = await deps.loadOnError(ev.workflowId, ev.tenantId);
    const to = target?.emailTo;
    if (!to) return; // re-risolto via / workflow sparito → niente da inviare (done)

    await deps.sendViaPortal({
      to,
      workflowId: ev.workflowId,
      workflowName: target.workflowName,
      runId: ev.runId,
      tenantId: ev.tenantId,
      errorNodeId: ev.errorNodeId,
      errorMessage: ev.errorMessage,
      durationMs: ev.durationMs,
      startedAt: ev.startedAt,
    });
  };
}
