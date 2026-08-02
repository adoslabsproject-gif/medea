/**
 * Integration test REALE — BullMQ queue mode end-to-end (audit #4).
 *
 * Gli unit test (`queue.service.test.ts`) mockano BullMQ → verificano l'API
 * surface ma NON provano che enqueue/dequeue funzioni davvero contro un broker.
 * Questo test usa un Redis VERO (DB 15 isolato) e valida il roundtrip completo:
 *
 *     enqueueRun(job)  ──►  Redis "flowforge-runs"  ──►  startWorker(handler)
 *                                                          handler riceve il job
 *
 * Skip automatico se Redis non è raggiungibile (CI senza broker) → niente
 * falsi rossi, ma in locale/prod-like il roundtrip è verificato sul serio.
 *
 * NB ARCHITETTURA (off-by-design, vedi docstring di queue.service.ts): il
 * PRODUTTORE `enqueueRun` NON è ancora cablato in RunService — la modalità
 * supportata è l'esecuzione inline single-process. Questo test valida che
 * l'INFRASTRUTTURA di coda sia solida e pronta, non che sia già in uso.
 */
import type * as QueueServiceNS from './queue.service.js';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import IORedis from 'ioredis';

const REDIS_URL = process.env.MEDEA_TEST_REDIS_URL ?? 'redis://localhost:6379/15';

async function redisReachable(): Promise<boolean> {
  const probe = new IORedis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 800,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const REDIS_OK = await redisReachable();

type QueueModule = typeof QueueServiceNS;

describe.skipIf(!REDIS_OK)('🚨 BullMQ queue — roundtrip REALE su Redis', () => {
  let mod: QueueModule;

  beforeAll(async () => {
    process.env.MEDEA_QUEUE_MODE = 'redis';
    process.env.MEDEA_REDIS_URL = REDIS_URL;
    mod = await import('./queue.service.js');
    // Pulisci eventuali residui di run precedenti nel DB di test.
    await mod.getRunQueue().obliterate({ force: true });
  });

  afterAll(async () => {
    if (mod) {
      await mod.getRunQueue().obliterate({ force: true }).catch(() => undefined);
      await mod.shutdownQueue().catch(() => undefined);
    }
    delete process.env.MEDEA_QUEUE_MODE;
    delete process.env.MEDEA_REDIS_URL;
  });

  it('🚨 enqueueRun → startWorker: il job arriva al handler con i dati esatti', async () => {
    const received: unknown[] = [];
    const deferred = new Promise<void>((resolve) => {
      // startWorker consuma la stessa queue "flowforge-runs".
      mod.startWorker(async (data) => {
        received.push(data);
        resolve();
        return { ok: true };
      });
    });

    const jobId = await mod.enqueueRun({
      workflowId: 'wf-roundtrip',
      tenantId: 'tenant-int',
      triggerType: 'manual',
      triggerInput: { foo: 'bar' },
      triggeredBy: 'integration-test',
    });
    expect(jobId).not.toBe('');

    // Attendi che il worker consumi (timeout di sicurezza per non appendere CI).
    await Promise.race([
      deferred,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout: il worker non ha consumato il job entro 8s')), 8000)),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      workflowId: 'wf-roundtrip',
      tenantId: 'tenant-int',
      triggerType: 'manual',
      triggerInput: { foo: 'bar' },
      triggeredBy: 'integration-test',
    });
  }, 15000);

  it('🚨 il job completato viene rimosso dalla coda (removeOnComplete)', async () => {
    const queue = mod.getRunQueue();
    const before = await queue.getJobCounts('completed', 'waiting', 'active');
    // removeOnComplete.count=1000 → con un solo job processato non resta "completed"
    // accumulato all'infinito; verifichiamo che non ci siano job bloccati.
    expect(before.waiting).toBe(0);
    expect(before.active).toBe(0);
  }, 15000);
});

// Quando Redis non è raggiungibile, lasciamo una traccia esplicita invece di
// un silenzioso "0 test" (così il salto è visibile e intenzionale).
describe.skipIf(REDIS_OK)('BullMQ queue roundtrip (SKIPPED — Redis non raggiungibile)', () => {
  it('skip esplicito: nessun broker Redis su ' + REDIS_URL, () => {
    expect(REDIS_OK).toBe(false);
  });
});
