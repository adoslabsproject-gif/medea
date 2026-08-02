/**
 * agent_debug_run_failure executor — D3 AI moat.
 *
 * Pipeline:
 *  1. Fetch run row da DB locale runtime tenant (no portal call, local first)
 *  2. Identify failed step (first status='error')
 *  3. Build context: nodo def + config interpolato + input + error stack + downstream impact
 *  4. POST a Liara con system prompt strutturato → JSON output {diagnosis, fixes, tests}
 *  5. Auto-replay opzionale via runService.replay({fromNodeId: failedNodeId})
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { logLlmExchange } from '@medea/engine-nodes-stdlib';
import { eq } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { runs } from '@/storage/schema.js';
import { dispatchLLMChat, type LlmTokenUsage } from '@/services/llm-chat.service.js';
import { llmResolver } from '@/services/llm-resolver.service.js';

interface RunStep {
  nodeId: string;
  defId?: string;
  status: 'success' | 'error' | 'skipped' | 'running';
  durationMs?: number;
  output?: string;
  error?: string;
  nodeConfig?: unknown;
  input?: string;
}

interface DiagnosisOutput {
  diagnosis: { rootCause: string; category: string; confidence: number };
  suggestedFixes: { type: string; description: string; patch?: unknown; confidence: number }[];
  suggestedTests: { scenario: string; expectation: string; mockData?: unknown }[];
}

function safeParseJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function classifyError(errMsg: string): string {
  const msg = errMsg.toLowerCase();
  if (/timeout|etimedout|econnreset|503|502|504/.test(msg)) return 'transient';
  if (/401|403|unauthor|forbid|invalid.*credent|invalid.*token/.test(msg)) return 'auth';
  if (/429|rate.?limit|quota/.test(msg)) return 'quota';
  if (/400|invalid.*payload|missing.*required|validation/.test(msg)) return 'payload';
  if (/500|internal.?error|crashed|undefined is not/.test(msg)) return 'runtime';
  return 'unknown';
}

export const debugRunFailureExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const runId = coerceString(cfg.runId ?? '').trim();
  if (!runId) throw new Error('agent_debug_run_failure: runId obbligatorio.');

  const includeTests =
    cfg.includeTests !== false && coerceString(cfg.includeTests ?? 'true') !== 'false';
  const maxFixes = Math.min(Math.max(Number(cfg.maxFixes ?? 3), 1), 5);
  const autoReplay = cfg.autoReplay === true || coerceString(cfg.autoReplay ?? 'false') === 'true';

  // Fetch run row
  const { db } = getDatabase();
  const existing = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const run = existing[0];
  if (!run) throw new Error(`Run ${runId} non trovato`);

  const steps: RunStep[] = safeParseJson<RunStep[]>(run.stepsJson) ?? [];
  const triggerInput = safeParseJson(run.input);

  // Identify failed step
  const explicitFailed = coerceString(cfg.failedNodeId ?? '').trim();
  const failedStep = explicitFailed
    ? steps.find((s) => s.nodeId === explicitFailed)
    : steps.find((s) => s.status === 'error');
  if (!failedStep) {
    return {
      output: {
        diagnosis: { rootCause: 'Nessun step fallito trovato', category: 'none', confidence: 1 },
        suggestedFixes: [],
        suggestedTests: [],
        runStatus: run.status,
      },
      durationMs: Date.now() - start,
    };
  }

  const errorMsg = failedStep.error ?? 'Errore non specificato';
  const errorCategory = classifyError(errorMsg);

  // Build LLM context
  const sysPrompt =
    `Sei un AI debugging assistant per FlowForge workflow runtime. Analizza un nodo fallito e produci diagnosi + fix actionable. ` +
    `Output JSON: { "diagnosis": { "rootCause": "...", "category": "${errorCategory}", "confidence": 0-1 }, ` +
    `"suggestedFixes": [{ "type": "config|retry|replace|guard", "description": "IT", "patch": {<json>}, "confidence": 0-1 }], ` +
    (includeTests
      ? `"suggestedTests": [{ "scenario": "...", "expectation": "...", "mockData": {<json>} }] `
      : `"suggestedTests": [] `) +
    `}. Limit ${String(maxFixes)} fixes. ` +
    `category options: transient/auth/quota/payload/runtime/unknown. ` +
    `type options: config (cambio config field), retry (aumenta retry/backoff), replace (sostituisci con nodo simile), guard (aggiungi if/validate prima).`;

  const userPrompt =
    `RUN ID: ${runId}\n` +
    `WORKFLOW: ${run.workflowId}\n` +
    `FAILED NODE: ${failedStep.nodeId} (defId: ${failedStep.defId ?? 'unknown'})\n` +
    `ERROR: ${errorMsg.slice(0, 2000)}\n` +
    `CATEGORY (heuristic): ${errorCategory}\n` +
    `NODE CONFIG: ${JSON.stringify(failedStep.nodeConfig ?? {}).slice(0, 1500)}\n` +
    `INPUT TO NODE: ${(failedStep.input ?? '').slice(0, 800)}\n` +
    `TRIGGER INPUT: ${JSON.stringify(triggerInput ?? {}).slice(0, 800)}\n` +
    `DOWNSTREAM STEPS: ${steps
      .filter((s) => s.nodeId !== failedStep.nodeId)
      .map((s) => `${s.nodeId}(${s.status})`)
      .join(', ')
      .slice(0, 500)}`;

  // Fase 2 (#14): resolver + gateway metered (Liara default, BYOK override) —
  // PRIMA: LIARA_URL "v1 complete" diretto, route inesistente + 401 internalAuth
  // → la diagnosi AI non partiva MAI, sempre fallback euristico.
  let result: DiagnosisOutput;
  let llmUsage: LlmTokenUsage | undefined;
  let llmProvider = '';
  let llmModel = '';
  try {
    const resolved = llmResolver.resolve(context.tenantId);
    llmProvider = resolved.provider;
    llmModel = resolved.model || `${resolved.provider}-default`;
    const raw = (
      await dispatchLLMChat(
        resolved.provider,
        resolved.apiKey,
        resolved.model,
        sysPrompt,
        userPrompt,
        resolved.baseUrl,
        [],
        (u) => {
          llmUsage = u;
        },
        undefined,
        { maxTokens: 2000, timeoutMs: 60_000 },
      )
    ).trim();
    // Fase 3 (#15): prompt completo + risposta → StepLog 'llm' (anche se il
    // parse sotto fallisce: la chiamata è avvenuta).
    logLlmExchange(context, {
      provider: llmProvider,
      model: llmModel,
      system: sysPrompt,
      user: userPrompt,
      response: raw,
    });
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) throw new Error('LLM non ha ritornato JSON valido');
    result = JSON.parse(jsonMatch[0]) as DiagnosisOutput;
    // Sanity check shape
    if (!result.diagnosis || !Array.isArray(result.suggestedFixes)) {
      throw new Error('LLM output malformato (missing diagnosis or suggestedFixes)');
    }
  } catch (e) {
    // Graceful fallback: heuristic-only diagnosis
    result = {
      diagnosis: {
        rootCause: `Diagnosi euristica: ${errorMsg.slice(0, 200)}`,
        category: errorCategory,
        confidence: 0.3,
      },
      suggestedFixes: [
        {
          type: errorCategory === 'transient' ? 'retry' : 'config',
          description:
            errorCategory === 'transient'
              ? 'Aumenta retry policy: count=3, backoff=exponential da 1s, max 30s.'
              : `Verifica config del nodo ${failedStep.nodeId} contro lo schema NodeDef.`,
          confidence: 0.5,
        },
      ],
      suggestedTests: [],
    };
    (result as { warnings?: string[] }).warnings = [
      `liara unavailable: ${e instanceof Error ? e.message : String(e)}`,
    ];
  }

  // Build replay command (one-click apply)
  const replayCommand = {
    method: 'POST',
    path: `/runs/${runId}/replay?fromNodeId=${encodeURIComponent(failedStep.nodeId)}`,
    body: {},
  };

  // Auto-replay (opt-in pericoloso)
  let autoReplayResult: unknown = null;
  if (autoReplay && result.suggestedFixes.length > 0) {
    autoReplayResult = {
      skipped:
        'autoReplay implementato a livello workflow chiamante (no LLM-driven mutation senza human-in-loop)',
    };
  }

  return {
    output: {
      diagnosis: result.diagnosis,
      suggestedFixes: result.suggestedFixes.slice(0, maxFixes),
      suggestedTests: includeTests ? (result.suggestedTests ?? []).slice(0, maxFixes) : [],
      replayCommand,
      autoReplayResult,
      failedNodeId: failedStep.nodeId,
      errorCategory,
      runStatus: run.status,
      // Fase 2 (#14): usage standard — presente solo se la diagnosi AI è avvenuta
      // (fallback euristico = zero token spesi).
      ...(llmUsage !== undefined
        ? {
            _llm: {
              inputTokens: llmUsage.input,
              outputTokens: llmUsage.output,
              model: llmModel,
              provider: llmProvider,
              fromApi: llmUsage.fromApi,
            },
          }
        : {}),
    },
    durationMs: Date.now() - start,
  };
};
