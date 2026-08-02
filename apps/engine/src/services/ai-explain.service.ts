/**
 * AiExplainService — diagnose a failed run with an LLM and propose a fix.
 *
 * Lifecycle of a call:
 *   1. Load the run row + parsed steps from `runs` table
 *   2. Locate the first errored step + load the workflow snapshot
 *   3. Resolve an LLM provider (via LlmResolverService)
 *   4. Build the diagnostic prompt (system + user content modules)
 *   5. Dispatch to the provider, parse strict-JSON reply
 *   6. Log the interaction in ai_interactions (type='run_explain')
 *   7. Return {explanation, fix, patch?, interactionId, failedNodeId}
 *
 * Errors are surfaced as typed exceptions so the HTTP route can map them
 * to the right status codes without duplicating message strings.
 */

import { z } from 'zod';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { llmResolver, NoLlmProviderError } from './llm-resolver.service.js';
import { AIInteractionsService } from './ai-interactions.service.js';
import { AnthropicProvider } from '@/adapters/llm-anthropic.js';
import {
  buildRunExplainSystemPrompt,
  buildRunExplainUserContent,
} from '@/prompts/run-explain.prompt.js';
import { stdlibNodeDefs as stdlibNodeDefsExport } from '@medea/engine-nodes-stdlib';
import { counterInc, histogramObserve } from '@/lib/metrics-store.js';

/* ── Error types ─────────────────────────────────────────────────────── */

