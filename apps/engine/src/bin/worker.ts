#!/usr/bin/env node
/**
 * Standalone BullMQ worker for FlowForge queue mode.
 *
 * Run with MEDEA_QUEUE_MODE=redis. The main process enqueues jobs,
 * this binary consumes them and writes results to the shared DB.
 *
 * Usage:
 *   MEDEA_QUEUE_MODE=redis MEDEA_REDIS_URL=redis://… \
 *     node dist/bin/worker.js
 */

import { startWorker, shutdownQueue, isQueueModeEnabled } from '@/services/queue.service.js';
import { RunService } from '@/services/run.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { logger } from '@/lib/logger.js';

function main(): void {
  if (!isQueueModeEnabled()) {
    logger.error('MEDEA_QUEUE_MODE is not "redis". Worker will not start.');
    process.exit(2);
  }

  // Worker uses its own InMemoryEventBus — events stay local to the worker
  // process; if you need cross-process pub/sub, swap for a Redis-backed bus.
  const eventBus = new InMemoryEventBus();
  const runService = new RunService(eventBus);

  const worker = startWorker(async (data) => {
    const input: Parameters<RunService['execute']>[0] = {
      workflowId: data.workflowId,
      tenantId: data.tenantId,
    };
    if (data.triggerType !== undefined) input.triggerType = data.triggerType;
    if (data.triggerInput !== undefined) input.triggerInput = data.triggerInput;
    if (data.triggeredBy !== undefined) input.triggeredBy = data.triggeredBy;
    // runId pre-generato dal produttore: executeWithPins lo riusa (upsert
    // pending → running) invece di crearne uno nuovo.
    if (data.runId !== undefined) input.runId = data.runId;
    return runService.execute(input);
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'Worker received shutdown signal');
    await worker.close();
    await shutdownQueue();
    process.exit(0);
  };
  process.on('SIGINT', (sig) => {
    void shutdown(sig);
  });
  process.on('SIGTERM', (sig) => {
    void shutdown(sig);
  });
}

void main();
