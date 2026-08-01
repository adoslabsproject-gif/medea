/**
 * Dispatcher canale 'fanout' — avvia l'error-WORKFLOW (trigger_error) sul run fallito.
 *
 * Preserva la semantica GAP-5/E4 (zero downgrade), ora DUREVOLE:
 *  - re-risolve l'errorWorkflowId al dispatch (per-wf → tenant catch-all): usa la
 *    config CORRENTE, non una stale dell'enqueue.
 *  - anti-self: errWfId === sorgente → no-op.
 *  - rate-limit (leaky bucket per source): se superato → DROP intenzionale (anti
 *    self-DoS), NON retry-storm → l'evento si chiude 'done'.
 *  - avvio dell'handler delegato (startErrorHandler): risolve nome/AI-triage e lancia
 *    il run 'error-handler'. Throwa sul fallimento di START → retry/dead (#2).
 *
 * L'anti-loop (#4) è già a monte (il writer non enqueue 'fanout' per i run
 * 'error-handler') → un error-workflow che fallisce non rigenera fanout.
 */

import type { ErrorOutboxRecord } from '../repository.js';
import type { ChannelDispatcher } from '../worker.js';

export interface FanoutStartParams {
  errorWorkflowId: string;
  sourceWorkflowId: string;
  tenantId: string;
  runId: string;
  failedNodeId: string | null;
  error: string | null;
  triggerInputJson: string | null;
}

export interface FanoutDispatcherDeps {
  /** errorWorkflowId risolto (per-wf ?? tenant catch-all), o null se nessun handler. */
  resolveErrorWorkflowId: (sourceWorkflowId: string, tenantId: string) => Promise<string | null>;
  /** Leaky-bucket per source: false = oltre soglia → drop anti-storm. */
  checkRateLimit: (sourceWorkflowId: string) => boolean;
  /** Avvia il run 'error-handler' (risolve nome/AI-triage internamente). Throwa su fallimento di START. */
  startErrorHandler: (params: FanoutStartParams) => Promise<void>;
  /** Hook osservabilità per il drop da rate-limit (default no-op). */
  onRateLimited?: (sourceWorkflowId: string, errorWorkflowId: string) => void;
}

export function makeFanoutDispatcher(deps: FanoutDispatcherDeps): ChannelDispatcher {
  return async (ev: ErrorOutboxRecord): Promise<void> => {
    const errWfId = await deps.resolveErrorWorkflowId(ev.workflowId, ev.tenantId);
    if (errWfId === null || errWfId === ev.workflowId) return; // nessun handler / anti-self → done

    if (!deps.checkRateLimit(ev.workflowId)) {
      deps.onRateLimited?.(ev.workflowId, errWfId); // drop intenzionale → done (no retry-storm)
      return;
    }

    await deps.startErrorHandler({
      errorWorkflowId: errWfId,
      sourceWorkflowId: ev.workflowId,
      tenantId: ev.tenantId,
      runId: ev.runId,
      failedNodeId: ev.errorNodeId,
      error: ev.errorMessage,
      triggerInputJson: ev.triggerInputJson,
    });
  };
}
