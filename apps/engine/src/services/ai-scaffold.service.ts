/**
 * AiScaffoldService — agent-loop workflow + DB schema generation.
 *
 * Architecture: NOT single-shot. The LLM operates as an agent that calls
 * tools step-by-step until it emits `finalize_workflow`. Provider-agnostic
 * by design — uses `dispatchLLMChat` so the same code path works on
 * Anthropic/OpenAI/Liara/Gemini/Mistral/Groq/OpenRouter/Ollama.
 *
 * Tool protocol (provider-agnostic JSON, no vendor function-calling needed):
 *   { "tool": "<name>", "args": { ... } }
 *
 * After each tool call:
 *   - Server EXECUTES the tool against the in-memory workflow draft + (when
 *     applicable) the tenant DB Studio (REAL ALTER TABLE / CREATE TABLE).
 *   - Server appends to the conversation a tool_result message.
 *   - Loop continues until finalize_workflow or abort, or MAX_ITERATIONS.
 *
 * Validation gates (server-side, NOT trusted to model):
 *   - Every connect_nodes ref must point to a node already in the draft.
 *   - add_node id must be unique.
 *   - finalize_workflow runs WorkflowSchema.parse + orphan-edge check.
 *   - DB ops are bound to the tenant's databases — cross-tenant blocked.
 *
 * Refactor 2026-05-28 — no monoliti, single responsibility:
 *   1002 LOC monolite → ai-scaffold.service.ts (~135 LOC barrel) +
 *   ai-scaffold/tools/{discovery,db-migrations,draft-mutations,observability}.ts +
 *   ai-scaffold/scaffold-runner.ts + ai-scaffold/types.ts.
 */

import type { ScaffoldProgressEmitter } from './ai-scaffold/scaffold-runner.js';
import { DbStudioService } from './db-studio.service.js';
// Side-effect import: registra i 28 tool nel registry al boot.
import './ai-scaffold/register-tools.js';
import { toolRegistry } from './ai-scaffold/tool-registry.js';
import type { ToolResult, WorkflowDraft, AiScaffoldTrace, AiScaffoldInput } from './ai-scaffold/types.js';
import { AiScaffoldError } from './ai-scaffold/types.js';
import { runScaffold, type AiScaffoldResult } from './ai-scaffold/scaffold-runner.js';
import {
  listDatabasesHandler,
  readDbSchemaHandler,
  listWorkflowsHandler,
  readWorkflowHandler,
  listNodeCatalogHandler,
  listEmailAccountsHandler,
  listSecretsHandler,
  listLlmProvidersHandler,
  listDraftNodesHandler,
} from './ai-scaffold/tools/discovery.js';
import {
  createDatabaseHandler,
  createTableHandler,
  addColumnHandler,
  dropColumnHandler,
  dropTableHandler,
  renameColumnHandler,
  addIndexHandler,
} from './ai-scaffold/tools/db-migrations.js';
import {
  addNodeHandler,
  connectNodesHandler,
  finalizeWorkflowHandler,
  abortHandler,
  updateNodeHandler,
  deleteNodeHandler,
  disconnectNodesHandler,
} from './ai-scaffold/tools/draft-mutations.js';
import { proposePlanHandler } from './ai-scaffold/tools/plan-handler.js';
import {
  listRecentRunsHandler,
  readRunHandler,
  checkSettingsHealthHandler,
} from './ai-scaffold/tools/observability.js';

// Re-export error + types per backward-compat con consumer (admin routes, ai routes).
export { AiScaffoldError };
export type { AiScaffoldInput, AiScaffoldTrace, AiScaffoldResult };

/**
 * ScaffoldSession — stato in-memory dell'agent loop per UNA esecuzione scaffold.
 *
 * Thin wrapper sui handler estratti nei sub-moduli:
 *   - draft: WorkflowDraft accumulato (nodes + edges)
 *   - dbStudio: DbStudioService per ALTER TABLE / CREATE TABLE reali
 *   - trace: ogni tool execution viene tracciata per audit + UI Run Inspector
 *
 * Ogni metodo `toolXxx` è one-liner di delega al rispettivo handler — i campi
 * `draft`, `dbStudio`, `tenantId` sono `readonly` ma accessibili dai handler.
 */
export class ScaffoldSession {
  draft: WorkflowDraft = { id: '', name: '', description: '', nodes: [], edges: [] };
  finalized = false;
  aborted = false;
  abortReason = '';
  trace: AiScaffoldTrace[] = [];
  /** Goal originale dell'utente — usato dal finalize gate per stimare min nodes. */
  goal = '';
  /**
   * Plan-then-Execute (2026-05-31): Phase 0 obbligatoria. Liara deve emettere
   * `propose_plan` PRIMA di add_node. Il plan e\` validato vs complessita\` goal,
   * tracciato vs draft, e visualizzato nell'UI come checklist.
   */
  plan: {
    accepted: boolean;
    proposedAt: number;
    reasoning: string;
    nodes: { id: string; defId: string; purpose: string }[];
    edges: { from: string; to: string; fromPort?: string }[];
  } | null = null;
  readonly dbStudio = new DbStudioService();

