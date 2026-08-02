/**
 * Dispatcher canale 'webhook' della notifica errore.
 *
 * Chiude i buchi del vecchio failure-notifier (fire-and-forget):
 *  - SSRF: usa `safeOutboundFetch` (blocca IP privati/metadata), NON `fetch` raw
 *    (un onError.webhookUrl tenant poteva colpire 127.0.0.1 — bug reale).
 *  - timeout: per-call (un ricevitore appeso non blocca la coda).
 *  - anti-OOM: cancella il body invece di leggerlo (non serve, e un body enorme
 *    non deve saturare la RAM).
 *  - durabilità: throwa su non-2xx → il worker ritenta/dead (#2), non perde l'evento.
 *
 * Re-risolve `onError.webhookUrl` al momento del dispatch (config corrente): se il
 * workflow è stato cancellato o il webhook rimosso → no-op (l'evento si chiude 'done').
 * L'URL NON è salvato nell'outbox (no secret/URL stale persistiti).
 */

import type { ErrorOutboxRecord } from '../repository.js';
import type { ChannelDispatcher } from '../worker.js';

export interface WebhookResolvedTarget {
  webhookUrl?: string | undefined;
}

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  body?: { cancel(): Promise<void> } | null | undefined;
}

export interface WebhookDispatcherDeps {
  /** Re-risolve onError del workflow (config CORRENTE). null → workflow sparito. */
  loadOnError: (workflowId: string, tenantId: string) => Promise<WebhookResolvedTarget | null>;
  /** Fetch SSRF-safe iniettato (in prod: safeOutboundFetch). */
  safeFetch: (
    url: string,
    opts: { method: string; headers: Record<string, string>; body: string; timeoutMs: number },
  ) => Promise<FetchLikeResponse>;
  timeoutMs?: number;
}

export function makeWebhookDispatcher(deps: WebhookDispatcherDeps): ChannelDispatcher {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  return async (ev: ErrorOutboxRecord): Promise<void> => {
    const target = await deps.loadOnError(ev.workflowId, ev.tenantId);
    const url = target?.webhookUrl;
    if (!url) return; // re-risolto via / workflow sparito → niente da inviare (done)

    const body = JSON.stringify({
      type: 'workflow.failed',
      workflowId: ev.workflowId,
      runId: ev.runId,
      tenantId: ev.tenantId,
      errorNodeId: ev.errorNodeId,
      errorMessage: ev.errorMessage,
      durationMs: ev.durationMs,
      startedAt: ev.startedAt,
    });

    const res = await deps.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs,
    });
    // Anti-OOM: il body non ci serve → cancella lo stream (no read).
    try {
      await res.body?.cancel();
    } catch {
      /* best-effort */
    }

    if (!res.ok) {
      throw new Error(`webhook ${url}: HTTP ${String(res.status)}`);
    }
  };
}
