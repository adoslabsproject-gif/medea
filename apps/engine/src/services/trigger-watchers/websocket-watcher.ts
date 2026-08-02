/**
 * trigger-watchers/websocket-watcher — trigger_websocket: connessione CLIENT
 * persistente verso un endpoint esterno; ogni messaggio ricevuto fa partire UN
 * run del workflow (split 2026-06-12, estratto dal monolite TriggerWatchersService).
 *
 * Resilienza (invarianti, pinnate dai test):
 *   - backoff esponenziale su drop: 1s→2s→…→cap 30s, RESET a 1s su open riuscita;
 *   - keepalive ping opzionale (pingIntervalSec, 0 = off);
 *   - anti-flood sliding-window 1s (maxMessagesPerSec, 0 = illimitato);
 *   - filtro JSON-pointer: nessun match (`undefined`) → NESSUN run;
 *   - teardown idempotente: closing=true → on('close') NON riconnette mai più.
 *
 * Elevazione vs monolite (no downgrade): dispatcher dei run, factory del socket
 * e clock sono INIETTABILI (`WebSocketWatcherDeps`) — il metodo privato usava
 * `this.runs` e `new WebSocket` inline, quindi backoff/anti-flood/reconnect non
 * erano testabili senza un server reale. Default = produzione reale (`ws`).
 */

import { WebSocket, type RawData } from 'ws';
import { validateUrlForFetch, parseInternalHostAllowlist, isHostAllowlisted } from '@medea/engine-safe-fetch';
import { logger } from '@/lib/logger.js';
import { resolveJsonPointer, clampNumber } from './parsing.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

/** Backoff iniziale dopo un drop di connessione (ms). */
export const WS_BACKOFF_INITIAL_MS = 1_000;
/** Cap del backoff esponenziale di riconnessione (ms). */
export const WS_BACKOFF_CAP_MS = 30_000;

export interface WebSocketWatcherJob {
  workflowId: string;
  /** Live socket (replaced on every reconnect). Null while a reconnect is pending. */
  socket: WatcherSocket | null;
  /** Backoff reconnect handle. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Keepalive ping handle. */
  pingTimer: ReturnType<typeof setInterval> | null;
  /** True once teardown started → on('close') must NOT schedule a reconnect. */
  closing: boolean;
  /** Current exponential backoff delay (ms), grows 1s→2s→…→cap on each failure. */
  backoffMs: number;
  /** Sliding-window anti-flood: timestamps (ms) of runs fired in the last second. */
  recentFires: number[];
}

/** Superficie minima del socket `ws` usata dal watcher — fake-abile nei test. */
export interface WatcherSocket {
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'message', listener: (raw: RawData) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  send(data: string): void;
  ping(): void;
  close(): void;
}

export interface WebSocketWatcherDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Factory del socket. Default: `new WebSocket(url, { headers })` da `ws`. */
  createSocket?: (url: string, headers: Record<string, string> | null) => WatcherSocket;
  /** Clock per l'anti-flood. Default: `Date.now`. */
  now?: () => number;
}

const defaultCreateSocket = (url: string, headers: Record<string, string> | null): WatcherSocket =>
  // ws.WebSocket non è strutturalmente identico a WatcherSocket (overload con
  // parametri extra tipo isBinary/code), ma la superficie che usiamo coincide.
  new WebSocket(url, headers ? { headers } : undefined);

/** Parsa gli header di connessione (oggetto JSON string→string). */
export function parseWsHeaders(workflowId: string, raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    logger.warn({ err, workflowId }, 'trigger_websocket: headersJson invalido — ignorato');
    return null;
  }
}

/**
 * Avvia il watcher per un nodo trigger_websocket. Ritorna il job (handle per il
 * teardown) oppure `null` se la config è invalida (URL mancante/non ws[s]://) —
 * in quel caso NIENTE viene registrato, come nel monolite.
 */
