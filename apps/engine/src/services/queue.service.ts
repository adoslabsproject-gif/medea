/**
 * BullMQ-backed queue mode for distributed execution.
 *
 * Activated by env MEDEA_QUEUE_MODE=redis. When inactive, the
 * RunService executes inline (default single-process mode).
 *
 * Architecture (WIRED end-to-end):
 *   - Main process: `RunService.startAsync` rileva la queue mode, inserisce una
 *     row `pending` e chiama `enqueueRun` → job sulla queue "flowforge-runs".
 *   - Worker process (`bin/worker.ts` o `flowforge worker`): consuma la queue,
 *     propaga `runId` e chiama `RunService.execute()` che esegue il workflow e
 *     persiste la row (`pending → running → success/error`).
 *
 * I caller SINCRONI (webhook proxy, invoke, mcp, client-portal, forms, replay)
 * restano inline per design: hanno bisogno del risultato finale nello stesso
 * scope HTTP. La queue mode riguarda il path async `POST /workflows/:id/run`.
 *
 * Both processes share the same SQLite DB (or Postgres if configured).
 * Concurrency = env MEDEA_QUEUE_CONCURRENCY (default 5).
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '@/lib/logger.js';

// NB: il nome NON può contenere ':' — BullMQ lo usa come separatore di chiave
// Redis e rifiuta `new Queue('a:b')` con "Queue name cannot contain :". Il
// vecchio nome 'flowforge:runs' faceva throw a `getRunQueue()`, rendendo la
// queue mode di fatto ineseguibile (bug scoperto dall'integration test reale).
const QUEUE_NAME = 'flowforge-runs';

export interface RunJobData {
  workflowId: string;
  tenantId: string;
  triggerType?: string;
  triggerInput?: unknown;
  triggeredBy?: string;
  /**
   * runId pre-generato dal produttore (`RunService.startAsync` in queue mode).
   * Il main process inserisce SUBITO una row `pending` con questo id (così
   * `GET /runs/:id` è pollabile prima che il worker prenda il job) e lo passa
   * qui; il worker lo propaga a `execute()` → `executeWithPins` fa la
   * transizione `pending → running` (upsert) sullo stesso id. Garantisce anche
   * idempotenza: un retry del job riusa lo stesso runId, niente run duplicati.
   */
  runId?: string;
}

// Use BullMQ types loosely — exactOptionalPropertyTypes vs BullMQ generics
// is friction not worth solving with a wrapper; the API surface here is small.
let connection: IORedis | null = null;
let queue: Queue | null = null;

export function isQueueModeEnabled(): boolean {
  return (process.env.MEDEA_QUEUE_MODE ?? '').toLowerCase() === 'redis';
}

export function getQueueConnection(): IORedis {
  if (connection) return connection;
  const url = process.env.MEDEA_REDIS_URL ?? 'redis://localhost:6379';
  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
  });
  connection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });
  return connection;
}

export function getRunQueue(): Queue {
  if (queue) return queue;
  // BullMQ ConnectionOptions accetta sia RedisOptions sia un IORedis instance.
  // Il cast era originariamente `as any` per evitare friction tra il brand
  // type di IORedis re-esportato da bullmq vs quello importato da ioredis;
  // ConnectionOptions è il supertype corretto e mantiene type-safety.
  queue = new Queue(QUEUE_NAME, { connection: getQueueConnection() as ConnectionOptions });
  return queue;
}

export async function enqueueRun(data: RunJobData): Promise<string> {
  const q = getRunQueue();
  const job = await q.add('run', data, {
    removeOnComplete: { count: 1000, age: 60 * 60 * 24 },
    removeOnFail: { count: 5000, age: 60 * 60 * 24 * 7 },
    attempts: 1,
  });
  return job.id ?? '';
}

export function startWorker(handler: (data: RunJobData) => Promise<unknown>): Worker {
  const concurrency = Number(process.env.MEDEA_QUEUE_CONCURRENCY ?? '5');
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return handler(job.data as RunJobData);
    },
    { connection: getQueueConnection() as ConnectionOptions, concurrency },
  );
  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, workflowId: (job.data as { workflowId?: string }).workflowId },
      'Queue job completed',
    );
  });
  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        workflowId: (job?.data as { workflowId?: string } | undefined)?.workflowId,
        err,
      },
      'Queue job failed',
    );
  });
  logger.info({ concurrency, queue: QUEUE_NAME }, 'BullMQ worker started');
  return worker;
}

export async function shutdownQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
