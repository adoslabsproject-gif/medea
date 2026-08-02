/**
 * Avvio dell'error-handler workflow per il canale 'fanout' dell'outbox.
 *
 * Estrae (zero downgrade) la logica E4/GAP-5(c) che prima viveva fire-and-forget in
 * run.service: triage AI OPT-IN (trigger_error.config.aiTriage==='true', fail-soft) +
 * startAsync del run 'error-handler' col payload contestualizzato. Iniettabile (DI) →
 * il fanout dispatcher lo riceve come `startErrorHandler`, e qui è testabile in isolamento.
 *
 * THROWA se lo startAsync fallisce → il worker dell'outbox ritenta (at-least-once).
 * Il triage è fail-soft: né latenza né errore LLM bloccano l'avvio dell'handler.
 */

import { logger } from '@/lib/logger.js';
import type { FanoutStartParams } from './dispatchers/fanout.dispatcher.js';

interface HandlerWorkflow {
  name?: string | undefined;
  nodes: { defId: string; config: Record<string, unknown> }[];
}

interface TriageResult {
  explanation: string;
  fix: string;
  root_cause?: string | null;
  risk?: string | null;
  confidence?: number | null;
}

export interface ErrorHandlerStarterDeps {
  getWorkflow: (workflowId: string, tenantId: string) => Promise<HandlerWorkflow | null>;
  explainRun: (tenantId: string, runId: string) => Promise<TriageResult>;
  startAsync: (input: {
    workflowId: string;
    tenantId: string;
    triggerType: 'error-handler';
    triggerInput: Record<string, unknown>;
  }) => Promise<void>;
}

function parseTriggerInput(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export function makeErrorHandlerStarter(
  deps: ErrorHandlerStarterDeps,
): (p: FanoutStartParams) => Promise<void> {
  return async (p: FanoutStartParams): Promise<void> => {
    const handler = await deps.getWorkflow(p.errorWorkflowId, p.tenantId);
    const wantsTriage =
      handler?.nodes.some((n) => n.defId === 'trigger_error' && n.config.aiTriage === 'true') ===
      true;

    let aiTriage: Record<string, unknown> | undefined;
    if (wantsTriage) {
      try {
        const t = await deps.explainRun(p.tenantId, p.runId);
        aiTriage = {
          explanation: t.explanation,
          fix: t.fix,
          rootCause: t.root_cause ?? null,
          risk: t.risk ?? null,
          confidence: t.confidence ?? null,
        };
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), runId: p.runId },
          "AI triage failed (fail-soft: l'error-handler parte senza diagnosi)",
        );
      }
    }

    // Nome sorgente best-effort (per un payload leggibile nell'handler).
    let workflowName = p.sourceWorkflowId;
    try {
      const source = await deps.getWorkflow(p.sourceWorkflowId, p.tenantId);
      if (source?.name) workflowName = source.name;
    } catch {
      /* best-effort: l'avvio non dipende dal nome */
    }

    await deps.startAsync({
      workflowId: p.errorWorkflowId,
      tenantId: p.tenantId,
      triggerType: 'error-handler',
      triggerInput: {
        failedNodeId: p.failedNodeId,
        error: p.error,
        runId: p.runId,
        workflowId: p.sourceWorkflowId,
        workflowName,
        triggerInput: parseTriggerInput(p.triggerInputJson),
        attempt: 1,
        ...(aiTriage !== undefined ? { aiTriage } : {}),
      },
    });
  };
}