  constructor(readonly tenantId: string) {}

  /**
   * Dispatch tool call via Tool Registry pattern (state-of-the-art 2026).
   *
   * Vantaggi vs switch O(n):
   *   1. Validation Zod schema (registrato in ai-scaffold/register-tools.ts)
   *   2. Dispatch O(1) Map.get
   *   3. Auto-introspection: registry.all() → metadata serializzabili per
   *      Anthropic tool_use API / OpenAI function calling
   *   4. Plug-in friendly: nuovo tool = register({...}), no switch modify
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    const stepIdx = this.trace.length + 1;
    const result = await toolRegistry.execute(this, toolName, args);
    this.trace.push({ step: stepIdx, tool: toolName, args, result, elapsedMs: Date.now() - start });
    return result;
  }

  // ─── Discovery (read-only) ─────────────────────────────────────────
  toolReadDbSchema(args: Record<string, unknown>): ToolResult { return readDbSchemaHandler(this, args); }
  toolListDatabases(): ToolResult { return listDatabasesHandler(this); }
  toolListWorkflows(): Promise<ToolResult> { return listWorkflowsHandler(this); }
  toolReadWorkflow(args: Record<string, unknown>): Promise<ToolResult> { return readWorkflowHandler(this, args); }
  toolListNodeCatalog(args: Record<string, unknown>): ToolResult { return listNodeCatalogHandler(this, args); }
  toolListEmailAccounts(): ToolResult { return listEmailAccountsHandler(this); }
  toolListSecrets(): ToolResult { return listSecretsHandler(this); }
  toolListLlmProviders(): ToolResult { return listLlmProvidersHandler(this); }
  toolListDraftNodes(): ToolResult { return listDraftNodesHandler(this); }

  // ─── DB migrations (write) ─────────────────────────────────────────
  toolCreateDatabase(args: Record<string, unknown>): Promise<ToolResult> { return createDatabaseHandler(this, args); }
  toolCreateTable(args: Record<string, unknown>): Promise<ToolResult> { return createTableHandler(this, args); }
  toolAddColumn(args: Record<string, unknown>): Promise<ToolResult> { return addColumnHandler(this, args); }
  toolDropColumn(args: Record<string, unknown>): Promise<ToolResult> { return dropColumnHandler(this, args); }
  toolDropTable(args: Record<string, unknown>): Promise<ToolResult> { return dropTableHandler(this, args); }
  toolRenameColumn(args: Record<string, unknown>): ToolResult { return renameColumnHandler(this, args); }
  toolAddIndex(args: Record<string, unknown>): Promise<ToolResult> { return addIndexHandler(this, args); }

  // ─── Draft mutations (workflow in-memory) ──────────────────────────
  toolProposePlan(args: Record<string, unknown>): ToolResult { return proposePlanHandler(this, args); }
  toolAddNode(args: Record<string, unknown>): ToolResult { return addNodeHandler(this, args); }
  toolConnectNodes(args: Record<string, unknown>): ToolResult { return connectNodesHandler(this, args); }
  toolFinalizeWorkflow(args: Record<string, unknown>): ToolResult { return finalizeWorkflowHandler(this, args); }
  toolAbort(args: Record<string, unknown>): ToolResult { return abortHandler(this, args); }
  toolUpdateNode(args: Record<string, unknown>): ToolResult { return updateNodeHandler(this, args); }
  toolDeleteNode(args: Record<string, unknown>): ToolResult { return deleteNodeHandler(this, args); }
  toolDisconnectNodes(args: Record<string, unknown>): ToolResult { return disconnectNodesHandler(this, args); }

  // ─── Observability ─────────────────────────────────────────────────
  toolListRecentRuns(args: Record<string, unknown>): ToolResult { return listRecentRunsHandler(this, args); }
  toolReadRun(args: Record<string, unknown>): ToolResult { return readRunHandler(this, args); }
  toolCheckSettingsHealth(): ToolResult { return checkSettingsHealthHandler(this); }
}

/**
 * Public API — instance singleton + scaffold() entry point.
 * Logic estratta in ai-scaffold/scaffold-runner.ts.
 */
export class AiScaffoldService {
  /**
   * Scaffold entry point. Routing automatico:
   *  - `FLOWFORGE_SCAFFOLD_MODE=singleshot` (default 2026-05-31) → guided_json
   *    1-shot vLLM (30-90s, 0 retry, 100% completo).
   *  - `FLOWFORGE_SCAFFOLD_MODE=iter` → legacy loop iter (compat, debug).
   *  - Override per-call via input.mode (futuro BYOK Claude).
   */
  async scaffold(
    input: AiScaffoldInput,
    onProgress?: ScaffoldProgressEmitter,
  ): Promise<AiScaffoldResult> {
    const mode = process.env.FLOWFORGE_SCAFFOLD_MODE ?? 'singleshot';
    if (mode === 'singleshot') {
      const { runSingleshotScaffold } = await import('./ai-scaffold/singleshot.service.js');
      // Adapter SSE: ogni fase singleshot → 1 row trace separata con
      // tool_call PROGRESSIVO. Quando arriva la fase successiva, chiudo la
      // precedente con tool_result ok=true. Cosi\` UI mostra:
      //   01 ⚙ analyzing ✓
      //   02 ✨ generating ✓
      //   03 🛡 validating ✓
      // invece di 3 step bloccati a ◷.
      let currentPhase: { iter: number; tool: string; phase: string; startedAt: number } | null = null;
      const PHASE_TOOL_MAP: Record<string, string> = {
        analyzing: 'singleshot_analyze',
        generating: 'singleshot_generate',
        validating: 'singleshot_validate',
      };
      const closePhase = (): void => {
        if (currentPhase && onProgress) {
          void onProgress({
            type: 'tool_result',
            iteration: currentPhase.iter,
            tool: currentPhase.tool,
            ok: true,
            elapsedMs: Date.now() - currentPhase.startedAt,
          });
        }
      };
      let iterCounter = 0;

      return runSingleshotScaffold(input, (e) => {
        if (!onProgress) return;
        if (e.type === 'start') {
          // maxIter è una STIMA dei tool_call che genereremo lato wrapper:
          // queued + analyzing + generating + N×(node_added) + validating + done.
          // Per workflow medi N≈8-12 nodi → ~14-18 iter. 12 è una baseline
          // safe; il frontend cresce dinamicamente con `~` prefix se overshoot.
          // Bug user 2026-05-31: 3 era hardcoded → "1/3 ... 6/3 ... 200%".
          void onProgress({ type: 'start', goal: input.goal, maxIter: 12 });
        } else if (e.type === 'queued') {
          // SSE event "queued" custom — il frontend lo riconosce e mostra
          // "In coda — posizione X" senza creare un tool row distinto.
          closePhase();
          iterCounter++;
          currentPhase = { iter: iterCounter, tool: 'singleshot_queued', phase: 'queued', startedAt: Date.now() };
          void onProgress({ type: 'iter_start', iteration: iterCounter, phase: 'llm_call' });
          void onProgress({
            type: 'tool_call',
            iteration: iterCounter,
            tool: 'singleshot_queued',
            args: { phase: 'queued', detail: e.detail ?? '', queueStats: e.queueStats ?? {} },
          });
        } else if (e.type === 'analyzing' || e.type === 'generating' || e.type === 'validating') {
          closePhase();
          iterCounter++;
          const tool = PHASE_TOOL_MAP[e.type] ?? 'singleshot_generate';
          currentPhase = { iter: iterCounter, tool, phase: e.type, startedAt: Date.now() };
          void onProgress({ type: 'iter_start', iteration: iterCounter, phase: 'llm_call' });
          void onProgress({ type: 'tool_call', iteration: iterCounter, tool, args: { phase: e.type, detail: e.detail ?? '' } });
        } else if (e.type === 'token_usage' && e.tokens) {
          void onProgress({
            type: 'token_usage',
            iteration: iterCounter,
            cumulative: { input: e.tokens.input, output: e.tokens.output },
            lastCall: e.tokens,
          });
        } else if (e.type === 'node_added') {
          void onProgress({
            type: 'singleshot_node_added',
            iteration: iterCounter,
            index: e.index ?? 0,
            node: e.payload,
          });
        } else if (e.type === 'edge_added') {
          void onProgress({
            type: 'singleshot_edge_added',
            iteration: iterCounter,
            index: e.index ?? 0,
            edge: e.payload,
          });
        } else if (e.type === 'meta' && e.detail) {
          try {
            const meta = JSON.parse(e.detail) as { name?: string; description?: string; reasoning?: string };
            void onProgress({ type: 'singleshot_meta', iteration: iterCounter, meta });
          } catch { /* ignore malformed */ }
        } else if (e.type === 'done' && e.result) {
          closePhase();
          currentPhase = null;
          void onProgress({ type: 'done', result: e.result });
        } else if (e.type === 'error') {
          closePhase();
          currentPhase = null;
        }
      });
    }
    return runScaffold(input, onProgress);
  }
}

export const aiScaffold = new AiScaffoldService();