export function startWebSocketWatcher(
  wf: Workflow,
  node: CanvasNode,
  deps: WebSocketWatcherDeps,
): WebSocketWatcherJob | null {
  const url = typeof node.config.url === 'string' ? node.config.url.trim() : '';
  if (!/^wss?:\/\//i.test(url)) {
    logger.warn({ workflowId: wf.id, url }, 'trigger_websocket: URL mancante o non ws://|wss:// — skipped');
    return null;
  }
  // H5 — SSRF: validare lo SCHEMA non basta. Senza check dell'HOST, un ws://169.254.169.254
  // (IMDS), ws://<redis-interno>, o un host cross-tenant su flowforge-net sarebbe raggiunto.
  // `validateUrlForFetch` vuole http(s) (è l'host che conta) → trasformo ws→http, wss→https.
  // Coerenza con i nodi HTTP: un host nell'ALLOWLIST interna dell'operatore
  // (MEDEA_INTERNAL_HOST_ALLOWLIST) può scavalcare il guard (WS verso servizi
  // interni legittimi). Solo gli host NON allowlisted passano per il SSRF guard.
  const httpUrl = url.replace(/^ws/i, 'http');
  let host = '';
  try { host = new URL(httpUrl).hostname; } catch { /* URL malformata → la becca il guard sotto */ }
  const internalAllowlist = parseInternalHostAllowlist(process.env.MEDEA_INTERNAL_HOST_ALLOWLIST);
  if (!(host && isHostAllowlisted(host, internalAllowlist))) {
    const ssrf = validateUrlForFetch(httpUrl);
    if (!ssrf.ok) {
      logger.warn(
        { workflowId: wf.id, url, reason: ssrf.reason },
        'trigger_websocket: host bloccato dalla SSRF guard (IP privato/interno, non in allowlist) — skipped',
      );
      return null;
    }
  }
  const createSocket = deps.createSocket ?? defaultCreateSocket;
  const now = deps.now ?? Date.now;
  const tenantId = wf.tenantId ?? 'default';
  const headers = parseWsHeaders(wf.id, node.config.headersJson);
  const subscribeMessage = typeof node.config.subscribeMessage === 'string' ? node.config.subscribeMessage.trim() : '';
  const jsonParse = node.config.jsonParse !== 'false';
  const pointer = typeof node.config.messagePointer === 'string' ? node.config.messagePointer.trim() : '';
  const reconnect = node.config.reconnect !== 'false';
  const pingIntervalMs = clampNumber(node.config.pingIntervalSec, 0, 86_400, 30) * 1000;
  const maxPerSec = clampNumber(node.config.maxMessagesPerSec, 0, 10_000, 20);

  const job: WebSocketWatcherJob = {
    workflowId: wf.id, socket: null, reconnectTimer: null, pingTimer: null,
    closing: false, backoffMs: WS_BACKOFF_INITIAL_MS, recentFires: [],
  };

  const fireRun = (raw: string): void => {
    // Anti-flood: sliding window 1s.
    if (maxPerSec > 0) {
      const ts = now();
      job.recentFires = job.recentFires.filter((t) => ts - t < 1000);
      if (job.recentFires.length >= maxPerSec) {
        logger.warn({ workflowId: wf.id, maxPerSec }, 'trigger_websocket: anti-flood budget exceeded — message dropped');
        return;
      }
      job.recentFires.push(ts);
    }
    let data: unknown = raw;
    if (jsonParse) { try { data = JSON.parse(raw); } catch { data = raw; } }
    let matched: unknown;
    if (pointer) {
      matched = resolveJsonPointer(data, pointer);
      if (matched === undefined) return; // filtro: nessun match → niente run
    }
    void deps
      .dispatchRun({
        workflowId: wf.id, tenantId, triggerType: 'websocket',
        triggerInput: { data, raw, receivedAt: new Date().toISOString(), ...(pointer ? { matched } : {}) },
      })
      .catch((err: unknown) => { logger.error({ err, workflowId: wf.id }, 'websocket run failed'); });
  };

  const connect = (): void => {
    if (job.closing) return;
    const socket = createSocket(url, headers);
    job.socket = socket;
    socket.on('open', () => {
      job.backoffMs = WS_BACKOFF_INITIAL_MS; // reset backoff su connessione riuscita
      if (subscribeMessage) { try { socket.send(subscribeMessage); } catch (err) { logger.warn({ err, workflowId: wf.id }, 'websocket subscribe send failed'); } }
      if (pingIntervalMs > 0) {
        job.pingTimer = setInterval(() => { try { socket.ping(); } catch { /* socket morente */ } }, pingIntervalMs);
      }
      logger.info({ workflowId: wf.id, url }, 'websocket watcher connected');
    });
    socket.on('message', (raw: RawData) => {
      // RawData = Buffer | ArrayBuffer | Buffer[]: il caso array NON va con
      // .toString() (Array.prototype.toString → join, non utf8). Normalizziamo.
      const buf = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      fireRun(buf.toString('utf8'));
    });
    socket.on('error', (err) => { logger.warn({ err, workflowId: wf.id }, 'websocket error'); });
    socket.on('close', () => {
      if (job.pingTimer) { clearInterval(job.pingTimer); job.pingTimer = null; }
      job.socket = null;
      if (job.closing || !reconnect) return;
      const delay = job.backoffMs;
      job.backoffMs = Math.min(job.backoffMs * 2, WS_BACKOFF_CAP_MS); // backoff esponenziale, cap 30s
      logger.info({ workflowId: wf.id, delayMs: delay }, 'websocket closed — reconnecting with backoff');
      job.reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();
  logger.info({ workflowId: wf.id, url }, 'websocket watcher registered');
  return job;
}

/** Chiusura pulita di un WebSocket watcher: stop reconnect/ping + close socket. */
export function teardownWebSocketWatcher(job: WebSocketWatcherJob): void {
  job.closing = true;
  if (job.reconnectTimer) { clearTimeout(job.reconnectTimer); job.reconnectTimer = null; }
  if (job.pingTimer) { clearInterval(job.pingTimer); job.pingTimer = null; }
  if (job.socket) { try { job.socket.close(); } catch { /* già chiuso */ } job.socket = null; }
}
