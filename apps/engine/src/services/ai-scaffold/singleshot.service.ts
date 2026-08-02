/**
 * AI Scaffold Single-Shot Service (2026-05-31, stack 2026-grade).
 *
 * Sostituisce il loop iter-based (30-60 iter, 5-15 min, error retry massicci)
 * con UNA chiamata LLM con `guided_json` constraint:
 *   - Liara riceve goal + catalogo + complexity analysis
 *   - Risposta JSON forzata a matchare lo schema workflow completo
 *   - vLLM garantisce parseable + schema-compliant via guided_json
 *   - Server valida config per-defId
 *   - 0 retry loop, 0 parse error, 1 sola chiamata LLM ~30-90s
 *
 * Pattern industriale 2026: structured outputs (OpenAI response_format,
 * Anthropic tool_use strict, vLLM guided_json) — la qualita\` standard quando
 * il modello deve emettere dati strutturati a forma fissa.
 *
 * Benefici vs iter loop:
 *   - 30-60s totale (vs 5-15 min)
 *   - 100% workflow completo (vs ~50% per Enterprise goal)
 *   - 1 LLM call → no contention multi-tenant
 *   - Compatibile con KV cache vLLM (system prompt cachato)
 *   - Liara con LoRA NHA-v3 (futuro) genera output ancora piu\` accurati
 */

import type { z } from 'zod';
import {
  AiScaffoldError,
  type AiScaffoldInput,
  type AiScaffoldTrace,
} from '@/services/ai-scaffold/types.js';
import { type AiScaffoldResult } from '@/services/ai-scaffold/scaffold-runner.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { parseScaffoldJson } from '@/services/ai-scaffold/extract-json.js';
import {
  buildSingleshotPrompt,
  SINGLESHOT_SYSTEM_PROMPT,
  MAX_GOAL_LEN,
} from '@/services/ai-scaffold/prompt.js';
import {
  dispatchLLMChatStructuredStreaming,
  dispatchLLMChatStructured,
} from '@/services/llm-chat.service.js';
import { SingleshotStreamParser } from '@/services/ai-scaffold/singleshot-stream-parser.js';
import { llmQueue, QueueBackpressureError } from '@/services/llm-queue/llm-queue.service.js';
import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';
import {
  autoFixWorkflow,
  isPickerResolvableField,
  MERGE_ORPHAN_ID_RE,
} from '@/services/ai-scaffold/auto-fix.js';
import { isWorkflowCacheWorthy } from '@/services/ai-scaffold/cache-quality.js';
import { serveCachedWorkflow } from '@/services/ai-scaffold/cache.js';
import { validateDataflow } from '@/services/ai-scaffold/dataflow-validator.js';
import {
  applyReachabilityHeal,
  enforceCoverageAndInject,
} from '@/services/ai-scaffold/postprocess.js';
import { applyAutoMapHeuristic } from '@/services/ai-scaffold/auto-map-heuristic.js';
import { healDbTableReferences } from '@/services/ai-scaffold/heal-db-table.js';
import { SINGLESHOT_OUTPUT_SCHEMA, ZodOutputShape } from '@/services/ai-scaffold/schema.js';
import {
  selectScaffoldSchema,
  pickGrammarCatalog,
} from '@/services/ai-scaffold/constrained-schema.js';
import { buildCatalogSpec } from '@/services/ai-scaffold/catalog-spec.js';
import { applyDeterministicAutoConfig } from '@/services/ai-scaffold/semantic-autoconfig.js';
import { runSemanticRepair } from '@/services/ai-scaffold/semantic-repair.js';
import { makeLlmRepairFn } from '@/services/ai-scaffold/make-llm-repair.js';
import { validateArchitecture } from '@/services/ai-scaffold/validate-architecture.js';
import { autoFixInventedDefIds } from '@/services/ai-scaffold/auto-fix-defid.js';
import {
  buildTenantContext,
  formatTenantContextForPrompt,
} from '@/services/ai-scaffold/tenant-context.js';
import {
  captureRejectedScaffold,
  buildNegativeFeedbackBlock,
} from '@/services/ai-scaffold/negative-example.js';
import {
  pickGoldenExample,
  formatGoldenExampleForPrompt,
} from '@/services/ai-scaffold/golden-examples.js';
import { templateCache } from '@/services/ai-scaffold/template-cache/template.service.js';
import { generateEmbedding } from '@/services/ai-scaffold/template-cache/embedding-client.js';
import { workflowCallTracker } from '@/services/ai-budget/workflow-call-tracker.service.js';
import { logger } from '@/lib/logger.js';
import { assembleWorkflow } from '@/services/ai-scaffold/assemble-workflow.js';

export interface SingleshotProgressEvent {
  type:
    | 'start'
    | 'queued'
    | 'analyzing'
    | 'generating'
    | 'validating'
    | 'done'
    | 'error'
    | 'token_usage'
    | 'node_added'
    | 'edge_added'
    | 'meta';
  detail?: string;
  result?: AiScaffoldResult;
  error?: string;
  tokens?: { input: number; output: number; fromApi: boolean };
  /** Per type='queued': posizione + stats coda per UI ETA. */
  queueStats?: { position: number; active: number; queued: number; capacityTotal: number };
  /** Per type='node_added' / 'edge_added': payload streaming. */
  payload?: unknown;
  /** Per type='node_added' / 'edge_added': progressivo (0-based). */
  index?: number;
}
export type SingleshotEmitter = (e: SingleshotProgressEvent) => void | Promise<void>;

/**
 * Public entry — wrapper retry-con-feedback. Se il quality gate rifiuta
 * il primo tentativo per problemi RECUPERABILI (circular ref, mock
 * placeholders, suspicious resource IDs), Liara riceve gli issues + suggest
 * come feedback e RIGENERA fino a 2 retry. Solo se tutti i 3 tentativi
 * falliscono → error utente.
 *
 * Top 2026: la maggior parte dei reject quality-gate sono RECUPERABILI
 * con prompt feedback ("hai usato bucket-name, usa invece {{secrets.X}}").
 * Senza retry, l'utente vede errore subito; con retry, il sistema auto-
 * corregge nel 70-80% dei casi.
 */
