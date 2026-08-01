/**
 * persistScaffoldCall — helper isolato per persistere la singola LLM call
 * del wizard scaffold in `ai_workflow_calls` + aggiornare `ai_budget_daily`.
 *
 * Estratto dallo `scaffold-runner.ts` (2026-06-06) per renderlo testabile
 * unitariamente — il runner full e\` troppo intrecciato con LLM dispatch +
 * tool registry + node catalog per essere mockato pulitamente. Qui invece
 * la responsabilita\` e\` UNA: chiamare tracker.record() con i campi corretti.
 *
 * NON THROW: il tracker fail e\` non-fatal per il wizard. Logghiamo warn
 * e proseguiamo — il wizard NON deve crashare se il DB e\` saturo o se
 * c'e\` un bug nel tracker.
 */
import { workflowCallTracker } from '@/services/ai-budget/workflow-call-tracker.service.js';
import { logger } from '@/lib/logger.js';

export interface PersistScaffoldCallInput {
  scaffoldRunId: string;
  iteration: number;
  provider: string;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** 'ok' su success, 'error' se l'LLM dispatch ha thrown. */
  status: 'ok' | 'error';
  /** Solo quando status='error', per audit + Run Inspector. */
  errorMessage?: string;
}

export function persistScaffoldCall(input: PersistScaffoldCallInput): void {
  try {
    // exactOptionalPropertyTypes: true on tsconfig — passare {model: undefined}
    // viola RecordWorkflowCallInput.model: string. Costruisco partial e spread
    // solo le optionals quando valorizzate.
    const base = {
      runId: input.scaffoldRunId,
      workflowId: 'ai-wizard-scaffold',
      nodeId: `iter-${input.iteration.toString()}`,
      defId: 'wizard_scaffold',
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      status: input.status,
    } as const;
    workflowCallTracker.record({
      ...base,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    });
  } catch (err) {
    // Non-fatal: il tracker fail non deve bloccare il wizard. Log e proseguo.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scaffoldRunId: input.scaffoldRunId,
        iteration: input.iteration,
        status: input.status,
      },
      '[SCAFFOLD] persistScaffoldCall failed (non-fatal)',
    );
  }
}
