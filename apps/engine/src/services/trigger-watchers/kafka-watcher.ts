/**
 * trigger-watchers/kafka-watcher — trigger_kafka: consumer Apache Kafka
 * persistente (consumer group + offset commit). Ogni messaggio consumato da un
 * topic fa partire UN run del workflow. Sibling ad alto throughput di
 * trigger_rabbitmq (work queue) e trigger_websocket (stream push).
 *
 * Semantica di consegna (invarianti, pinnate dai test):
 *   - AT-LEAST-ONCE: `eachMessage` fa `await dispatchRun`; se il run FALLISCE
 *     l'errore viene PROPAGATO (throw) → kafkajs NON committa l'offset → il
 *     messaggio viene ri-consumato. Se il run riesce, l'offset è committato
 *     (auto-commit kafkajs) → si avanza. È l'equivalente Kafka del manual-ack.
 *   - filtro pointer no-match → COMMIT (consumato e scartato per scelta, non un
 *     errore): niente re-consumo infinito.
 *   - anti-flood: oltre budget → COMMIT + log (in Kafka non esiste il requeue
 *     del singolo messaggio: o si avanza l'offset o si rilegge l'intera
 *     partizione; il messaggio floodato è scartato di proposito).
 *   - reconnect con backoff esponenziale 1s→…→cap 30s su crash del consumer o
 *     fallimento di connect/subscribe; teardown idempotente (closing → mai più).
 *
 * Elevazione (no downgrade): il client Kafka e il clock sono INIETTABILI
 * (`KafkaWatcherDeps.createClient`/`now`) → offset-commit, backoff e anti-flood
 * sono testabili SENZA un broker reale. Default = kafkajs, LAZY (`await import`).
 */

import { logger } from '@/lib/logger.js';
import { resolveJsonPointer, clampNumber } from './parsing.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

export const KAFKA_BACKOFF_INITIAL_MS = 1_000;
export const KAFKA_BACKOFF_CAP_MS = 30_000;

/** Messaggio Kafka — superficie minima usata dal watcher. */
export interface KafkaMessageLike {
  value: Buffer | null;
}

/** Payload di `eachMessage` — superficie minima. */
export interface EachMessagePayload {
  topic: string;
  partition: number;
  message: KafkaMessageLike;
}

/** Consumer Kafka — superficie minima usata dal watcher (fake-abile). */
export interface KafkaConsumerLike {
  connect(): Promise<void>;
  subscribe(opts: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(opts: { eachMessage: (payload: EachMessagePayload) => Promise<void> }): Promise<void>;
  disconnect(): Promise<void>;
  /** kafkajs emette 'consumer.crash' quando il loop muore in modo irrecuperabile. */
  on(event: string, listener: (evt?: unknown) => void): void;
}

/** Client Kafka — superficie minima usata dal watcher. */
export interface KafkaClientLike {
  consumer(opts: { groupId: string }): KafkaConsumerLike;
}

/** Config di costruzione del client (brokers + TLS + SASL opzionale). */
export interface KafkaClientConfig {
  brokers: string[];
  ssl: boolean;
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
}

export type KafkaClientFactory = (config: KafkaClientConfig) => KafkaClientLike;

export interface KafkaWatcherDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Factory del client. Default: `new Kafka(...)` da kafkajs (lazy import). */
  createClient?: KafkaClientFactory;
  /** Clock per l'anti-flood. Default: `Date.now`. */
  now?: () => number;
}

export interface KafkaWatcherJob {
  workflowId: string;
  consumer: KafkaConsumerLike | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  backoffMs: number;
  recentFires: number[];
}