export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Run ${runId} non trovato.`);
    this.name = 'RunNotFoundError';
  }
}

export class RunSucceededError extends Error {
  constructor() {
    super("Il run è andato a buon fine — non c'è nulla da spiegare.");
    this.name = 'RunSucceededError';
  }
}

export class NoFailedStepError extends Error {
  constructor() {
    super('Nessuno step in errore trovato in questo run.');
    this.name = 'NoFailedStepError';
  }
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

/* ── Public types ────────────────────────────────────────────────────── */

export interface ExplainArgs {
  tenantId: string;
  runId: string;
  userId?: string;
}

export interface ExplainResult {
  explanation: string;
  fix: string;
  patch?: Record<string, unknown>;
  /** 0.0-1.0 — quanto il modello è sicuro della diagnosi */
  confidence?: number;
  /** 1-2 frasi precise sulla causa */
  root_cause?: string;
  /** Citazioni dirette dal config/error che supportano la diagnosi */
  evidence?: string[];
  /** safe = applicabile auto, experimental = serve review, destructive = rimuove nodi */
  risk?: 'safe' | 'experimental' | 'destructive';
  /** Verifica che il modello stesso fa sul proprio output */
  self_check?: {
    patch_keys_exist_in_nodedef: boolean;
    patch_modifies_only_target_node: boolean;
    explanation_cites_evidence: boolean;
  };
  /** Risultato della validation server-side post-LLM */
  server_validation?: {
    valid: boolean;
    issues: string[];
  };
  interactionId: string | null;
  runId: string;
  failedNodeId: string;
}

/* ── Internal types (DB shape) ───────────────────────────────────────── */

interface RunRow {
  id: string;
  workflow_id: string;
  tenant_id: string;
  status: string;
  steps_json: string;
}

interface WorkflowRow {
  id: string;
  name: string;
  nodes_json: string;
  edges_json: string;
}

interface RunStep {
  nodeId: string;
  defId?: string;
  status: string;
  error?: string;
  output?: unknown;
  durationMs?: number;
}

/* ── LLM reply Zod schema ────────────────────────────────────────────── */

const ReplySchema = z.object({
  // Required core fields
  explanation: z.string(),
  fix: z.string(),
  // Federico-grade extension
  confidence: z.number().min(0).max(1).optional(),
  root_cause: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  risk: z.enum(['safe', 'experimental', 'destructive']).optional(),
  self_check: z
    .object({
      patch_keys_exist_in_nodedef: z.boolean().optional(),
      patch_modifies_only_target_node: z.boolean().optional(),
      explanation_cites_evidence: z.boolean().optional(),
    })
    .optional(),
  patch: z
    .object({
      addNodes: z.array(z.unknown()).optional(),
      removeNodeIds: z.array(z.string()).optional(),
      addEdges: z.array(z.unknown()).optional(),
      removeEdgeIds: z.array(z.string()).optional(),
      updateNodes: z.array(z.object({ id: z.string(), patch: z.record(z.unknown()) })).optional(),
    })
    .optional(),
});

/* ── Service ─────────────────────────────────────────────────────────── */

/**
 * Pluggable LLM dispatcher signature — lets tests inject a deterministic
 * mock instead of calling out to a real provider. Production code uses
 * the default that goes through AnthropicProvider / dispatchLLMChat.
 */
export type LlmDispatcher = (args: {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  system: string;
  userContent: string;
}) => Promise<string>;

const defaultDispatcher: LlmDispatcher = async (args) => {
  if (args.provider === 'anthropic') {
    const llm = new AnthropicProvider(args.apiKey);
    const response = await llm.complete({
      model: args.model || '',
      messages: [
        { role: 'system' as const, content: args.system },
        { role: 'user' as const, content: args.userContent },
      ],
      maxTokens: 2048,
      temperature: 0.1,
    });
    return response.text.trim();
  }
  const dispatcher = await import('./llm-chat.service.js');
  return (
    await dispatcher.dispatchLLMChat(
      args.provider,
      args.apiKey,
      args.model,
      args.system,
      args.userContent,
      args.baseUrl,
      [],
    )
  ).trim();
};

export class AiExplainService {
  private readonly interactions = new AIInteractionsService();

  constructor(private readonly dispatcher: LlmDispatcher = defaultDispatcher) {}

  async explain(args: ExplainArgs): Promise<ExplainResult> {
    const startTime = Date.now();
    const { sqlite } = getDatabase();

    // 1. Load the run row
    const runRow = sqlite
      .prepare('SELECT * FROM runs WHERE tenant_id = ? AND id = ?')
      .get(args.tenantId, args.runId) as RunRow | undefined;
    if (!runRow) throw new RunNotFoundError(args.runId);
    if (runRow.status === 'success') throw new RunSucceededError();

    // 2. Parse steps, find first failed
    let steps: RunStep[] = [];
    try {
      steps = JSON.parse(runRow.steps_json) as RunStep[];
    } catch {
      /* keep empty */
    }
    const failedStep = steps.find((s) => s.status === 'error');
    if (!failedStep) throw new NoFailedStepError();

    // 3. Load workflow snapshot for the LLM to reason about structure
    const wfRow = sqlite
      .prepare(
        'SELECT id, name, nodes_json, edges_json FROM workflows WHERE tenant_id = ? AND id = ?',
      )
      .get(args.tenantId, runRow.workflow_id) as WorkflowRow | undefined;
    let workflowSnapshot: unknown = null;
    if (wfRow) {
      try {
        workflowSnapshot = {
          id: wfRow.id,
          name: wfRow.name,
          nodes: JSON.parse(wfRow.nodes_json) as unknown[],
          edges: JSON.parse(wfRow.edges_json) as unknown[],
        };
      } catch {
        /* keep null */
      }
    }

    // 4. Resolve provider (throws NoLlmProviderError on miss — bubble up)
    const resolved = llmResolver.resolve(args.tenantId);

    // 5. Build prompts
    const system = buildRunExplainSystemPrompt();
    const userContentArgs: Parameters<typeof buildRunExplainUserContent>[0] = {
      workflow: workflowSnapshot,
      runId: args.runId,
      runStatus: runRow.status,
      failedNodeId: failedStep.nodeId,
    };
    if (failedStep.defId !== undefined) userContentArgs.failedNodeDefId = failedStep.defId;
    if (failedStep.error !== undefined) userContentArgs.errorMessage = failedStep.error;
    if (failedStep.output !== undefined) userContentArgs.failedNodeOutput = failedStep.output;
    // Federico-grade: passa il config ATTUALE del nodo fallito al modello
    // così la diagnosi ha accesso ai valori esatti dei field e può citarli
    // come evidenza. Senza questo, il modello vede solo nodeId+defId+error
    // → diagnosi necessariamente generica.
    if (workflowSnapshot && typeof workflowSnapshot === 'object') {
      const nodes =
        (workflowSnapshot as { nodes?: { id?: string; config?: Record<string, unknown> }[] })
          .nodes ?? [];
      const failedNode = nodes.find((n) => n.id === failedStep.nodeId);
      if (failedNode?.config) userContentArgs.failedNodeConfig = failedNode.config;
    }
    const userContent = buildRunExplainUserContent(userContentArgs);

    // 6. Dispatch via the injected (or default) dispatcher
    let text: string;
    try {
      const dispatcherArgs: Parameters<LlmDispatcher>[0] = {
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model: resolved.model,
        system,
        userContent,
      };
      if (resolved.baseUrl !== undefined) dispatcherArgs.baseUrl = resolved.baseUrl;
      text = await this.dispatcher(dispatcherArgs);
    } catch (err) {
      counterInc({
        name: 'flowforge_ai_explain_total',
        help: 'Total AI explain requests by provider + outcome',
        tags: { provider: resolved.provider, outcome: 'error' },
      });
      logger.error(
        { err, runId: args.runId, provider: resolved.provider },
        'AI explain LLM dispatch failed',
      );
      throw err;
    }

    // 7. Strip code fences, parse JSON, validate
    const stripped = text.startsWith('```')
      ? text
          .replace(/^```(?:json)?\n?/u, '')
          .replace(/```$/u, '')
          .trim()
      : text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      throw new LlmResponseError(
        `AI ha risposto con un formato non valido (non JSON): ${err instanceof Error ? err.message : String(err)}`,
        stripped.slice(0, 1000),
      );
    }
    const validated = ReplySchema.safeParse(parsed);
    if (!validated.success) {
      throw new LlmResponseError('AI reply failed schema validation', {
        issues: validated.error.issues,
        raw: parsed,
      });
    }

    // Observability: emit counter + latency histogram for /metrics scraping.
    counterInc({
      name: 'flowforge_ai_explain_total',
      help: 'Total AI explain requests by provider + outcome',
      tags: { provider: resolved.provider, outcome: 'success' },
    });
    histogramObserve({
      name: 'flowforge_ai_explain_latency_ms',
      help: 'AI explain end-to-end latency in milliseconds',
      tags: { provider: resolved.provider },
      value: Date.now() - startTime,
    });

    // 8. Log for training-set capture (grouped args — context/request/response)
    const interactionId = this.interactions.insert({
      context: {
        tenantId: args.tenantId,
        ...(args.userId ? { userId: args.userId } : {}),
        workflowId: runRow.workflow_id,
      },
      interactionType: 'run_explain',
      request: {
        prompt: userContent,
        workflowSnapshot,
      },
      response: {
        message: `${validated.data.explanation}\n\nFix: ${validated.data.fix}`,
        ...(validated.data.patch ? { patch: validated.data.patch } : {}),
        model: `${resolved.provider}/${resolved.model || '(default)'}`,
        latencyMs: Date.now() - startTime,
      },
    });

    // Post-validation server-side: verifica che il patch proposto sia
    // applicabile senza rotture. Federico-grade: il modello può sbagliare,
    // il server è l'ultima linea di difesa. Verifiche:
    //   1. patch.updateNodes[].id → nodo esiste nel workflow
    //   2. patch.updateNodes[].patch.config.<key> → key esiste nel NodeDef.configFields
    //   3. patch.addNodes[].defId → defId esiste nel catalog
    //   4. patch.removeNodeIds → nodi esistono
    const serverValidation = validatePatchAgainstWorkflow(validated.data.patch, workflowSnapshot);

    const result: ExplainResult = {
      explanation: validated.data.explanation,
      fix: validated.data.fix,
      interactionId,
      runId: args.runId,
      failedNodeId: failedStep.nodeId,
      server_validation: serverValidation,
    };
    if (validated.data.patch) result.patch = validated.data.patch;
    if (validated.data.confidence !== undefined) result.confidence = validated.data.confidence;
    if (validated.data.root_cause) result.root_cause = validated.data.root_cause;
    if (validated.data.evidence) result.evidence = validated.data.evidence;
    if (validated.data.risk) result.risk = validated.data.risk;
    if (validated.data.self_check) {
      result.self_check = {
        patch_keys_exist_in_nodedef: validated.data.self_check.patch_keys_exist_in_nodedef ?? false,
        patch_modifies_only_target_node:
          validated.data.self_check.patch_modifies_only_target_node ?? false,
        explanation_cites_evidence: validated.data.self_check.explanation_cites_evidence ?? false,
      };
    }
    return result;
  }
}

