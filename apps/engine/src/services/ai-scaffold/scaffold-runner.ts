/**
 * Scaffold runner — orchestra l'agent loop end-to-end.
 *
 * - Risolve provider LLM via llmResolver (Anthropic/OpenAI/Liara/Gemini/...)
 * - Costruisce il primo user message (goal + catalogo + db hint)
 * - Loop: dispatchLLMChat → parse tool call → session.execute → append history
 * - Truncation detection (heuristica tail-shape per provider che non danno finishReason)
 * - Redact sensitive prima di passare result al modello
 * - Build canonical Workflow + WorkflowSchema.parse alla fine
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

import { randomUUID } from 'node:crypto';
import { WorkflowSchema, type Workflow } from '@medea/engine-core-schema';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { dispatchLLMChat } from '@/services/llm-chat.service.js';
import { logger } from '@/lib/logger.js';
import { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import { pickScaffoldPrompt } from './prompts.js';
import { buildNodeCatalog } from './node-catalog.js';
import { redactSensitive } from './redact.js';
import { callLlmWithRetry } from './llm-retry.js';
import { persistScaffoldCall } from './persist-call.js';
import { AiScaffoldError, type AiScaffoldInput, type AiScaffoldTrace } from './types.js';

// 2026-05-30 FIX user-segnalato: workflow Enterprise (Document intelligence,
// PEC compliance, e-commerce pipeline) richiedono 14-18 nodi. Con maxIter=12
// l'agente finalizzava al 3° nodo o lasciava workflow incompleti. Bump a 30
// permette pattern complessi (branching + error handler + multi-step) di
// completare end-to-end. Il system prompt vieta finalize prematuro.
const MAX_ITERATIONS = Number(process.env.MEDEA_SCAFFOLD_MAX_ITER ?? '60');
const MAX_GOAL_LEN = 4000;

export interface AiScaffoldTableToCreate {
  databaseId?: string | undefined;
  name: string;
  description?: string | undefined;
  columns: {
    name: string;
    type: string;
    nullable?: boolean | undefined;
    unique?: boolean | undefined;
    primaryKey?: boolean | undefined;
  }[];
}

export interface AiScaffoldResult {
  workflow: Workflow;
  modelUsed: string;
  durationMs: number;
  iterations: number;
  trace: AiScaffoldTrace[];
  notes: string[];
  /** Tabelle DB nuove dichiarate dal LoRA (singleshot tablesToCreate). Il client
   *  le mostra in preview con badge "🆕 nuova tabella" e quando l'utente
   *  conferma import, il server le crea PRE-workflow via create_table tool. */
  tablesToCreate?: AiScaffoldTableToCreate[];
}

/**
 * Progress emitter per il path SSE. Permette al consumer (route streaming)
 * di pushare eventi al client mentre l'agent loop e\` ancora in corso —
 * evita 524 Cloudflare e da\` UX live progress.
 */
export type ScaffoldProgressEvent =
  | { type: 'start'; goal: string; maxIter: number }
  | { type: 'iter_start'; iteration: number; phase: 'llm_call' }
  | { type: 'tool_call'; iteration: number; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; iteration: number; tool: string; ok: boolean; elapsedMs: number; error?: string }
  | { type: 'iter_end'; iteration: number; truncated?: boolean; parseError?: string }
  /** LLM ha emesso output non utilizzabile (troncato / JSON malformato / tool field
   *  mancante). Iter conta ma nessun tool e\` stato eseguito. Lo emettiamo come
   *  evento dedicato cosi\` il frontend mostra il "buco" invece di nascondere
   *  l'iter (utente vedeva step saltati nel trace UI). */
  | { type: 'llm_retry'; iteration: number; reason: 'truncated' | 'parse_error' | 'invalid_tool'; detail: string }
  /** Token usage cumulativo dopo ogni LLM call. UI mostra contatore live + timer. */
  | { type: 'token_usage'; iteration: number; cumulative: { input: number; output: number }; lastCall: { input: number; output: number; fromApi: boolean } }
  /** Phase 0 (Plan-then-Execute 2026-05-31): propose_plan accettato.
   *  UI mostra checklist dei planned nodes con avanzamento real-time. */
  | { type: 'plan_proposed'; iteration: number; plan: { nodes: { id: string; defId: string; purpose: string }[]; edges: { from: string; to: string; fromPort?: string }[]; reasoning: string } }
  /** Streaming singleshot (2026-05-31): emesso man mano che il parser parser
   *  identifica un nodo / edge / meta completato durante lo stream LLM.
   *  UI usa per renderizzare nodi che si "accendono" in real-time invece
   *  di vedere "67% bloccato per 100s poi tutto insieme". */
  | { type: 'singleshot_node_added'; iteration: number; index: number; node: unknown }
  | { type: 'singleshot_edge_added'; iteration: number; index: number; edge: unknown }
  | { type: 'singleshot_meta'; iteration: number; meta: { name?: string; description?: string; reasoning?: string } }
  | { type: 'done'; result: AiScaffoldResult };
