/**
 * Bootstrap dell'outbox errori per il runtime tenant: compone i dispatcher con i
 * servizi reali, costruisce l'error-handler-starter (AI-triage + startAsync) e avvia
 * lo scheduler (sweep + GC). Chiamato UNA volta dall'entrypoint del server (main.ts /
 * bin/flowforge.ts) dopo la migration.
 *
 * Le notifiche d'errore sono enqueued ATOMICAMENTE col mark-errored in run.service;
 * questo scheduler le consuma in modo DUREVOLE (at-least-once, retry, dead-letter).
 */

import { getDatabase } from '@/storage/db.js';
import { WorkflowService } from '../workflow.service.js';
import { AiExplainService } from '../ai-explain.service.js';
import { getTenantErrorWorkflowId } from '../error-workflow-flag.service.js';
import type { RunService } from '../run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { checkErrorFanoutRateLimit } from './fanout-rate-limit.js';
import { makeErrorHandlerStarter } from './error-handler-starter.js';
import { buildOutboxDispatchers } from './wiring.js';
import { startOutboxScheduler, type OutboxSchedulerHandle } from './scheduler.js';

export function startErrorOutbox(deps: { eventBus: IEventBus; runService: RunService }): OutboxSchedulerHandle {
  const workflows = new WorkflowService(deps.eventBus);

  const startErrorHandler = makeErrorHandlerStarter({
    getWorkflow: (id, tenantId) => workflows.get(id, tenantId),
    explainRun: (tenantId, runId) => new AiExplainService().explain({ tenantId, runId }),
    startAsync: async (input) => { await deps.runService.startAsync(input); },
  });

  const dispatchers = buildOutboxDispatchers({
    getWorkflow: (id, tenantId) => workflows.get(id, tenantId),
    getErrorWorkflowId: (id, tenantId) => workflows.getErrorWorkflowId(id, tenantId),
    getTenantErrorWorkflowId,
    checkRateLimit: checkErrorFanoutRateLimit,
    startErrorHandler,
  });

  const { sqlite } = getDatabase();
  return startOutboxScheduler({ sqlite, dispatchers });
}
