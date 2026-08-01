/**
 * trigger-watchers/rabbitmq-watcher — trigger_rabbitmq: consumer AMQP 0-9-1
 * persistente; ogni messaggio consumato da una coda fa partire UN run del
 * workflow. Sibling "message-queue" di trigger_websocket (stream push) e
 * trigger_kafka (log distribuito).
 *
 * Semantica di consegna (invarianti, pinnate dai test):
 *   - ackMode 'manual' (default, AT-LEAST-ONCE): il messaggio è ACK-ato SOLO
 *     dopo che il run è partito con successo; se il dispatch fallisce → NACK con
 *     requeue → il broker lo riconsegna. Nessun messaggio perso su crash del run.
 *   - ackMode 'auto' (AT-MOST-ONCE): noAck, il broker considera consegnato
 *     all'invio. Più veloce ma un run fallito perde il messaggio.
 *   - prefetch: quanti messaggi non-ACK-ati in volo (backpressure). Con manual
 *     ack è il vero limitatore di carico.
 *   - reconnect con backoff esponenziale 1s→…→cap 30s su close/error, reset su
 *     consume avviato; teardown idempotente (closing=true → mai più riconnessione).
 *
 * Elevazione (no downgrade, come websocket-watcher): la connessione AMQP e il
 * clock sono INIETTABILI (`RabbitWatcherDeps.connect`/`now`) → backoff, ack/nack
 * e anti-flood sono testabili SENZA un broker reale. Default = amqplib reale,
 * caricato LAZY (`await import('amqplib')`) così il modulo non pesa sui tenant
 * che non usano questo trigger.
 */

import { validateUrlForFetch, parseInternalHostAllowlist, isHostAllowlisted } from '@flowforge/safe-fetch';
import { logger } from '@/lib/logger.js';
import { resolveJsonPointer, clampNumber } from './parsing.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@flowforge/core-schema';

export const RABBIT_BACKOFF_INITIAL_MS = 1_000;
export const RABBIT_BACKOFF_CAP_MS = 30_000;

/** Messaggio AMQP — superficie minima usata dal watcher (fake-abile). */
export interface AmqpMessage {
  content: Buffer;
}

/** Canale AMQP — superficie minima usata dal watcher. */
export interface AmqpChannel {
  assertQueue(queue: string, opts: { durable: boolean }): Promise<unknown>;
  prefetch(count: number): Promise<unknown> | void;
  consume(
    queue: string,
    onMessage: (msg: AmqpMessage | null) => void,
    opts: { noAck: boolean },
  ): Promise<{ consumerTag: string }>;
  ack(msg: AmqpMessage): void;
  nack(msg: AmqpMessage, allUpTo: boolean, requeue: boolean): void;
  close(): Promise<void>;
  on(event: 'error' | 'close', listener: (err?: Error) => void): unknown;
}

/** Connessione AMQP — superficie minima usata dal watcher. */
export interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
  on(event: 'error' | 'close', listener: (err?: Error) => void): unknown;
}

export type AmqpConnect = (url: string) => Promise<AmqpConnection>;

export interface RabbitWatcherDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Factory della connessione. Default: `amqplib.connect` (lazy import). */
  connect?: AmqpConnect;
  /** Clock per l'anti-flood. Default: `Date.now`. */
  now?: () => number;
}

export interface RabbitWatcherJob {
  workflowId: string;
  connection: AmqpConnection | null;
  channel: AmqpChannel | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** True una volta iniziato il teardown → i listener close/error NON riconnettono. */
  closing: boolean;
  backoffMs: number;
  /** Sliding-window anti-flood: timestamp (ms) dei run avviati nell'ultimo secondo. */
  recentFires: number[];
}

/** Factory di default: import LAZY di amqplib, così pesa solo su chi usa il trigger. */
const defaultConnect: AmqpConnect = async (url) => {
  const amqp = await import('amqplib');
  // amqplib.connect ritorna una ChannelModel il cui .connection emette gli eventi;
  // la superficie (createChannel/close/on) coincide con AmqpConnection.
  return await amqp.connect(url);
};

