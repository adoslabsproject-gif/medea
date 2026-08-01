export interface ToolExecutionContext {
  tenantId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  secrets: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface ToolExecutionResult {
  output: unknown;
  durationMs: number;
  warnings?: string[];
}

export interface ToolExecutionError extends Error {
  retryable?: boolean;
  code?: string;
}

export interface IToolExecutor {
  readonly id: string;
  readonly version: string;
  execute(
    config: Record<string, unknown>,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