const MAX_RETRIES = 2; // 1 tentativo base + 2 retry = max 3 (usato anche da runSingleshotAttempt per il coverage-gate)

export async function runSingleshotScaffold(
  input: AiScaffoldInput,
  onProgress?: SingleshotEmitter,
): Promise<AiScaffoldResult> {
  let lastError: AiScaffoldError | null = null;
  let qualityFeedback = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runSingleshotAttempt(input, qualityFeedback, attempt, onProgress);
    } catch (e) {
      if (!(e instanceof AiScaffoldError)) throw e;
      // Recoverable solo per quality gate reject (codice messaggio identificabile)
      const isQualityGateReject = e.message.startsWith('Workflow rejected — quality gate');
      if (!isQualityGateReject || attempt >= MAX_RETRIES) {
        if (attempt > 0) {
          logger.warn(
            { attempts: attempt + 1, lastErr: e.message.slice(0, 200) },
            '[SINGLESHOT] exhausted retries',
          );
        }
        throw e;
      }
      lastError = e;
      // Estrai issues dal messaggio per feedback al next prompt
      qualityFeedback = e.message;
      logger.info(
        { attempt: attempt + 1, max: MAX_RETRIES + 1, feedbackLen: qualityFeedback.length },
        '[SINGLESHOT] quality gate reject → retry with feedback',
      );
      try {
        await onProgress?.({
          type: 'analyzing',
          detail: `Workflow rifiutato (${(attempt + 1).toString()}/3). Liara sta correggendo automaticamente...`,
        });
      } catch {
        /* graceful */
      }
    }
  }
  // Unreachable but typescript-safe
  throw lastError ?? new AiScaffoldError('Singleshot failed without specific error', 500);
}