/**
 * Valida lo schema + l'HOST del broker contro la SSRF guard (come websocket):
 * amqp(s):// → http(s):// per il check dell'host. Un host nell'allowlist interna
 * dell'operatore scavalca il guard (broker interni legittimi su flowforge-net).
 */
function amqpHostAllowed(wfId: string, url: string): boolean {
  const httpUrl = url.replace(/^amqps:\/\//i, 'https://').replace(/^amqp:\/\//i, 'http://');
  let host = '';
  try { host = new URL(httpUrl).hostname; } catch { /* malformata → la becca il guard */ }
  const allowlist = parseInternalHostAllowlist(process.env.FLOWFORGE_INTERNAL_HOST_ALLOWLIST);
  if (host && isHostAllowlisted(host, allowlist)) return true;
  const ssrf = validateUrlForFetch(httpUrl);
  if (!ssrf.ok) {
    logger.warn({ workflowId: wfId, reason: ssrf.reason }, 'trigger_rabbitmq: host broker bloccato dalla SSRF guard — skipped');
    return false;
  }
  return true;
}

export function startRabbitWatcher(
  wf: Workflow,
  node: CanvasNode,
  deps: RabbitWatcherDeps,
): RabbitWatcherJob | null {
  const url = typeof node.config.url === 'string' ? node.config.url.trim() : '';
  if (!/^amqps?:\/\//i.test(url)) {
    logger.warn({ workflowId: wf.id }, 'trigger_rabbitmq: URL mancante o non amqp://|amqps:// — skipped');
    return null;
  }
  const queue = typeof node.config.queue === 'string' ? node.config.queue.trim() : '';
  if (!queue) {
    logger.warn({ workflowId: wf.id }, 'trigger_rabbitmq: coda (queue) mancante — skipped');
    return null;
  }
  if (!amqpHostAllowed(wf.id, url)) return null;

  const connectFn = deps.connect ?? defaultConnect;
  const now = deps.now ?? Date.now;
  const tenantId = wf.tenantId ?? 'default';
  const jsonParse = node.config.jsonParse !== 'false';
  const pointer = typeof node.config.messagePointer === 'string' ? node.config.messagePointer.trim() : '';
  const manualAck = node.config.ackMode !== 'auto'; // default: manual (at-least-once)
  const durable = node.config.durable !== 'false';
  const prefetch = clampNumber(node.config.prefetch, 1, 10_000, 10);
  const maxPerSec = clampNumber(node.config.maxMessagesPerSec, 0, 10_000, 0);
  const reconnect = node.config.reconnect !== 'false';

  const job: RabbitWatcherJob = {
    workflowId: wf.id, connection: null, channel: null,
    reconnectTimer: null, closing: false, backoffMs: RABBIT_BACKOFF_INITIAL_MS, recentFires: [],
  };

  /** Anti-flood sliding-window: true = SCARTA (budget superato). */
  const floodBlocked = (): boolean => {
    if (maxPerSec <= 0) return false;
    const ts = now();
    job.recentFires = job.recentFires.filter((t) => ts - t < 1000);
    if (job.recentFires.length >= maxPerSec) {
      logger.warn({ workflowId: wf.id, maxPerSec }, 'trigger_rabbitmq: anti-flood budget exceeded — message dropped');
      return true;
    }
    job.recentFires.push(ts);
    return false;
  };

  const scheduleReconnect = (): void => {
    if (job.closing || !reconnect) return;
    if (job.reconnectTimer) return; // già schedulato
    const delay = job.backoffMs;
    job.backoffMs = Math.min(job.backoffMs * 2, RABBIT_BACKOFF_CAP_MS);
    logger.info({ workflowId: wf.id, delayMs: delay }, 'trigger_rabbitmq: connessione persa — reconnect con backoff');
    job.reconnectTimer = setTimeout(() => { job.reconnectTimer = null; void connect(); }, delay);
  };

  const handleMessage = (ch: AmqpChannel, msg: AmqpMessage | null): void => {
    if (msg === null) return; // consumer cancellato dal broker
    if (floodBlocked()) { if (manualAck) ch.nack(msg, false, true); return; }
    const raw = msg.content.toString('utf8');
    let data: unknown = raw;
    if (jsonParse) { try { data = JSON.parse(raw); } catch { data = raw; } }
    if (pointer) {
      const matched = resolveJsonPointer(data, pointer);
      // Filtro: nessun match → il messaggio NON è per noi. In manual-ack lo ACK-iamo
      // comunque (l'abbiamo consumato e scartato per scelta, non è un errore) per
      // non ri-consegnarlo all'infinito.
      if (matched === undefined) { if (manualAck) ch.ack(msg); return; }
      dispatch(ch, msg, data, raw, matched);
      return;
    }
    dispatch(ch, msg, data, raw, undefined);
  };

  const dispatch = (ch: AmqpChannel, msg: AmqpMessage, data: unknown, raw: string, matched: unknown): void => {
    const run = deps.dispatchRun({
      workflowId: wf.id, tenantId, triggerType: 'rabbitmq',
      triggerInput: { data, raw, receivedAt: new Date().toISOString(), ...(matched !== undefined ? { matched } : {}) },
    });
    if (!manualAck) {
      // auto-ack: il broker ha già "consegnato"; logghiamo solo un eventuale errore.
      run.catch((err: unknown) => { logger.error({ err, workflowId: wf.id }, 'rabbitmq run failed (auto-ack)'); });
      return;
    }
    // manual-ack AT-LEAST-ONCE: ack SOLO su run riuscito, nack+requeue su fallimento.
    run.then(
      () => { try { ch.ack(msg); } catch (err) { logger.warn({ err, workflowId: wf.id }, 'rabbitmq ack failed'); } },
      (err: unknown) => {
        logger.error({ err, workflowId: wf.id }, 'rabbitmq run failed → nack+requeue');
        try { ch.nack(msg, false, true); } catch (e) { logger.warn({ err: e, workflowId: wf.id }, 'rabbitmq nack failed'); }
      },
    );
  };

  const connect = async (): Promise<void> => {
    if (job.closing) return;
    try {
      const conn = await connectFn(url);
      if (job.closing) { try { await conn.close(); } catch { /* teardown in corso */ } return; }
      job.connection = conn;
      conn.on('error', (err) => { logger.warn({ err, workflowId: wf.id }, 'rabbitmq connection error'); });
      conn.on('close', () => { job.connection = null; job.channel = null; scheduleReconnect(); });

      const ch = await conn.createChannel();
      job.channel = ch;
      ch.on('error', (err) => { logger.warn({ err, workflowId: wf.id }, 'rabbitmq channel error'); });
      await ch.prefetch(prefetch);
      await ch.assertQueue(queue, { durable });
      await ch.consume(queue, (msg) => { handleMessage(ch, msg); }, { noAck: !manualAck });

      job.backoffMs = RABBIT_BACKOFF_INITIAL_MS; // reset backoff su consume avviato
      logger.info({ workflowId: wf.id, queue, manualAck, prefetch }, 'rabbitmq watcher connected');
    } catch (err) {
      logger.warn({ err, workflowId: wf.id, queue }, 'rabbitmq connect failed — reconnect con backoff');
      job.connection = null;
      job.channel = null;
      scheduleReconnect();
    }
  };

  void connect();
  logger.info({ workflowId: wf.id, queue }, 'rabbitmq watcher registered');
  return job;
}

/** Chiusura pulita: stop reconnect + close channel/connection (idempotente). */
export function teardownRabbitWatcher(job: RabbitWatcherJob): void {
  job.closing = true;
  if (job.reconnectTimer) { clearTimeout(job.reconnectTimer); job.reconnectTimer = null; }
  const ch = job.channel;
  const conn = job.connection;
  job.channel = null;
  job.connection = null;
  if (ch) { void Promise.resolve(ch.close()).catch(() => undefined); }
  if (conn) { void Promise.resolve(conn.close()).catch(() => undefined); }
}