/** Errore usato per NON committare l'offset (re-consumo) quando il run fallisce. */
class KafkaRunFailedError extends Error {
  constructor(cause: unknown) {
    super(`kafka run failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'KafkaRunFailedError';
  }
}

/**
 * Risolve la factory reale kafkajs con import LAZY (kafkajs pesa solo su chi usa
 * il trigger). L'import è async e la factory è sincrona: ritorna una factory che
 * chiude sul modulo già caricato, invocata dentro connect().
 */
async function resolveDefaultFactory(): Promise<KafkaClientFactory> {
  const { Kafka, logLevel } = await import('kafkajs');
  return (config) => {
    // `exactOptionalPropertyTypes`: la property `sasl` non accetta `undefined`,
    // quindi la si include SOLO quando presente (spread condizionale) e si
    // costruisce l'oggetto tipizzato sull'atteso dal costruttore kafkajs.
    const kafkaConfig = {
      brokers: config.brokers,
      ssl: config.ssl,
      logLevel: logLevel.NOTHING, // il logging passa dal nostro canale, non da kafkajs
      ...(config.sasl ? { sasl: config.sasl } : {}),
    };
    // Bridge verso la lib esterna: kafkajs KafkaConfig con exactOptionalPropertyTypes
    // rifiuta la forma inferita; il doppio-cast via unknown è mirato e documentato.
    return new Kafka(kafkaConfig as unknown as ConstructorParameters<typeof Kafka>[0]);
  };
}

function parseBrokers(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSasl(node: CanvasNode): KafkaClientConfig['sasl'] | undefined {
  const mechanism = typeof node.config.saslMechanism === 'string' ? node.config.saslMechanism : '';
  const username = typeof node.config.saslUsername === 'string' ? node.config.saslUsername : '';
  const password = typeof node.config.saslPassword === 'string' ? node.config.saslPassword : '';
  if (!mechanism || mechanism === 'none' || !username) return undefined;
  if (mechanism !== 'plain' && mechanism !== 'scram-sha-256' && mechanism !== 'scram-sha-512')
    return undefined;
  return { mechanism, username, password };
}

export function startKafkaWatcher(
  wf: Workflow,
  node: CanvasNode,
  deps: KafkaWatcherDeps,
): KafkaWatcherJob | null {
  const brokers = parseBrokers(node.config.brokers);
  if (brokers.length === 0) {
    logger.warn({ workflowId: wf.id }, 'trigger_kafka: nessun broker (brokers) — skipped');
    return null;
  }
  const topic = typeof node.config.topic === 'string' ? node.config.topic.trim() : '';
  if (!topic) {
    logger.warn({ workflowId: wf.id }, 'trigger_kafka: topic mancante — skipped');
    return null;
  }
  const groupId =
    typeof node.config.groupId === 'string' && node.config.groupId.trim() !== ''
      ? node.config.groupId.trim()
      : `flowforge-${wf.id}`;

  const now = deps.now ?? Date.now;
  const tenantId = wf.tenantId ?? 'default';
  // I config booleani arrivano come stringhe 'true'/'false' dal round-trip JSON
  // (coerente con gli altri watcher, es. websocket `jsonParse !== 'false'`).
  const ssl = node.config.ssl === 'true';
  const fromBeginning = node.config.fromBeginning === 'true';
  const sasl = parseSasl(node);
  const jsonParse = node.config.jsonParse !== 'false';
  const pointer =
    typeof node.config.messagePointer === 'string' ? node.config.messagePointer.trim() : '';
  const maxPerSec = clampNumber(node.config.maxMessagesPerSec, 0, 100_000, 0);
  const reconnect = node.config.reconnect !== 'false';

  const job: KafkaWatcherJob = {
    workflowId: wf.id,
    consumer: null,
    reconnectTimer: null,
    closing: false,
    backoffMs: KAFKA_BACKOFF_INITIAL_MS,
    recentFires: [],
  };

  /** Anti-flood sliding-window: true = SCARTA (budget superato). */
  const floodBlocked = (): boolean => {
    if (maxPerSec <= 0) return false;
    const ts = now();
    job.recentFires = job.recentFires.filter((t) => ts - t < 1000);
    if (job.recentFires.length >= maxPerSec) {
      logger.warn(
        { workflowId: wf.id, maxPerSec },
        'trigger_kafka: anti-flood budget exceeded — message dropped (offset committed)',
      );
      return true;
    }
    job.recentFires.push(ts);
    return false;
  };

  const scheduleReconnect = (): void => {
    if (job.closing || !reconnect) return;
    if (job.reconnectTimer) return;
    const delay = job.backoffMs;
    job.backoffMs = Math.min(job.backoffMs * 2, KAFKA_BACKOFF_CAP_MS);
    logger.info(
      { workflowId: wf.id, delayMs: delay },
      'trigger_kafka: consumer perso — reconnect con backoff',
    );
    job.reconnectTimer = setTimeout(() => {
      job.reconnectTimer = null;
      void connect();
    }, delay);
  };

  /**
   * eachMessage: at-least-once. Ritorna normalmente = COMMIT (avanza offset);
   * throw = NON committa = re-consumo. Il filtro no-match e l'anti-flood
   * committano (return); solo un run FALLITO propaga per ri-consumare.
   */
  const eachMessage = async (payload: EachMessagePayload): Promise<void> => {
    const value = payload.message.value;
    if (value === null) return; // tombstone/null → committa e avanza
    if (floodBlocked()) return; // budget superato → committa (vedi doc semantica)
    const raw = value.toString('utf8');
    let data: unknown = raw;
    if (jsonParse) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    let matched: unknown;
    if (pointer) {
      matched = resolveJsonPointer(data, pointer);
      if (matched === undefined) return; // no-match → committa e avanza
    }
    try {
      await deps.dispatchRun({
        workflowId: wf.id,
        tenantId,
        triggerType: 'kafka',
        triggerInput: {
          data,
          raw,
          receivedAt: new Date().toISOString(),
          topic: payload.topic,
          partition: payload.partition,
          ...(matched !== undefined ? { matched } : {}),
        },
      });
    } catch (err) {
      // Propaga per NON committare l'offset → kafkajs ri-consuma (at-least-once).
      logger.error(
        { err, workflowId: wf.id, topic },
        'kafka run failed → offset NON committato (re-consumo)',
      );
      throw new KafkaRunFailedError(err);
    }
  };

  const connect = async (): Promise<void> => {
    if (job.closing) return;
    try {
      const factory = deps.createClient ?? (await resolveDefaultFactory());
      const client = factory({ brokers, ssl, ...(sasl ? { sasl } : {}) });
      const consumer = client.consumer({ groupId });
      if (job.closing) {
        try {
          await consumer.disconnect();
        } catch {
          /* teardown */
        }
        return;
      }
      job.consumer = consumer;
      consumer.on('consumer.crash', () => {
        logger.warn({ workflowId: wf.id, topic }, 'kafka consumer crash');
        job.consumer = null;
        scheduleReconnect();
      });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning });
      await consumer.run({ eachMessage });
      job.backoffMs = KAFKA_BACKOFF_INITIAL_MS; // reset backoff su run avviato
      logger.info({ workflowId: wf.id, topic, groupId }, 'kafka watcher connected');
    } catch (err) {
      logger.warn(
        { err, workflowId: wf.id, topic },
        'kafka connect failed — reconnect con backoff',
      );
      job.consumer = null;
      scheduleReconnect();
    }
  };

  void connect();
  logger.info({ workflowId: wf.id, topic, groupId }, 'kafka watcher registered');
  return job;
}

/** Chiusura pulita: stop reconnect + disconnect consumer (idempotente). */
export function teardownKafkaWatcher(job: KafkaWatcherJob): void {
  job.closing = true;
  if (job.reconnectTimer) {
    clearTimeout(job.reconnectTimer);
    job.reconnectTimer = null;
  }
  const consumer = job.consumer;
  job.consumer = null;
  if (consumer) {
    void Promise.resolve(consumer.disconnect()).catch(() => undefined);
  }
}
