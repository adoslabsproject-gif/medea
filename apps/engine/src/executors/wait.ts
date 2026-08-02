/**
 * Wait executor — three real modes:
 *   - timer:   await N ms (blocking)
 *   - webhook: await an external HTTP callback to POST /webhooks/wait/:token
 *   - either:  race between timer and webhook (whichever fires first)
 *
 * Webhook mode uses a `wait_states` table for persistence + an EVENT-DRIVEN
 * waiter (resume immediato via notifyWaiter, con poll di fallback ogni 5s per
 * il resume cross-processo dopo un restart). The runtime endpoint
 *   POST /webhooks/wait/:token  body=any-json
 * sets completed_at + payload and wakes the waiter, returning the payload to
 * the workflow. Real implementation, no fallback.
 */

import { randomBytes } from 'node:crypto';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { getDatabase } from '@/storage/db.js';

function ensureWaitTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wait_states (
      token TEXT PRIMARY KEY,
      run_id TEXT,
      workflow_id TEXT,
      node_id TEXT,
      expires_at INTEGER NOT NULL,
      completed_at INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wait_states_expires_idx ON wait_states(expires_at);
  `);
}

interface WaitRow {
  token: string;
  completed_at: number | null;
  payload_json: string | null;
}

/**
 * Waiter in-process per token: il webhook `POST /webhooks/wait/:token` è gestito
 * dallo STESSO processo runtime del container tenant → la resume può svegliare il
 * loop IMMEDIATAMENTE via evento, senza busy-poll. Map token→risolutore del wait.
 */
const waiters = new Map<string, () => void>();

/** Sveglia (se presente) il loop in attesa su `token`. Chiamato da {@link resumeWait}. */
function notifyWaiter(token: string): void {
  waiters.get(token)?.();
}

/**
 * Poll EVENT-DRIVEN: attende la notifica in-process del webhook (resume immediato);
 * un poll lento di FALLBACK (5s) copre i casi senza evento (es. resume cross-processo
 * dopo un restart). La riga DB resta SEMPRE la source-of-truth, ri-letta a ogni wake.
 * Prima era un busy-poll a 500ms per attese fino a 7 giorni → spreco DB/CPU a scala.
 */
async function pollForCallback(
  token: string,
  expiresAt: number,
  abortSignal?: AbortSignal,
): Promise<{ payload: unknown; timedOut: boolean }> {
  const { sqlite } = getDatabase();
  const FALLBACK_POLL_MS = 5_000;
  const readRow = (): WaitRow | undefined =>
    sqlite.prepare('SELECT * FROM wait_states WHERE token = ?').get(token) as WaitRow | undefined;
  while (Date.now() < expiresAt) {
    if (abortSignal?.aborted) return { payload: null, timedOut: false };
    const row = readRow();
    if (row?.completed_at) {
      let parsed: unknown = null;
      if (row.payload_json) {
        try {
          parsed = JSON.parse(row.payload_json);
        } catch {
          parsed = row.payload_json;
        }
      }
      return { payload: parsed, timedOut: false };
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      let settled = false;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(token);
        abortSignal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(FALLBACK_POLL_MS, remaining));
      waiters.set(token, wake); // resume del webhook → wake immediato
      abortSignal?.addEventListener('abort', wake, { once: true });
    });
  }
  return { payload: null, timedOut: true };
}

export const waitExecutor: NodeExecutor = async (config, _input, context) => {
  ensureWaitTable();
  const start = Date.now();
  const mode = typeof config.mode === 'string' ? config.mode : 'timer';
  const durationMs = Number(config.durationMs ?? 60_000);
  const maxWaitMs = Number(config.maxWaitMs ?? 3_600_000);

  if (mode === 'timer') {
    const clampedMs = Math.max(0, Math.min(durationMs, 24 * 60 * 60_000));
    // Pre-flight check: se il signal è già abortito quando il wait inizia,
    // evita di dormire anche solo 1ms — throw subito.
    if (context.abortSignal?.aborted) {
      throw new DOMException('Run cancelled before wait started', 'AbortError');
    }
    let aborted = false;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, clampedMs);
      if (context.abortSignal) {
        context.abortSignal.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (aborted) {
      // L'ASTOP del wait NON deve far proseguire l'engine al prossimo nodo.
      // Throw DOMException AbortError → run.service.ts cattura → status='cancelled'.
      // Prima del fix il wait risolveva normalmente e l'engine continuava
      // (es. contact_discovery successivo) → cancel visibile solo dopo
      // diversi nodi → UX "non si ferma".
      throw new DOMException('Run cancelled during wait', 'AbortError');
    }
    return { output: { waitedMs: clampedMs, mode: 'timer' }, durationMs: Date.now() - start };
  }

  // webhook or either modes — register token, poll for callback
  const token = randomBytes(24).toString('base64url');
  const timeoutMs = Math.max(
    1_000,
    Math.min(mode === 'either' ? durationMs : maxWaitMs, 7 * 24 * 60 * 60_000),
  );
  const expiresAt = Date.now() + timeoutMs;

  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      'INSERT INTO wait_states (token, run_id, workflow_id, node_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      token,
      context.runId,
      context.workflowId,
      context.nodeId,
      expiresAt,
      new Date().toISOString(),
    );

  const result = await pollForCallback(token, expiresAt, context.abortSignal);
  sqlite.prepare('DELETE FROM wait_states WHERE token = ?').run(token);

  // Stesso comportamento del ramo timer: se abort è scattato durante il
  // polling, throw → engine si ferma. (pollForCallback ritorna prima del
  // timeout solo se il signal abort, quindi result.timedOut=false &&
  // result.payload=null in quel caso → distinguibile da resume reale che
  // produrrebbe payload != null per signal-based wait.)
  if (context.abortSignal?.aborted) {
    throw new DOMException('Run cancelled during wait', 'AbortError');
  }

  return {
    output: {
      waitedMs: Date.now() - start,
      mode,
      token,
      timedOut: result.timedOut,
      payload: result.payload,
    },
    durationMs: Date.now() - start,
  };
};

/**
 * Resume a pending wait — called by the /webhooks/wait/:token endpoint.
 * Returns true if the token existed and was pending.
 */
export function resumeWait(token: string, payload: unknown): boolean {
  ensureWaitTable();
  const { sqlite } = getDatabase();
  const info = sqlite
    .prepare(
      'UPDATE wait_states SET completed_at = ?, payload_json = ? WHERE token = ? AND completed_at IS NULL',
    )
    .run(Date.now(), JSON.stringify(payload ?? null), token);
  if (info.changes > 0) notifyWaiter(token); // resume immediato del loop in attesa (no busy-poll)
  return info.changes > 0;
}
