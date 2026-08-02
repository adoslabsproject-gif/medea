/**
 * Test 2026-grade — Queue service (BullMQ + Redis distributed mode).
 *
 * MODE TOGGLE: MEDEA_QUEUE_MODE='redis' attiva BullMQ; default inline.
 * RETRY: jobs attempts=1 (no auto-retry; engine gestisce retry interno).
 * RETENTION: completed 1000 / 24h, failed 5000 / 7g.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { at, assertDefined } from '@/__testkit__/assert.js';

const addMock = vi.fn();
const closeMock = vi.fn();
class QueueMock {
  add = addMock;
  close = closeMock;
  constructor(public name: string, public opts: unknown) {}
}

const workerEventListeners: Record<string, (...a: unknown[]) => unknown> = {};
class WorkerMock {
  constructor(public name: string, public handler: any, public opts: any) {}
  on(event: string, fn: (...a: unknown[]) => unknown) { workerEventListeners[event] = fn; return this; }
}

vi.mock('bullmq', () => ({
  Queue: QueueMock,
  Worker: WorkerMock,
}));

const quitMock = vi.fn();
const ioRedisInstance = {
  on: vi.fn(),
  quit: quitMock,
};
// _url/_opts tipizzati: new IORedis(url, opts) → mock.calls riflette gli arg reali.
const IORedisCtorMock = vi.fn((_url: string, _opts: unknown) => ioRedisInstance);
vi.mock('ioredis', () => ({
  default: IORedisCtorMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.MEDEA_QUEUE_MODE;
  delete process.env.MEDEA_REDIS_URL;
  delete process.env.MEDEA_QUEUE_CONCURRENCY;
});

async function loadFresh() {
  return import('./queue.service.js');
}

describe('🚨 isQueueModeEnabled', () => {
  it('🚨 env=redis → true', async () => {
    process.env.MEDEA_QUEUE_MODE = 'redis';
    const m = await loadFresh();
    expect(m.isQueueModeEnabled()).toBe(true);
  });

  it('🚨 env=REDIS (case-insensitive) → true', async () => {
    process.env.MEDEA_QUEUE_MODE = 'REDIS';
    const m = await loadFresh();
    expect(m.isQueueModeEnabled()).toBe(true);
  });

  it('🚨 env undefined → false (default inline)', async () => {
    const m = await loadFresh();
    expect(m.isQueueModeEnabled()).toBe(false);
  });

  it('🚨 env="memory" → false', async () => {
    process.env.MEDEA_QUEUE_MODE = 'memory';
    const m = await loadFresh();
    expect(m.isQueueModeEnabled()).toBe(false);
  });
});

describe('🚨 getQueueConnection', () => {
  it('🚨 default URL → localhost:6379', async () => {
    const m = await loadFresh();
    m.getQueueConnection();
    expect(IORedisCtorMock).toHaveBeenCalledWith('redis://localhost:6379', expect.any(Object));
  });

  it('🚨 env URL override', async () => {
    process.env.MEDEA_REDIS_URL = 'redis://my-redis:6380/2';
    const m = await loadFresh();
    m.getQueueConnection();
    expect(IORedisCtorMock).toHaveBeenCalledWith('redis://my-redis:6380/2', expect.any(Object));
  });

  it('🚨 maxRetriesPerRequest null (long-poll BullMQ pattern)', async () => {
    const m = await loadFresh();
    m.getQueueConnection();
    const opts = at(IORedisCtorMock.mock.calls, 0, 'ioredis-calls')[1] as { maxRetriesPerRequest: number | null };
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('🚨 connection cached (2x call → 1 IORedis ctor)', async () => {
    const m = await loadFresh();
    m.getQueueConnection();
    m.getQueueConnection();
    expect(IORedisCtorMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 error listener installato', async () => {
    const m = await loadFresh();
    m.getQueueConnection();
    expect(ioRedisInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});

describe('🚨 getRunQueue', () => {
  it('🚨 nome queue stabile "flowforge-runs" (NO ":" — vietato da BullMQ)', async () => {
    const m = await loadFresh();
    const q = m.getRunQueue();
    expect((q as any).name).toBe('flowforge-runs');
    // Regressione: BullMQ rifiuta i ":" nel nome → il nome non deve mai contenerli.
    expect((q as any).name).not.toContain(':');
  });

  it('🚨 queue cached', async () => {
    const m = await loadFresh();
    const q1 = m.getRunQueue();
    const q2 = m.getRunQueue();
    expect(q1).toBe(q2);
  });
});

describe('🚨 enqueueRun — job options', () => {
  it('🚨 happy: add con removeOnComplete + removeOnFail + attempts=1', async () => {
    addMock.mockResolvedValueOnce({ id: 'job-xyz' });
    const m = await loadFresh();
    const id = await m.enqueueRun({
      workflowId: 'wf-1', tenantId: 't-1', triggerType: 'manual',
    });
    expect(id).toBe('job-xyz');
    const [name, data, opts] = at(addMock.mock.calls, 0, 'add-calls');
    expect(name).toBe('run');
    expect(data.workflowId).toBe('wf-1');
    expect(opts.attempts).toBe(1);
    expect(opts.removeOnComplete.count).toBe(1000);
    expect(opts.removeOnComplete.age).toBe(86400);
    expect(opts.removeOnFail.count).toBe(5000);
    expect(opts.removeOnFail.age).toBe(604800);
  });

  it('🚨 jobId undefined → return "" empty string', async () => {
    addMock.mockResolvedValueOnce({ id: undefined });
    const m = await loadFresh();
    expect(await m.enqueueRun({ workflowId: 'wf', tenantId: 't' })).toBe('');
  });
});

describe('🚨 startWorker', () => {
  it('🚨 default concurrency 5', async () => {
    const m = await loadFresh();
    const w = m.startWorker(async () => undefined);
    expect((w as any).opts.concurrency).toBe(5);
  });

  it('🚨 env override concurrency', async () => {
    process.env.MEDEA_QUEUE_CONCURRENCY = '20';
    const m = await loadFresh();
    const w = m.startWorker(async () => undefined);
    expect((w as any).opts.concurrency).toBe(20);
  });

  it('🚨 handler invocato con job.data', async () => {
    let captured: any = null;
    const m = await loadFresh();
    const w = m.startWorker(async (data) => { captured = data; return 'ok'; });
    const r = await (w as any).handler({ data: { workflowId: 'wf-X', tenantId: 't' } });
    expect(captured.workflowId).toBe('wf-X');
    expect(r).toBe('ok');
  });

  it('🚨 log info su completed event', async () => {
    const m = await loadFresh();
    m.startWorker(async () => undefined);
    const completed = workerEventListeners.completed;
    assertDefined(completed, 'completed listener');
    completed({ id: 'j-1', data: { workflowId: 'wf-c' } });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j-1', workflowId: 'wf-c' }),
      'Queue job completed',
    );
  });

  it('🚨 log error su failed event', async () => {
    const m = await loadFresh();
    m.startWorker(async () => undefined);
    const failed = workerEventListeners.failed;
    assertDefined(failed, 'failed listener');
    failed({ id: 'j-fail', data: { workflowId: 'wf-f' } }, new Error('boom'));
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j-fail', err: expect.any(Error) }),
      'Queue job failed',
    );
  });

  it('🚨 log started con concurrency + queue name', async () => {
    const m = await loadFresh();
    m.startWorker(async () => undefined);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 5, queue: 'flowforge-runs' }),
      'BullMQ worker started',
    );
  });
});

describe('🚨 shutdownQueue', () => {
  it('🚨 close queue + quit connection se entrambi attivi', async () => {
    closeMock.mockResolvedValue(undefined);
    quitMock.mockResolvedValue(undefined);
    const m = await loadFresh();
    m.getRunQueue();
    m.getQueueConnection();
    await m.shutdownQueue();
    expect(closeMock).toHaveBeenCalled();
    expect(quitMock).toHaveBeenCalled();
  });

  it('🚨 no queue + no conn → no-op safe', async () => {
    const m = await loadFresh();
    await expect(m.shutdownQueue()).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();
  });
});