export type ScaffoldProgressEmitter = (event: ScaffoldProgressEvent) => void | Promise<void>;

export async function runScaffold(input: AiScaffoldInput, onProgress?: ScaffoldProgressEmitter): Promise<AiScaffoldResult> {
  const goal = input.goal.trim();
  if (goal.length < 5) throw new AiScaffoldError('Obiettivo troppo corto.');
  if (goal.length > MAX_GOAL_LEN) throw new AiScaffoldError(`Obiettivo troppo lungo (max ${MAX_GOAL_LEN.toString()} caratteri).`);

  let resolved;
  try {
    const opts: { headerApiKey?: string; requestedProvider?: string } = {};
    if (input.apiKey) opts.headerApiKey = input.apiKey;
    if (input.provider) opts.requestedProvider = input.provider;
    resolved = llmResolver.resolve(input.tenantId, opts);
  } catch (e) {
    if (e instanceof NoLlmProviderError) throw new AiScaffoldError(e.message, e.httpStatus ?? 400);
    throw e;
  }

  const start = Date.now();
  const session = new ScaffoldSession(input.tenantId);
  session.goal = goal;
  const maxIter = Math.min(input.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS);

  // Cumulative token tracker — emesso al frontend dopo ogni LLM call.
  const tokensCumulative = { input: 0, output: 0 };

  // Synthetic runId per persistere ogni LLM call del wizard scaffold in
  // ai_workflow_calls. Risolve user-segnalato bug "dashboard mostra 0 tokens
  // per wizard": pre-fix il listener accumulava SOLO in memoria + SSE emit
  // verso UI, ma niente persistenza DB → AiUsagePanel cost/byModel non vedevano
  // le call wizard. workflowCallTracker.record() persiste in ai_workflow_calls
  // + aggiorna ai_budget_daily atomicamente nella stessa transaction.
  const scaffoldRunId = `scaffold-${randomUUID()}`;

  // Initial user message — goal + INDEX catalogo + database hint.
  // FIX 2026-05-31 (context overflow, user-segnalato): pre-fix inietavamo
  // catalog full (defId + label + description + ALL fields con constraints
  // + ALL actions community) ~15-20K tokens. Sommato a SYSTEM_PROMPT 8K +
  // history crescente → context overflow Qwen3 40K alla 4-5a iterazione →
  // modello tronca e genera workflow incompleti.
  //
  // Stack 2026 corretto: catalog INDEX (solo defId + type + label, ~3K
  // tokens). Liara chiama list_node_catalog(defId:"X") on-demand per i
  // configFields completi quando deve usare un nodo specifico.
  const catalog = buildNodeCatalog();
  const catalogText = catalog.map((c) =>
    `- ${c.defId} (${c.type}) "${c.label}"`
  ).join('\n');
  // Pre-analisi complessita\` — mostra a Liara cosa il complexity gate ha
  // rilevato nel goal, ANCORA prima della sua prima tool call. Cosi\` il
  // propose_plan iniziale gia\` sa minNodes target invece di scoprirlo via reject.
  const complexity = (await import('./tools/complexity-gate.js')).estimateComplexity(goal);
  const analysisLines: string[] = [
    `PRE-ANALISI DEL GOAL (calcolata server-side):`,
    `  Tier: "${complexity.tier}" — minNodes target: ${complexity.minNodes.toString()}`,
  ];
  if (complexity.matched.actionVerbs.length > 0) {
    analysisLines.push(`  Verbi/azioni rilevate: ${complexity.matched.actionVerbs.join(', ')} → 1 nodo per ognuno`);
  }
  if (complexity.matched.integrations.length > 0) {
    analysisLines.push(`  Integrazioni esterne: ${complexity.matched.integrations.join(', ')} → community_<vendor> o action_http per ognuna`);
  }
  if (complexity.matched.branches.length > 0) {
    analysisLines.push(`  Branching/condizioni: ${complexity.matched.branches.join(', ')} → logic_if/logic_switch + 1 nodo per ramo`);
  }
  if (complexity.matched.documentTypes.length > 0) {
    analysisLines.push(`  Tipi documento elencati: ${complexity.matched.documentTypes.join(', ')} → 1 ramo + relativi action per ognuno`);
  }
  analysisLines.push(`Il tuo propose_plan DEVE coprire ALMENO ${complexity.minNodes.toString()} nodi distinti — uno per ogni entita\` sopra.`);
  const initialUser = [
    `GOAL UTENTE:\n${goal}`,
    `\n${analysisLines.join('\n')}`,
    `\nCATALOGO NODI:\n${catalogText}`,
    input.databaseId ? `\nDB TENANT DISPONIBILE: ${input.databaseId} (usa read_db_schema per leggerlo)` : '\nNESSUN DB CONFIGURATO — non usare db_query/db_insert*.',
    `\nINIZIA: chiama il primo tool. Risposta JSON puro, una tool call alla volta. RICORDA REGOLA 0: il primo tool di mutation DEVE essere propose_plan.`,
  ].join('\n');

  // Conversation history accumulates user + assistant turns. Loop:
  //   1. dispatchLLMChat(history) → model returns one tool call
  //   2. session.execute(tool, args) → server tool result
  //   3. append model's tool call AND tool result to history → loop
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  let iteration = 0;

  // Emit initial event (UI rendering "starting agent...").
  try { await onProgress?.({ type: 'start', goal, maxIter }); } catch { /* never throw on progress */ }

  while (!session.finalized && !session.aborted && iteration < maxIter) {
    iteration++;
    try { await onProgress?.({ type: 'iter_start', iteration, phase: 'llm_call' }); } catch { /* */ }
    // First iteration: no history, pass initialUser. Subsequent: latest user msg = tool result.
    const currentUser = history.length === 0 ? initialUser : history[history.length - 1]!.content;
    const priorHistory = history.length === 0 ? [] : history.slice(0, -1);

    // LLM call with exponential-backoff retry for transient failures.
    // Retry on: 429, 502/503/504, network errors. Skip: 401/403, 4xx other.
    let raw: string;
    let lastCallUsage: { input: number; output: number; fromApi: boolean } | null = null;
    const iterStart = Date.now();
    try {
      raw = await callLlmWithRetry(
        () => dispatchLLMChat(
          resolved.provider, resolved.apiKey, resolved.model,
          pickScaffoldPrompt(resolved.provider), currentUser, undefined, priorHistory,
          (usage) => {
            lastCallUsage = usage;
            tokensCumulative.input += usage.input;
            tokensCumulative.output += usage.output;
          },
        ),
        { maxAttempts: 4, baseDelayMs: 750 },
      );
    } catch (e) {
      // Persisti la call failed PRIMA di throw — utente paga tokens consumati
      // dal provider anche su error, dashboard cost deve riflettere realta\`.
      if (lastCallUsage) {
        const u = lastCallUsage as { input: number; output: number; fromApi: boolean };
        persistScaffoldCall({
          scaffoldRunId,
          iteration,
          provider: resolved.provider,
          model: resolved.model,
          inputTokens: u.input,
          outputTokens: u.output,
          latencyMs: Date.now() - iterStart,
          status: 'error',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
      logger.error(
        { iteration, provider: resolved.provider, err: e instanceof Error ? e.message : String(e) },
        '[SCAFFOLD] LLM provider call failed',
      );
      throw new AiScaffoldError(`LLM provider error iter ${iteration.toString()}: ${e instanceof Error ? e.message : String(e)}`, 502);
    }

    // Persiste token usage nel DB tenant — aggiorna ai_workflow_calls +
    // ai_budget_daily atomicamente (single txn). Dashboard AiUsagePanel
    // legge da qui via /ai-metrics/budget + /ai-metrics/by-model.
    if (lastCallUsage) {
      const u = lastCallUsage as { input: number; output: number; fromApi: boolean };
      persistScaffoldCall({
        scaffoldRunId,
        iteration,
        provider: resolved.provider,
        model: resolved.model,
        inputTokens: u.input,
        outputTokens: u.output,
        latencyMs: Date.now() - iterStart,
        status: 'ok',
      });
    }

    // Emit token usage event SUBITO dopo LLM ok — UI aggiorna counter.
    if (lastCallUsage) {
      try {
        await onProgress?.({
          type: 'token_usage',
          iteration,
          cumulative: { ...tokensCumulative },
          lastCall: lastCallUsage,
        });
      } catch { /* never throw on progress */ }
    }

    // Defensive sanitization: strip residui `<think>...</think>` (e anche
    // un `<think>` aperto ma mai chiuso — Qwen3 hit max_tokens). Il
    // llm-chat dispatcher di solito lo fa, ma per BYOK con baseUrl custom
    // potrebbe NON arrivare a livello dispatcher (gateway-only path).
    raw = raw
      .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim();

    // Truncation detection: tail-shape heuristic. Providers diverge su finishReason exposure.
    const trailingChar = raw.trim().slice(-1);
    const looksTruncated = raw.length > 100 && trailingChar !== '}' && trailingChar !== ']' && !raw.trim().endsWith('}');
    logger.info(
      {
        iteration,
        rawLength: raw.length,
        rawHead: raw.slice(0, 160),
        trailingChar,
        looksTruncated,
      },
      '[SCAFFOLD] iter LLM response',
    );
    if (looksTruncated) {
      try { await onProgress?.({ type: 'llm_retry', iteration, reason: 'truncated', detail: `output ${raw.length.toString()} chars non termina con \`}\`` }); } catch { /* */ }
      history.push({ role: 'assistant', content: raw.slice(0, 500) });
      history.push({ role: 'user', content: `Iter ${iteration.toString()}: output sembra TRONCATO (${raw.length.toString()} chars, non termina con \`}\`). Risposta più CORTA — chiama un solo tool con args minimali. Se serve dividere il lavoro, fai più tool calls invece di una grande.` });
      continue;
    }

    // Parse tool call. Tolerate ```json fences, leading "Sure! Here's..." etc.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    let parsed: { tool?: unknown; args?: unknown };
    try {
      const objMatch = /\{[\s\S]*\}/.exec(cleaned);
      parsed = JSON.parse(objMatch ? objMatch[0] : cleaned) as { tool?: unknown; args?: unknown };
    } catch (e) {
      logger.warn(
        {
          iteration,
          rawHead: raw.slice(0, 160),
          err: e instanceof Error ? e.message : 'parse error',
        },
        '[SCAFFOLD] tool call malformed — instructing retry',
      );
      const errMsg = `Iter ${iteration.toString()}: tool call malformato (JSON non parseable: ${e instanceof Error ? e.message : 'parse error'}). Riprova rispondendo SOLO con {"tool":"<nome>","args":{...}}.`;
      try { await onProgress?.({ type: 'llm_retry', iteration, reason: 'parse_error', detail: e instanceof Error ? e.message : 'parse error' }); } catch { /* */ }
      history.push({ role: 'assistant', content: raw });
      history.push({ role: 'user', content: errMsg });
      continue;
    }
    const tool = typeof parsed.tool === 'string' ? parsed.tool : '';
    const args = (parsed.args && typeof parsed.args === 'object' ? parsed.args : {}) as Record<string, unknown>;
    if (!tool) {
      try { await onProgress?.({ type: 'llm_retry', iteration, reason: 'invalid_tool', detail: 'campo "tool" mancante o non stringa' }); } catch { /* */ }
      history.push({ role: 'assistant', content: raw });
      history.push({ role: 'user', content: `Iter ${iteration.toString()}: campo "tool" mancante. Risposta: {"tool":"<nome>","args":{...}}.` });
      continue;
    }

    try { await onProgress?.({ type: 'tool_call', iteration, tool, args }); } catch { /* */ }
    const toolStart = Date.now();
    const result = await session.execute(tool, args);

    // Emit plan_proposed quando propose_plan ha appena accettato un nuovo plan.
    if (tool === 'propose_plan' && result.ok && session.plan?.accepted) {
      try {
        await onProgress?.({
          type: 'plan_proposed',
          iteration,
          plan: {
            nodes: session.plan.nodes,
            edges: session.plan.edges,
            reasoning: session.plan.reasoning,
          },
        });
      } catch { /* */ }
    }

    try {
      const evt: ScaffoldProgressEvent = { type: 'tool_result', iteration, tool, ok: result.ok, elapsedMs: Date.now() - toolStart };
      if (!result.ok && typeof result.error === 'string') evt.error = result.error.slice(0, 800);
      await onProgress?.(evt);
    } catch { /* */ }
    history.push({ role: 'assistant', content: JSON.stringify({ tool, args }) });
    // Redact sensitive before feeding result back: secrets, base64 payloads, abs paths.
    // "dati sensibili a parte" guard — agent designs but never sees.
    const safeResult = result.ok ? { ok: true, data: redactSensitive(result.data) } : { ok: false, error: redactSensitive(result.error) };
    // Slice 8000 (era 4000) per consentire al propose_plan accepted di
    // ritornare schemas completi di tutti i defId del plan (~150 chars/defId
    // × 20-25 defId = ~3-5K chars). Senza Liara perderebbe gli schemas.
    history.push({ role: 'user', content: `tool_result: ${JSON.stringify(safeResult).slice(0, 8000)}` });
    try { await onProgress?.({ type: 'iter_end', iteration }); } catch { /* */ }
  }

  if (session.aborted) {
    throw new AiScaffoldError(`Agente ha interrotto: ${session.abortReason}`, 502);
  }
  if (!session.finalized) {
    throw new AiScaffoldError(`Agente non ha finalizzato il workflow entro ${maxIter.toString()} iterazioni. Trace: ${session.trace.length.toString()} step. Ultimo tool: ${session.trace[session.trace.length - 1]?.tool ?? 'nessuno'}`, 502);
  }

  // Build canonical Workflow + WorkflowSchema.parse.
  // HIGH (2026-05-29): WorkflowSchema richiede createdAt + updatedAt non-optional
  // (z.string().datetime()). Pre-fix il wfPlain era costruito senza questi campi
  // → ZodError "Required" → 502 "Workflow generato non valido". Popoliamo entrambi
  // col timestamp corrente (workflow appena creato dall'AI scaffold); al POST
  // /workflows il backend potra\` sovrascrivere updatedAt sul save reale.
  const nowIso = new Date().toISOString();
  const wfPlain = {
    schemaVersion: '1.0.0' as const,
    id: session.draft.id,
    name: session.draft.name,
    description: session.draft.description || undefined,
    enabled: false,
    nodes: session.draft.nodes.map((n) => ({
      id: n.id,
      defId: n.defId,
      x: n.position.x,
      y: n.position.y,
      config: n.config,
      ...(n.name ? { name: n.name } : {}),
    })),
    edges: session.draft.edges,
    nodeDefs: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  let workflow: Workflow;
  try {
    workflow = WorkflowSchema.parse(wfPlain);
  } catch (e) {
    logger.warn({ err: e, draft: session.draft }, 'AiScaffold: finalized workflow failed schema validation');
    throw new AiScaffoldError(`Workflow generato non valido secondo lo schema: ${e instanceof Error ? e.message : String(e)}`, 502);
  }

  const notes: string[] = [
    `Modello: ${resolved.provider}/${resolved.model || 'default'}`,
    `Iterazioni agent: ${iteration.toString()} (max ${maxIter.toString()})`,
    `Tool calls eseguiti: ${session.trace.length.toString()}`,
    `Nodi generati: ${workflow.nodes.length.toString()}, edges: ${workflow.edges.length.toString()}`,
    'Workflow NON ancora salvato — rivedi e premi "Importa" per confermare.',
  ];

  const finalResult: AiScaffoldResult = {
    workflow,
    modelUsed: `${resolved.provider}/${resolved.model || 'default'}`,
    durationMs: Date.now() - start,
    iterations: iteration,
    trace: session.trace,
    notes,
  };
  // 2026-05-30: log esplicito completion per debug bug "Stream chiuso
  // senza un risultato" — se NON vediamo questo log, lo scaffold ha
  // ritornato da un path che bypassa il finalize (improbabile dopo
  // i check session.aborted / !session.finalized sopra).
  logger.info(
    {
      iterations: iteration,
      nodes: workflow.nodes.length,
      edges: workflow.edges.length,
      traceLen: session.trace.length,
      durationMs: finalResult.durationMs,
    },
    '[SCAFFOLD] complete — emitting done event',
  );
  try {
    await onProgress?.({ type: 'done', result: finalResult });
  } catch (e) {
    // Se onProgress fallisce (controller chiuso, client disconnect),
    // logghiamo per debug ma non re-throw — finalResult e\` comunque
    // restituito al chiamante non-stream (e.g. test).
    logger.warn(
      { err: e instanceof Error ? e.message : e },
      '[SCAFFOLD] onProgress(done) failed (client disconnect?)',
    );
  }
  return finalResult;
}
