/**
 * TestEventBus — in-memory single-shot listener used by the "Listen for
 * Test Event" feature of webhook triggers.
 *
 * The editor calls `subscribe(workflowId)` and waits up to N seconds for a
 * real webhook request to arrive. The webhook route calls `publish` when
 * a request comes in AND a listener is active. The promise resolves with
 * the request payload; the listener auto-unsubscribes (single-shot).
 *
 * Why in-memory:
 *   The listener is per-process and short-lived (< 5 min). No need for
 *   Redis / DB. If a worker dies mid-listen the editor just times out
 *   and the user clicks "Listen again". Simpler beats more "scalable".
 *
 * Thread-safety:
 *   Node.js is single-threaded JS. No locks needed. Multiple concurrent
 *   listeners on the SAME workflowId are not supported — the second
 *   subscribe replaces the first.
 */

interface PendingListener {
  workflowId: string;
  tenantId: string;
  resolve: (payload: { headers: Record<string, string>; body: unknown; query: Record<string, string>; method: string; ts: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const listeners = new Map<string, PendingListener>();

function keyOf(tenantId: string, workflowId: string): string {
  return `${tenantId}::${workflowId}`;
}

export function subscribeForTestEvent(
  tenantId: string,
  workflowId: string,
  timeoutMs = 5 * 60_000,
): Promise<{ headers: Record<string, string>; body: unknown; query: Record<string, string>; method: string; ts: string }> {
  const k = keyOf(tenantId, workflowId);

  // Replace any existing listener for this workflow (the user clicked Listen again).
  const prior = listeners.get(k);
  if (prior) {
    clearTimeout(prior.timer);
    prior.reject(new Error('superseded'));
    listeners.delete(k);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(k);
      reject(new Error('timeout'));
    }, timeoutMs);
    listeners.set(k, { workflowId, tenantId, resolve, reject, timer });
  });
}

export function hasTestListener(tenantId: string, workflowId: string): boolean {
  return listeners.has(keyOf(tenantId, workflowId));
}

export function publishTestEvent(
  tenantId: string,
  workflowId: string,
  payload: { headers: Record<string, string>; body: unknown; query: Record<string, string>; method: string },
): boolean {
  const k = keyOf(tenantId, workflowId);
  const listener = listeners.get(k);
  if (!listener) return false;
  clearTimeout(listener.timer);
  listeners.delete(k);
  listener.resolve({ ...payload, ts: new Date().toISOString() });
  return true;
}

/** Operator can cancel a listener early (the editor closed the panel). */
export function cancelTestListener(tenantId: string, workflowId: string): boolean {
  const k = keyOf(tenantId, workflowId);
  const listener = listeners.get(k);
  if (!listener) return false;
  clearTimeout(listener.timer);
  listeners.delete(k);
  listener.reject(new Error('cancelled'));
  return true;
}