/**
 * Validate the LLM-proposed patch against the workflow snapshot + node catalog.
 *
 * Returns { valid: false, issues: [...] } if any of these conditions fail:
 *   • updateNodes[].id references a non-existent node
 *   • updateNodes[].patch.config.<key> is not a known configField of the node's defId
 *   • addNodes[].defId is not in stdlibNodeDefs() catalog
 *   • removeNodeIds[] references a non-existent node
 *
 * The frontend uses this to decide whether the "🪄 Applica fix" button is
 * enabled or shown with warning ("Patch propose modifica fields sconosciuti").
 */
function validatePatchAgainstWorkflow(
  patch: z.infer<typeof ReplySchema>['patch'],
  workflowSnapshot: unknown,
): { valid: boolean; issues: string[] } {
  if (!patch) return { valid: true, issues: [] };
  const issues: string[] = [];
  if (!workflowSnapshot || typeof workflowSnapshot !== 'object') {
    return { valid: false, issues: ['workflow snapshot unavailable for validation'] };
  }
  const nodes = (workflowSnapshot as { nodes?: { id?: string; defId?: string }[] }).nodes ?? [];
  const nodeById = new Map(nodes.filter((n) => n.id).map((n) => [n.id!, n]));
  const catalog = new Map(stdlibNodeDefsList().map((d) => [d.id, d]));

  // updateNodes validation
  for (const upd of patch.updateNodes ?? []) {
    const node = nodeById.get(upd.id);
    if (!node) {
      issues.push(`updateNodes: nodeId "${upd.id}" non esiste nel workflow`);
      continue;
    }
    const def = node.defId ? catalog.get(node.defId) : undefined;
    if (!def) {
      issues.push(
        `updateNodes: defId "${node.defId ?? '?'}" del nodo "${upd.id}" non è nel catalog`,
      );
      continue;
    }
    const configPatch = (upd.patch as { config?: Record<string, unknown> })?.config;
    if (configPatch && typeof configPatch === 'object') {
      const validKeys = new Set((def.configFields ?? []).map((f) => f.key));
      for (const key of Object.keys(configPatch)) {
        if (!validKeys.has(key)) {
          issues.push(
            `updateNodes[${upd.id}].config.${key} → NON è un configField valido di "${def.id}". Accetta: ${[...validKeys].join(', ')}`,
          );
        }
      }
    }
  }
  // addNodes validation
  for (const add of patch.addNodes ?? []) {
    const defId = (add as { defId?: string })?.defId;
    if (!defId || !catalog.has(defId)) {
      issues.push(`addNodes: defId "${defId ?? '?'}" non è nel catalog`);
    }
  }
  // removeNodeIds validation
  for (const rid of patch.removeNodeIds ?? []) {
    if (!nodeById.has(rid)) {
      issues.push(`removeNodeIds: nodeId "${rid}" non esiste`);
    }
  }

  return { valid: issues.length === 0, issues };
}

function stdlibNodeDefsList(): { id: string; configFields?: { key: string }[] }[] {
  // Lazy import via require fallback isn't possible in ESM — already imported
  // via prompt builder. Use the export here.

  return (
    stdlibNodeDefsExport as unknown as () => { id: string; configFields?: { key: string }[] }[]
  )();
}

/** Module-level singleton. Service is stateless. */
export const aiExplainService = new AiExplainService();

/** Re-export so callers can catch the right errors without deep imports. */
export { NoLlmProviderError };
