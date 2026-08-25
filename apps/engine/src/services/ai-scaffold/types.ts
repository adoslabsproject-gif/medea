/**
 * AI Scaffold — types condivisi tra ai-scaffold.service.ts e i sub-moduli
 * (tools/discovery, tools/db-migrations, tools/draft-mutations, tools/observability,
 * scaffold-runner).
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

export interface DraftNode {
  id: string;
  defId: string;
  name?: string;
  position: { x: number; y: number };
  config: Record<string, string>;
}

export interface DraftEdge {
  from: string;
  to: string;
  fromPort?: string;
}

export interface WorkflowDraft {
  id: string;
  name: string;
  description: string;
  nodes: DraftNode[];
  edges: DraftEdge[];
}

/**
 * `meta` carries machine-readable directives the agent prompt is instructed
 * to honor verbatim (e.g. `useThisProvider`). Kept separate from `data` so
 * consumers that only render results don't dump directives into the
 * user-visible JSON.
 */
export type ToolResult =
  | { ok: true; data?: unknown; meta?: Record<string, unknown> }
  | { ok: false; error: string };

export interface AiScaffoldInput {
  goal: string;
  tenantId: string;
  databaseId?: string;
  apiKey?: string;
  provider?: string;
  /** Indirizzo del provider, per i self-hosted il cui host lo conosce solo
   *  chi chiama (Liara, Ollama, endpoint privati). Non viene salvato. */
  baseUrl?: string;
  /** Hard ceiling on agent iterations (default 12). Prevents runaway models. */
  maxIterations?: number;
}

export interface AiScaffoldTrace {
  step: number;
  tool: string;
  args: unknown;
  result: ToolResult;
  elapsedMs: number;
}

export class AiScaffoldError extends Error {
  constructor(
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'AiScaffoldError';
  }
}