async function runSingleshotAttempt(
  input: AiScaffoldInput,
  qualityFeedback: string,
  attemptIdx: number,
  onProgress?: SingleshotEmitter,
): Promise<AiScaffoldResult> {
  logger.info(
    { tenantId: input.tenantId, goalLen: input.goal.length, attempt: attemptIdx + 1 },
    '[SINGLESHOT] attempt start',
  );
  const goal = input.goal.trim();
  if (goal.length < 5) throw new AiScaffoldError('Obiettivo troppo corto.', 400);
  if (goal.length > MAX_GOAL_LEN)
    throw new AiScaffoldError(
      `Obiettivo troppo lungo (max ${MAX_GOAL_LEN.toString()} caratteri).`,
      400,
    );

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
  // RAG Fase 2 (2026-06-12): invece del catalogo COMPLETO (~16k token, scala
  // male) il prompt riceve i nodi RILEVANTI al goal (core + retrieval, coi
  // campi config). Fail-soft: retrieval giù → undefined → buildSingleshotPrompt
  // ricade sul catalogo completo (comportamento storico). Mai peggio di prima.
  let scaffoldCatalogText: string | undefined;
  // defId del subset RAG (core + retrieved): usati per restringere la grammatica
  // vincolata (#1) agli stessi nodi del prompt → grammatica piccola + steering.
  let scaffoldSubsetDefIds: Set<string> | undefined;
  try {
    const { buildScaffoldCatalogEntries, formatScaffoldCatalogEntries } =
      await import('@/services/catalog-retrieval/scaffold-catalog.js');
    const subsetEntries = await buildScaffoldCatalogEntries(input.tenantId, goal);
    scaffoldCatalogText = formatScaffoldCatalogEntries(subsetEntries);
    scaffoldSubsetDefIds = new Set(subsetEntries.map((e) => e.defId));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), tenantId: input.tenantId },
      '[SINGLESHOT] catalog retrieval failed — fallback catalogo completo',
    );
  }
  let userPrompt = buildSingleshotPrompt(goal, input.databaseId ?? null, scaffoldCatalogText);

  // Layer A — Context injection PRE-LLM (2026-05-31): leggo le risorse
  // REALI del tenant (databases, email accounts) e le iniettiamo nel
  // prompt. Cosi\` Liara usa UUID reali invece di inventare "db_opportunities"
  // o "email-account-1". Graceful: se la query fallisce, prosegue senza.
  //
  // ALSO: il default LLM provider del tenant viene catturato qui in modo da
  // poterlo passare al Layer C auto-fix (provider-normalization) senza una
  // seconda query db. Stays null when buildTenantContext fails.
  let tenantDefaultLlmProvider: string | null = null;
  let tenantDatabases: readonly {
    id: string;
    tables: readonly string[];
    columns?: Readonly<Record<string, readonly string[]>>;
    writable: boolean;
  }[] = [];
  try {
    const tenantCtx = buildTenantContext(input.tenantId);
    tenantDefaultLlmProvider = tenantCtx.defaultLlmProvider;
    tenantDatabases = tenantCtx.databases.map((d) => ({
      id: d.id,
      tables: d.tables,
      columns: d.columns,
      writable: d.writable,
    }));
    const ctxBlock = formatTenantContextForPrompt(tenantCtx);
    if (ctxBlock) {
      userPrompt = `${userPrompt}\n\n${ctxBlock}`;
      logger.info(
        {
          tenantId: input.tenantId,
          databases: tenantCtx.databases.length,
          emailAccounts: tenantCtx.emailAccounts.length,
          defaultLlmProvider: tenantCtx.defaultLlmProvider,
        },
        '[SINGLESHOT] tenant-context injected',
      );
    }
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e) },
      '[SINGLESHOT] tenant-context build failed (graceful)',
    );
  }

  // Negative-example REUSE (gap #10, metà mancante): gli errori frequenti dei
  // reject PASSATI del tenant entrano nel prompt come "non ripeterli" — il
  // modello impara dalla storia, non solo dal retry corrente. Fail-soft.
  try {
    const negBlock = buildNegativeFeedbackBlock(input.tenantId);
    if (negBlock) {
      userPrompt = `${userPrompt}\n\n${negBlock}`;
      logger.info(
        { tenantId: input.tenantId, blockLen: negBlock.length },
        '[SINGLESHOT] negative-feedback block injected',
      );
    }
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e) },
      '[SINGLESHOT] negative block failed (graceful)',
    );
  }

  // Auto-retry feedback injection (2026-05-31): se il quality gate ha
  // rifiutato un tentativo precedente, inietto gli issues + suggest al
  // LLM cosi\` corregge invece di ripetere lo stesso errore.
  if (qualityFeedback && attemptIdx > 0) {
    userPrompt = `${userPrompt}

### ⚠️ TENTATIVO PRECEDENTE RIFIUTATO — APPLICA QUESTI FIX

Il tuo output precedente e\` stato bloccato dal quality gate. Issues:

${qualityFeedback}

REGOLE FERREE per questo retry:
1. NON ripetere gli stessi errori sopra
2. Se un campo deve avere un ID risorsa che non conosci → usa \`{{secrets.NOME_DESCRITTIVO}}\` (l'utente lo configurera\`)
3. Se serve un URL/email/host che non conosci → usa \`{{secrets.X}}\` MAI placeholder come "company.com" o "bucket-name"
4. Per CIRCULAR_REFERENCE: rivedi il DAG. Se nodo X usa \`{{$node.Y.json}}\`, allora Y DEVE essere upstream di X (esiste edge Y → ... → X)
5. Per DUPLICATE_NODES: NON copy-paste lo stesso nodo N volte. Mettilo UNA volta dopo lo switch (post-merge)
6. Per SUSPICIOUS_RESOURCE_ID: campi tipo databaseId/systemAccountId NON accettano nomi inventati — usa \`{{secrets.X}}\`

Rigenera ORA applicando i fix.`;
    logger.info(
      { attemptIdx, feedbackLen: qualityFeedback.length },
      '[SINGLESHOT] injecting quality-gate retry feedback',
    );
  }

  try {
    await onProgress?.({ type: 'start' });
  } catch {
    /* */
  }

  // ─── TEMPLATE CACHE (Livello 1) — check before LLM ───
  // Retrieve best matching template; se score >= 0.90 → return cached
  // (zero LLM call, ~50ms). BGE-M3 embedding generato sync per cosine
  // signal accurato — graceful degrade (cosine=0) se embed server down.
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await generateEmbedding(goal);
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e) },
      '[SINGLESHOT] embedding failed (graceful)',
    );
  }
  let cacheRetrieve: ReturnType<typeof templateCache.retrieve> = null;
  try {
    cacheRetrieve = templateCache.retrieve({ promptText: goal, queryEmbedding });
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[SINGLESHOT] template-cache retrieve failed (non-fatal)',
    );
  }

  if (cacheRetrieve?.action === 'use_direct') {
    logger.info(
      {
        templateId: cacheRetrieve.template.id,
        score: cacheRetrieve.score,
        signals: cacheRetrieve.signals,
      },
      '[SINGLESHOT] template cache hit — bypass LLM',
    );
    const cached = serveCachedWorkflow(cacheRetrieve, goal, start);
    if (cached) {
      try {
        await onProgress?.({ type: 'done', result: cached });
      } catch {
        /* */
      }
      return cached;
    }
    cacheRetrieve = null; // evicted/parse-fail → non usarlo nemmeno per few-shot
  }

  const analyzeStart = Date.now();
  try {
    await onProgress?.({ type: 'analyzing', detail: 'Analizzo il goal e seleziono i nodi…' });
  } catch {
    /* */
  }

  // Few-shot injection: se cache match 0.70-0.90 → mostra il template come
  // "ESEMPIO" al LLM. Riduce hallucination + accelera convergence.
  if (cacheRetrieve?.action === 'inject_fewshot') {
    logger.info(
      { templateId: cacheRetrieve.template.id, score: cacheRetrieve.score },
      '[SINGLESHOT] template cache match → few-shot inject',
    );
    userPrompt = `${userPrompt}\n\n### ESEMPIO DI WORKFLOW SIMILE (gia\` validato, usa come riferimento STRUTTURALE — adatta ai dettagli del goal corrente):\n\`\`\`json\n${cacheRetrieve.template.workflowJson}\n\`\`\`\nProduci un workflow NUOVO ispirato all'esempio ma specifico al goal.`;
  } else {
    // COLD START (P5 audit RAG): cache vuota o nessun match → few-shot dalla
    // libreria GOLD curata (5 pattern canonici validati in CI contro il
    // catalogo reale). Nessun pattern affine → nessun esempio (mai fuorviare).
    const gold = pickGoldenExample(goal);
    if (gold) {
      logger.info({ goldId: gold.id }, '[SINGLESHOT] cold start → golden example inject');
      userPrompt = `${userPrompt}\n\n${formatGoldenExampleForPrompt(gold)}`;
    }
  }

  // ── QUEUE phase ──────────────────────────────────────────────────────
  // Per-tenant fair scheduling via llmQueue (P1 workflow). Multi-utenti
  // concorrenti sullo stesso tenant → fair lane per-user (max 20 in coda
  // per-user, 100 totale). Sopra → 429 QueueBackpressureError con
  // Retry-After. Position emessa via SSE per UX.
  const queueBeforeStats = llmQueue.stats();
  const positionEstimate = queueBeforeStats.active + queueBeforeStats.queued + 1;
  if (positionEstimate > queueBeforeStats.concurrencyMax) {
    try {
      await onProgress?.({
        type: 'queued',
        detail: `In coda — posizione ${positionEstimate.toString()}, attesa stimata ${Math.ceil((positionEstimate - queueBeforeStats.concurrencyMax) * 60).toString()}s`,
        queueStats: {
          position: positionEstimate,
          active: queueBeforeStats.active,
          queued: queueBeforeStats.queued,
          capacityTotal: queueBeforeStats.capacityTotal,
        },
      });
    } catch {
      /* */
    }
  }

  const analyzeMs = Date.now() - analyzeStart;
  const generateStart = Date.now();
  try {
    await onProgress?.({
      type: 'generating',
      detail: 'Liara sta generando il workflow completo (1 sola chiamata)…',
    });
  } catch {
    /* */
  }

  logger.info(
    { provider: resolved.provider, promptLen: userPrompt.length, queueStats: queueBeforeStats },
    '[SINGLESHOT] dispatching LLM call (queued)',
  );
  const dispatchStart = Date.now();

  // Catalog costruito UNA volta: alimenta sia la grammatica vincolata (sotto)
  // sia la post-validation per-defId (più giù) — niente doppio build.
  const catalog = buildNodeCatalog();
  // #1 Constrained decoding per-tipo-nodo: per Liara (dietro flag) usa la
  // grammatica guided_json che vincola defId/chiavi/enum a decode-time; altrimenti
  // schema statico. La grammatica è costruita sul SUBSET RAG (stessi nodi del
  // prompt) — non sul full-catalog (proven: degrada la scelta del nodo). Fallback
  // sicuro incorporato (subset assente/vuoto → full; vedi pickGrammarCatalog).
  const grammarCatalog = pickGrammarCatalog(catalog, scaffoldSubsetDefIds);
  const { schema: outputSchema, constrained: constrainedSchema } = selectScaffoldSchema(
    grammarCatalog,
    resolved.provider,
    SINGLESHOT_OUTPUT_SCHEMA,
  );
  if (constrainedSchema) {
    logger.info(
      { branches: grammarCatalog.length, fullCatalog: catalog.length },
      '[SINGLESHOT] guided_json grammar VINCOLATA sul subset RAG',
    );
  }

  let rawJson: string;
  let usage: { input: number; output: number; fromApi: boolean } = {
    input: 0,
    output: 0,
    fromApi: false,
  };
  try {
    // Plan tier dal env container (settato a provision dal portal — vedi
    // onboarding.ts buildEnv "zeliai.plan label"). Free → priorita\` bassa,
    // Enterprise → priorita\` alta. Privilegia paying customers.
    const planTierRaw = (process.env.MEDEA_PLAN_CODE ?? 'pro').toLowerCase();
    const validTiers = ['free', 'starter', 'pro', 'team', 'enterprise'] as const;
    type Tier = (typeof validTiers)[number];
    const planTier: Tier = (validTiers as readonly string[]).includes(planTierRaw)
      ? (planTierRaw as Tier)
      : 'pro';

    // STREAMING vLLM: parser incrementale emette `node_added` SSE man
    // mano che la response arriva → UI vede nodi accendersi uno a uno
    // (no piu\` "67% per 100s poi tutto insieme").
    // Per BYOK non-Liara, dispatchLLMChatStructuredStreaming fallback a
    // non-stream (un singolo chunk finale) — comportamento legacy.
    const parser = new SingleshotStreamParser({
      onMeta: (meta) => {
        try {
          void onProgress?.({ type: 'meta', detail: JSON.stringify(meta) });
        } catch {
          /* */
        }
      },
      onNodeAdded: (node, idx) => {
        try {
          void onProgress?.({ type: 'node_added', payload: node, index: idx });
        } catch {
          /* */
        }
      },
      onEdgeAdded: (edge, idx) => {
        try {
          void onProgress?.({ type: 'edge_added', payload: edge, index: idx });
        } catch {
          /* */
        }
      },
    });

    // Wrap dispatch in llmQueue for per-tenant fair scheduling + backpressure.
    rawJson = await llmQueue.enqueue<string>({
      userId: input.tenantId,
      source: 'workflow',
      planTier,
      runner: () =>
        dispatchLLMChatStructuredStreaming(
          resolved.provider,
          resolved.apiKey,
          resolved.model,
          SINGLESHOT_SYSTEM_PROMPT,
          userPrompt,
          undefined,
          [],
          outputSchema,
          (chunk) => {
            parser.feed(chunk);
          },
          (u) => {
            usage = u;
          },
        ),
    });
    logger.info(
      { rawLen: rawJson.length, durationMs: Date.now() - dispatchStart, usage },
      '[SINGLESHOT] LLM response received',
    );
  } catch (e) {
    if (e instanceof QueueBackpressureError) {
      logger.warn({ retryAfterMs: e.retryAfterMs }, '[SINGLESHOT] queue backpressure');
      throw new AiScaffoldError(
        `Coda LLM piena (capacita\` ${queueBeforeStats.capacityTotal.toString()}). Riprova tra ${Math.ceil(e.retryAfterMs / 1000).toString()}s.`,
        429,
      );
    }
    logger.error(
      { err: e instanceof Error ? e.message : String(e), durationMs: Date.now() - dispatchStart },
      '[SINGLESHOT] LLM dispatch failed',
    );
    throw new AiScaffoldError(
      `LLM single-shot fallito: ${e instanceof Error ? e.message : String(e)}`,
      502,
    );
  }

  const generateMs = Date.now() - generateStart;
  try {
    await onProgress?.({ type: 'token_usage', tokens: usage });
  } catch {
    /* */
  }

  // Persisti la call nel daily budget. Senza questa write i token del wizard
  // AI non comparirebbero nel pannello "Utilizzo AI" della dashboard (era
  // bug 2026-05-31 user-segnalato: "Token=0 nonostante wizard usato"). Marcato
  // come source='chat' perche\` il wizard e\` un'azione interattiva dell'editor,
  // non eseguito da un nodo workflow.
  try {
    workflowCallTracker.recordChatBudget({
      provider: resolved.provider,
      model: resolved.model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      isError: false,
    });
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[SINGLESHOT] recordChatBudget failed (non-fatal)',
    );
  }

  const validateStart = Date.now();
  try {
    await onProgress?.({ type: 'validating', detail: 'Validazione output + config per-defId…' });
  } catch {
    /* */
  }

  // Parse + Zod validate (guided_json garantisce JSON valido ma Zod e\` il
  // contratto runtime di FlowForge — backstop per edge case schema-divergent).
  let parsed: z.infer<typeof ZodOutputShape>;
  try {
    // Tollerante ai fence ```json/prosa: guided_json (Liara/vLLM) dà JSON puro,
    // ma i BYOK (Anthropic/OpenAI…) avvolgono in ```json → estrazione robusta.
    const obj = parseScaffoldJson(rawJson);
    parsed = ZodOutputShape.parse(obj);
  } catch (err: unknown) {
    throw new AiScaffoldError(
      `Output del modello non conforme allo schema: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  // Per-defId config validation usando lo stesso pattern del add_node handler.
  // `catalog` già costruito prima del dispatch (riuso, no doppio build).
  const knownDefIds = new Set(catalog.map((c) => c.defId));

  // ─── Pre-validation: rimap defId inventati con suffix → base catalog ───
  // Bug user 2026-05-31: Liara generava action_http_clearbit, action_http_hunter,
  // action_json_extract_sender, action_json_extract_domain → 5 errori validation.
  // Strip progressivo del suffix se base catalog esiste. NON-disruptive
  // (community_*/trigger_* skippati, min 2 parts garantito).
  const defIdFixResult = autoFixInventedDefIds(
    { nodes: parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })) },
    knownDefIds,
  );
  if (defIdFixResult.appliedFixes.length > 0) {
    logger.info(
      {
        fixes: defIdFixResult.appliedFixes.length,
        fixesDetail: defIdFixResult.appliedFixes.map((f) => `${f.before}→${f.after}`),
        goal: goal.slice(0, 120),
      },
      '[SINGLESHOT] auto-fix defId inventati',
    );
    const fixedById = new Map(defIdFixResult.nodes.map((n) => [n.id, n.defId]));
    for (const n of parsed.nodes) {
      const newDefId = fixedById.get(n.id);
      if (newDefId) n.defId = newDefId;
    }
  }

  // ─── #8 AUTO-CONFIG DETERMINISTICA — il codice riempie la meccanica ───
  // PRIMA della validazione required: riempie i campi mancanti dai defaultValue
  // del NodeDef (mai i secret) e normalizza il case degli enum ("get"→"GET").
  // Behavior-preserving (il default è il valore che il nodo userebbe comunque)
  // → evita 502 evitabili. Ciò che NON ha default (es. `url`) resta alla
  // validazione/repair. Default-ON, vale per tutti i provider.
  const autoConfigSpec = buildCatalogSpec(catalog);
  const autoConfig = applyDeterministicAutoConfig(
    parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    autoConfigSpec,
  );
  if (autoConfig.applied.length > 0) {
    const filledById = new Map(autoConfig.nodes.map((n) => [n.id, n.config]));
    for (const n of parsed.nodes) {
      const cfg = filledById.get(n.id);
      if (cfg) n.config = cfg;
    }
    logger.info(
      {
        fixes: autoConfig.applied.length,
        types: autoConfig.applied.reduce<Record<string, number>>((acc, f) => {
          acc[f.kind] = (acc[f.kind] ?? 0) + 1;
          return acc;
        }, {}),
      },
      '[SINGLESHOT] auto-config deterministica (fill default + normalize enum)',
    );
  }

  // ─── #8 strato B — VALIDATORE → RIPARAZIONE LLM (flag-gated, default OFF) ───
  // Ciò che il deterministico non può completare (un required di CONTENUTO senza
  // default, es. `url`) viene riparato con una chiamata LLM MIRATA ai soli nodi
  // rotti, coi messaggi precisi del validatore. Bounded (1 round). Fail-soft: se
  // il repair non risolve, la validazione sotto darà il 502 con i dettagli.
  if (process.env.MEDEA_SCAFFOLD_SEMANTIC_REPAIR === 'true') {
    const repairFn = makeLlmRepairFn({
      goal,
      dispatch: ({ system, user, schema }) =>
        dispatchLLMChatStructured(
          resolved.provider,
          resolved.apiKey,
          resolved.model,
          system,
          user,
          undefined,
          [],
          schema,
        ),
    });
    const repaired = await runSemanticRepair(
      parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
      { catalog, repair: repairFn, maxRounds: 1 },
    );
    if (repaired.rounds > 0) {
      const repairedById = new Map(repaired.nodes.map((n) => [n.id, n.config]));
      for (const n of parsed.nodes) {
        const cfg = repairedById.get(n.id);
        if (cfg) n.config = cfg;
      }
      logger.info(
        {
          rounds: repaired.rounds,
          remaining: repaired.remaining.length,
          deterministicFixes: repaired.applied.length,
        },
        '[SINGLESHOT] semantic-repair (validatore→repair LLM)',
      );
    }
  }

  const issues: string[] = [];
  const healedPickerFields: string[] = [];
  for (const n of parsed.nodes) {
    const entry = catalog.find((c) => c.defId === n.defId);
    if (!entry) {
      issues.push(`Nodo ${n.id}: defId "${n.defId}" non nel catalogo`);
      continue;
    }
    for (const field of entry.fields) {
      const v = n.config[field.key];
      if ((v === undefined || v === '') && field.required) {
        // HEAL (bug diretta YouTube 2026-06-12): un REQUIRED *omesso* ma
        // risolvibile da picker UI (databaseId/table/…) NON è fatale — è lo
        // STESSO caso del valore fittizio che il Layer C sana con
        // __USE_PICKER__. Ma il Layer C gira DOPO questa validazione, quindi
        // l'omissione 502ava un workflow sanabile (caso db_insert senza
        // databaseId, goal "Triage ticket supporto"). Il marker va iniettato
        // QUI; la UI forza il dropdown pre-import, quality-gate e
        // heal-db-table lo skippano già per contratto.
        if (isPickerResolvableField(field.key, field.type)) {
          n.config[field.key] = '__USE_PICKER__';
          healedPickerFields.push(`${n.id}.${field.key}`);
          continue;
        }
        issues.push(`Nodo ${n.id} (${n.defId}): field REQUIRED "${field.key}" mancante`);
      }
    }
  }
  if (healedPickerFields.length > 0) {
    logger.info(
      { healed: healedPickerFields, goal: goal.slice(0, 120) },
      '[SINGLESHOT] heal: required picker-resolvable mancanti → __USE_PICKER__',
    );
  }
  // Edges referenziano nodi esistenti.
  // ECCEZIONE: un edge verso/da un nodo "merge"/"join" MANCANTE NON è errore
  // fatale — l'auto-fix Layer C (sotto) lo CREA come logic_merge prima del
  // quality-gate. Senza, lo scaffold 502ava su un workflow che l'auto-fix
  // avrebbe sanato (l'LLM referenzia spesso il merge senza emetterlo —
  // bug "Sitemap Crawler" 2026-06-10). Stesso pattern usato dall'orphan-heal.
  const nodeIds = new Set(parsed.nodes.map((n) => n.id));
  for (const e of parsed.edges) {
    if (!nodeIds.has(e.from) && !MERGE_ORPHAN_ID_RE.test(e.from))
      issues.push(`Edge from="${e.from}" non riferisce un nodo`);
    if (!nodeIds.has(e.to) && !MERGE_ORPHAN_ID_RE.test(e.to))
      issues.push(`Edge to="${e.to}" non riferisce un nodo`);
  }

  // ─── ARCHITECTURAL VALIDATION — 4 check anti-bug (vedi validate-architecture.ts) ───
  issues.push(...validateArchitecture(parsed.nodes, parsed.edges, catalog));

  if (issues.length > 0) {
    logger.warn({ issues, goal: goal.slice(0, 200) }, '[SINGLESHOT] validation issues');
    throw new AiScaffoldError(
      `Workflow generato con ${issues.length.toString()} errori di validazione:\n${issues.slice(0, 10).join('\n')}${issues.length > 10 ? `\n…+${(issues.length - 10).toString()} altri` : ''}`,
      502,
    );
  }

  // ─── Layer C — AUTO-FIX TRIVIALI (2026-05-31) ───
  // PRIMA del quality gate, applica sostituzioni 100% safe:
  // - Pattern placeholder (smtp.example, bucket-name, noreply@company.com)
  //   → {{secrets.NOME_DESCRITTIVO}}
  // - ID risorsa fittizi (databaseId="db_X", systemAccountId="email-account-1")
  //   → __USE_PICKER__ (UI mostra dropdown forzato pre-import)
  // - Nodi duplicati con config identica → merge a 1, re-route edges
  //
  // Riduce ~30-40% i reject quality gate downstream (i pattern triviali
  // vengono auto-corretti senza retry LLM costoso).
  const autoFixResult = autoFixWorkflow({
    nodes: parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    edges: parsed.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.fromPort ? { fromPort: e.fromPort } : {}),
    })),
    tenantDefaultLlmProvider,
  });
  if (autoFixResult.appliedFixes.length > 0) {
    logger.info(
      {
        fixes: autoFixResult.appliedFixes.length,
        types: autoFixResult.appliedFixes.reduce<Record<string, number>>((acc, f) => {
          acc[f.type] = (acc[f.type] ?? 0) + 1;
          return acc;
        }, {}),
      },
      '[SINGLESHOT] auto-fix applied',
    );
    // Sostituisci parsed con post-fix data (struttura: id/defId/config + edges)
    // Mantieni i fields extra (x, y, label) — auto-fix preserva il resto
    const nodesById = new Map(parsed.nodes.map((n) => [n.id, n]));
    const fixedNodesById = new Map(autoFixResult.nodes.map((n) => [n.id, n]));
    // Rimuovi nodi che auto-fix ha eliminato
    parsed.nodes = parsed.nodes
      .filter((n) => fixedNodesById.has(n.id))
      .map((n) => {
        const fixed = fixedNodesById.get(n.id);
        if (!fixed) return n;
        // Propaga ANCHE il defId: l'auto-fix può correggerlo (es. §2.6
        // code-node language heal action_run_js→action_run_python). Pre-fix il
        // merge-back copiava solo `config`, scartando la correzione di defId →
        // il quality-gate vedeva ancora il defId sbagliato e rigettava.
        return { ...n, defId: fixed.defId, config: fixed.config };
      });
    // FIX 2026-06-10: aggiungi i nodi CREATI dall'auto-fix (es. logic_merge da
    // orphan-heal o fan-in) che non erano nell'output LLM. Pre-fix il merge-back
    // mappava solo i nodi esistenti → il merge nuovo veniva droppato MA gli edge
    // verso di lui restavano → "edge orfani" → save 500. Posizione di default
    // (l'editor auto-layout li sistema).
    for (const fixedNode of autoFixResult.nodes) {
      if (nodesById.has(fixedNode.id)) continue;
      parsed.nodes.push({
        id: fixedNode.id,
        defId: fixedNode.defId,
        config: fixedNode.config,
        x: 0,
        y: 0,
      });
    }
    // Sostituisci edges con quelli post-fix (deduplicati + rerouting)
    const originalEdgesByKey = new Map(parsed.edges.map((e) => [`${e.from}->${e.to}`, e]));
    parsed.edges = autoFixResult.edges.map((e) => {
      const orig = originalEdgesByKey.get(`${e.from}->${e.to}`);
      return orig ?? { from: e.from, to: e.to };
    });
    nodesById.clear();
  }

  // ─── AUTO-HEAL DATA-FLOW (l'AUTOMAZIONE) — collega i nodi referenziati ma non
  // a monte (vedi postprocess.ts). Muta parsed.edges in place.
  applyReachabilityHeal(parsed);

  // ─── GAP 1 (e): AUTO-MAP — edge produttore-lista → consumatore-single-item
  // ottengono mapMode='auto' (fan-out per-item visibile, badge ×N nell'editor).
  // DOPO il reachability-heal così copre anche gli edge appena creati.
  // Euristica deterministica conservativa (whitelist) — vedi auto-map-heuristic.ts.
  const autoMapNotes = applyAutoMapHeuristic(parsed);
  if (autoMapNotes.length > 0) {
    logger.info({ autoMapNotes }, '[SINGLESHOT] auto-map: fan-out per-item attivato');
  }

  // ─── AUTO-HEAL DB-TABLE (l'AUTOMAZIONE) — se un db_insert/update scrive colonne
  // che NON matchano la tabella (Liara ha RICICLATO una tabella scollegata, es.
  // `orders` per dati prezzo), ripunta alla tabella giusta o ne CREA una dedicata.
  // Becca il bug reale Anti-fraud (nicola-cucurachi). Muta parsed in place.
  // SOLO DB locali scrivibili: lo heal ripunta SCRITTURE (db_insert/update) e crea
  // tabelle → mai contro un DB esterno read-only (es. NHA). Senza questo filtro lo
  // heal poteva ripuntare una scrittura a una tabella remota con colonne combacianti.
  const dbHeal = healDbTableReferences(
    parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    tenantDatabases
      .filter((d) => d.writable && d.columns)
      .map((d) => ({ id: d.id, columns: d.columns as Record<string, string[]> })),
    goal,
  );
  if (dbHeal.tablesToCreate.length > 0) {
    parsed.tablesToCreate = [
      ...(parsed.tablesToCreate ?? []),
      ...dbHeal.tablesToCreate,
    ] as typeof parsed.tablesToCreate;
    logger.info(
      { created: dbHeal.tablesToCreate.map((t) => t.name) },
      '[SINGLESHOT] db-table heal: tabelle dedicate create',
    );
  }

  // ─── QUALITY GATE (anti-workflow-merdosi) ───
  // 7 rules: circular ref, mock placeholder, switch no default,
  // dead-end branch, orphan trigger, duplicate nodes, suspicious resource id.
  // Critical → reject (Layer B retry kicks in).
  // Vedi `quality-gate.ts`.
  // Le tabelle in tablesToCreate (dichiarate dalla LLM + create dall'auto-heal)
  // ESISTERANNO dopo l'import → il gate (DB_TABLE/DB_COLUMN) deve vederle come
  // presenti, altrimenti rigetta una tabella che il workflow stesso crea.
  const declaredTables = parsed.tablesToCreate ?? [];
  const augmentedDatabases =
    declaredTables.length === 0
      ? tenantDatabases
      : tenantDatabases.map((d) => {
          const cols: Record<string, string[]> = Object.fromEntries(
            Object.entries(d.columns ?? {}).map(([k, v]) => [k, [...v]]),
          );
          const tbls = [...d.tables];
          for (const t of declaredTables) {
            if (t.databaseId && t.databaseId !== d.id) continue;
            tbls.push(t.name);
            cols[t.name] = t.columns.map((c) => c.name);
          }
          return { id: d.id, tables: tbls, columns: cols };
        });
  const qualityResult = runQualityGate({
    nodes: parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    edges: parsed.edges.map((e) => ({ from: e.from, to: e.to })),
    databases: augmentedDatabases,
  });
  if (qualityResult.shouldReject) {
    const criticalIssues = qualityResult.issues.filter((i) => i.severity === 'critical');
    const mediumIssues = qualityResult.issues.filter((i) => i.severity === 'medium');
    logger.warn(
      {
        criticalCount: criticalIssues.length,
        mediumCount: mediumIssues.length,
        goal: goal.slice(0, 200),
      },
      '[SINGLESHOT] quality gate rejected',
    );
    // Negative-example learning (gap #10): registra il reject SOLO se è quello
    // FINALE (retry esauriti) — i reject intermedi vengono auto-corretti, non
    // sono negative genuini. Fail-soft: la cattura non altera il 502.
    if (attemptIdx >= MAX_RETRIES) {
      captureRejectedScaffold({
        tenantId: input.tenantId,
        goal,
        rejectedWorkflow: { nodes: parsed.nodes, edges: parsed.edges },
        criticalIssues: criticalIssues.map((i) => ({ code: i.code, message: i.message })),
        model: resolved.model,
        latencyMs: Date.now() - start,
      });
    }
    const msg = criticalIssues
      .slice(0, 5)
      .map((i) => `• [${i.code}] ${i.message}`)
      .join('\n');
    throw new AiScaffoldError(
      `Workflow rejected — quality gate ha trovato ${criticalIssues.length.toString()} bug critici:\n${msg}${criticalIssues.length > 5 ? `\n…+${(criticalIssues.length - 5).toString()} altri` : ''}\n\nRiprova con prompt piu\` dettagliato (es. specifica SMTP host reale, destinazioni Notion/CRM concrete, default branch per logic_switch).`,
      502,
    );
  }
  const qualityWarnings = qualityResult.issues.filter((i) => i.severity === 'medium');

  // ─── REQUIREMENT-COVERAGE ENFORCEMENT — il workflow deve FARE quello che è
  // chiesto (vedi postprocess.ts). Reject+retry se manca una capability con nodo
  // reale; all'ultimo tentativo la INIETTA invece di avvisare. Muta parsed.
  const coverageWarnings = enforceCoverageAndInject(parsed, goal, attemptIdx >= MAX_RETRIES);

  // Build canonical Workflow (parsed→Workflow, firma stretta — vedi assemble-workflow.ts)
  const workflow = assembleWorkflow(parsed);

  const durationMs = Date.now() - start;
  const validateMs = Date.now() - validateStart;

  // Trace 3-step: 1 row per fase (analyze / generate / validate) — la UI
  // mostra "01 🧠 Analisi · 02 ✨ Generazione · 03 🛡 Validazione" con
  // elapsedMs reale per fase. Pre-fix: 1 sola row generate con tutto il
  // tempo cumulato → UX rotta + percezione "non sta facendo nulla".
  const trace: AiScaffoldTrace[] = [
    {
      step: 1,
      tool: 'singleshot_analyze',
      args: { goal: goal.slice(0, 200) },
      result: { ok: true, data: { promptLen: userPrompt.length } },
      elapsedMs: analyzeMs,
    },
    {
      step: 2,
      tool: 'singleshot_generate',
      args: { provider: resolved.provider, model: resolved.model || 'default' },
      result: {
        ok: true,
        data: { rawLen: rawJson.length, tokensIn: usage.input, tokensOut: usage.output },
      },
      elapsedMs: generateMs,
    },
    {
      step: 3,
      tool: 'singleshot_validate',
      args: { rules: 'zod+arch+quality-gate' },
      result: {
        ok: true,
        data: {
          nodes: workflow.nodes.length,
          edges: workflow.edges.length,
          warnings: qualityWarnings.length,
        },
      },
      elapsedMs: validateMs,
    },
  ];

  // Warning lines: medium issues vanno in notes (utente vede, non bloccanti)
  const warningLines =
    qualityWarnings.length > 0
      ? [
          `Quality gate: ${qualityWarnings.length.toString()} warning (non bloccanti):`,
          ...qualityWarnings
            .slice(0, 6)
            .map((w) => `  • [${w.code}] ${w.nodeId ? `${w.nodeId}: ` : ''}${w.message}`),
        ]
      : [];

  const tablesToCreate = parsed.tablesToCreate ?? [];
  const tablesNotesLines =
    tablesToCreate.length > 0
      ? [
          `🆕 Nuove tabelle DB richieste: ${tablesToCreate.map((t) => t.name).join(', ')} — verranno create all'import.`,
        ]
      : [];

  const finalResult: AiScaffoldResult = {
    workflow,
    modelUsed: `${resolved.provider}/${resolved.model || 'default'}+guided_json`,
    durationMs,
    iterations: 3,
    trace,
    notes: [
      `Modello: ${resolved.provider}/${resolved.model || 'default'} (single-shot guided_json)`,
      `Durata: ${(durationMs / 1000).toFixed(1)}s (analyze ${analyzeMs.toString()}ms · generate ${generateMs.toString()}ms · validate ${validateMs.toString()}ms)`,
      `Tokens: ↓${usage.input.toString()} · ↑${usage.output.toString()}${usage.fromApi ? '' : ' (stima)'}`,
      `Nodi generati: ${workflow.nodes.length.toString()}, edges: ${workflow.edges.length.toString()}`,
      `Reasoning: ${parsed.reasoning.slice(0, 200)}${parsed.reasoning.length > 200 ? '…' : ''}`,
      ...dbHeal.notes,
      ...tablesNotesLines,
      ...warningLines,
      ...coverageWarnings,
      'Workflow NON ancora salvato — rivedi e premi "Importa" per confermare.',
    ],
    ...(tablesToCreate.length > 0 ? { tablesToCreate } : {}),
  };

  // ─── TEMPLATE CACHE — save post-success SOLO se ALTA QUALITÀ (Livello 1) ───
  // Idempotent su graph_signature. MA: cachiamo solo i workflow che la LLM ha
  // prodotto PULITI. Se l'auto-fix ha dovuto SANARE la struttura (merge mancante,
  // fan-in) o il quality-gate ha warning, il template NON è meritevole — verrebbe
  // ri-proposto come "buono" mentre è il grafo sbagliato della LLM (bug Sitemap
  // Crawler 2026-06-11). I fix triviali (placeholder→secret) restano accettabili.
  // Errore data-flow (reachability) = bug reale → NON cachabile (becca il bug
  // db_insert→nodo-non-a-monte del IMAP CRM). I warning data-flow (euristici) no.
  const dataflowFails = validateDataflow(
    parsed.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    parsed.edges.map((e) => ({ from: e.from, to: e.to })),
  ).filter((i) => i.status === 'fail');
  const cacheWorthy =
    isWorkflowCacheWorthy(
      autoFixResult.appliedFixes.map((f) => f.type),
      qualityWarnings.length,
    ) &&
    coverageWarnings.length === 0 && // capability richiesta mancante → mai template "buono"
    dataflowFails.length === 0; // referenze a nodi non-a-monte → bug → no cache
  if (cacheWorthy) {
    try {
      templateCache.save({
        promptText: goal,
        workflow: {
          name: workflow.name,
          nodes: workflow.nodes.map((n) => ({ id: n.id, defId: n.defId })),
          edges: workflow.edges.map((e) => ({ from: e.from, to: e.to })),
        },
        workflowJson: JSON.stringify(workflow),
        embedding: queryEmbedding,
      });
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[SINGLESHOT] template-cache save failed (non-fatal)',
      );
    }
  } else {
    logger.info(
      { fixes: autoFixResult.appliedFixes.map((f) => f.type), warnings: qualityWarnings.length },
      '[SINGLESHOT] workflow NON cachato — qualità insufficiente (heal strutturale o quality-warning)',
    );
  }

  try {
    await onProgress?.({ type: 'done', result: finalResult });
  } catch {
    /* */
  }
  return finalResult;
}
