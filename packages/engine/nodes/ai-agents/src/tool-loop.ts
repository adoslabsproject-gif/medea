/**
 * AI Agent (tool-calling loop).
 *
 * The agent receives a user goal + a JSON-described tool catalog. It loops:
 *   1. Send messages to LLM
 *   2. If LLM returns a tool call, execute the tool, return the result
 *   3. Otherwise, return the final text
 *
 * Fase 2 (#14): provider da Settings → AI Providers — Liara (gateway metered,
 * formato OpenAI-tools, loop in tool-loop-openai.ts) è il DEFAULT; Anthropic
 * resta il ramo nativo (tool_use/tool_result, in questo file) e la regola
 * legacy "apiKey senza provider = anthropic" preserva le config esistenti.
 *
 * Tools available in v0.1:
 *   - http_request(method, url, body?, headers?)  — fetch any URL
 *   - flowforge_invoke(workflowId, input)         — call another FlowForge workflow
 *   - get_time()                                  — current ISO timestamp
 *
 * This is the FlowForge equivalent of @n8n/n8n-nodes-langchain "AI Agent".
 * The differentiator: tools are *workflow-callable*, so you can compose
 * agents that orchestrate workflows that contain other agents.
 */

import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
// N20 audit (2026-05-29): http_request è LLM-callable e prompt-injectable.
// Senza SSRF guard + manual redirect + auth strip, una prompt injection
// può forzare la fetch verso 169.254.169.254 (IMDS), Redis loopback, o
// container Docker cross-tenant. Pattern unificato in
// `@medea/engine-safe-fetch` per allinearsi al nodo HTTP stdlib (P0-3 fix).
//
// 2026-06-04 audit gap closure: TUTTI i fetch (anche host hardcoded
// trusted come OpenAI/Anthropic/Cohere/Voyage/Ollama/runtime-loopback)
// passano per executeWithHostBreaker — un provider impallato non droga
// il pool, fast-fail dopo 5 trip e probe HALF_OPEN per recovery.
import { safeFetchWithRedirects, SsrfBlockedError, readJsonCapped, readTextTruncated } from '@medea/engine-safe-fetch';
// CONTRATTO #2 (RAG security): il contenuto recuperato via rag_search è DATO non
// fidato (indirect prompt-injection). Stesso guard del runtime (executor
// rag_search) → framing identico, zero drift. RAG_SYSTEM_REINFORCEMENT è il
// rinforzo cintura+bretelle nel system prompt.
import { frameRagResults, RAG_SYSTEM_REINFORCEMENT, RAG_CONTENT_MARKER, type RagSearchResult } from '@medea/engine-rag-guard';
// Fase 2 (#14): il nodo non è più Anthropic-only. Provider da Settings → AI
// Providers (Liara gateway di DEFAULT, tool_calls Qwen3-VL validati live);
// il loop OpenAI-format vive in tool-loop-openai.ts (no-monoliti), il loop
// Anthropic nativo resta qui. resolveLlmConfig è la stessa degli agent_*.
import { resolveLlmConfig } from './llm-config.js';
import { logLlmExchange } from '@medea/engine-nodes-stdlib';
import { runOpenAiToolLoop, TOOL_CAPABLE_OPENAI_PROVIDERS } from './tool-loop-openai.js';
import { buildAgentUsage, sumAgentUsage, type AgentLlmUsage } from './llm-usage.js';

/** Marker di CHIUSURA del frame RAG (derivato dalla costante unica del rag-guard). Lo
 *  slice grezzo del JSON poteva troncarlo → frame non chiuso = breakout dei dati non
 *  fidati. Lo ri-appendiamo se il cap tronca (#6). */
const RAG_FRAME_CLOSE = `<<<END_${RAG_CONTENT_MARKER}>>>`;
const RAG_DISPLAY_CAP = 16_000;

const PROVIDER_TIMEOUT_MS = 30_000;

/** Cap superiore HARD del loop agente (#6): tetto a un valore di config eccessivo
 *  (100000 = runaway/DoS/toll). Ogni iterazione = 1 LLM call + 1 tool. */
const MAX_AGENT_ITERATIONS = 50;

/**
 * H3 — un id LLM-controlled che finisce in un PATH verso l'API interna (gatewayFetch
 * allowDockerNet) DEVE essere un singolo segmento: niente `/`, `..`, traversal encoded.
 * Allowlist stretta (stessa difesa del nodo db, ondata 4) — l'LLM può tentare
 * `../../internal/...` per colpire endpoint interni col token + X-Tenant-Id.
 */
const SAFE_PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Helper: wrap fetch in per-host CB + safeFetchWithRedirects + timeout. */
async function gatewayFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; allowDockerNet?: boolean; allowedHosts?: readonly string[]; signal?: AbortSignal },
): Promise<Response> {
  return executeWithHostBreaker(url, () => {
    const opts: Parameters<typeof safeFetchWithRedirects>[1] = {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      ...(init.allowDockerNet ? { allowDockerNet: true } : {}),
      // Esenzione SSRF per host:porta ESATTO (runtime interno loopback: allowDockerNet
      // non basta per gli IP privati/loopback). URL fisso server-side, non user-payload.
      ...(init.allowedHosts ? { allowedHosts: init.allowedHosts } : {}),
      // Segnale di cancel del run → la chiamata LLM in volo aborta SUBITO (non
      // aspetta il timeout). safe-outbound lo combina col timeout interno.
      ...(init.signal ? { signal: init.signal } : {}),
    };
    return safeFetchWithRedirects(url, opts);
  });
}

/** Host:porta del runtime interno (per esenzione SSRF mirata; loopback/IP-privato by-design). */
function runtimeAllowedHosts(base: string): string[] {
  try { return [new URL(base).host.toLowerCase()]; } catch { return []; }
}

/** Adapter alla firma legacy usata nei call-site: delega al primitivo CONDIVISO
 *  `readTextTruncated` di @medea/engine-safe-fetch (anti-OOM, single source of truth)
 *  e scarta il flag `truncated` (qui serve solo il testo cappato per display/errori). */
async function readCappedText(res: Response, maxBytes = 4096): Promise<string> {
  return (await readTextTruncated(res, maxBytes)).text;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[] | string;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicReply {
  stop_reason?: string;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Embedding provider switchboard — duplicated from packages/nodes/llm/rag.ts
 * to avoid a cross-package cycle. Keep the API identical so configurations
 * are interchangeable.
 */
async function embedText(provider: string, apiKey: string, model: string, text: string): Promise<number[]> {
  switch (provider) {
    case 'openai': {
      const res = await gatewayFetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'text-embedding-3-small', input: text }),
      });
      if (!res.ok) throw new Error(`OpenAI embed ${res.status.toString()}: ${await readCappedText(res, 4096)}`);
      const data = await readJsonCapped<{ data: { embedding: number[] }[] }>(res);
      return data.data[0]?.embedding ?? [];
    }
    case 'voyage': {
      const res = await gatewayFetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'voyage-3', input: text }),
      });
      if (!res.ok) throw new Error(`Voyage embed ${res.status.toString()}: ${await readCappedText(res, 4096)}`);
      const data = await readJsonCapped<{ data: { embedding: number[] }[] }>(res);
      return data.data[0]?.embedding ?? [];
    }
    case 'ollama': {
      const baseUrl = process.env.MEDEA_OLLAMA_URL ?? 'http://localhost:11434';
      const res = await gatewayFetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'nomic-embed-text', prompt: text }),
        allowDockerNet: true,
        // Ollama default loopback (localhost:11434) → allowDockerNet non basta. L'endpoint
        // è da env di sistema (non payload utente) → esenzione per host esatto.
        allowedHosts: runtimeAllowedHosts(baseUrl),
      });
      if (!res.ok) throw new Error(`Ollama embed ${res.status.toString()}: ${await readCappedText(res, 4096)}`);
      const data = await readJsonCapped<{ embedding: number[] }>(res);
      return data.embedding;
    }
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

const TOOLS = [
  {
    name: 'http_request',
    description: 'Perform an HTTP request and return the response body as text.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        url: { type: 'string', format: 'uri' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'flowforge_invoke',
    description: 'Invoke another FlowForge workflow by id and return its result.',
    input_schema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'get_time',
    description: 'Return the current ISO-8601 timestamp.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'rag_search',
    description:
      'Query a FlowForge vector collection (RAG). Pass a natural-language query — the tool embeds it with the configured provider and returns the top-K matching passages and their payloads. Use this when you need facts/context from the knowledge base.',
    input_schema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'FlowForge DB Studio database id holding the vector collection.',
        },
        collection: { type: 'string', description: 'Vector collection name.' },
        query: { type: 'string', description: 'Natural-language search query.' },
        topK: { type: 'number', description: 'Number of results (default 5, max 20).' },
      },
      required: ['databaseId', 'collection', 'query'],
    },
  },
] as const;

/**
 * Framma la risposta di /vector/:id/search ({ results, count }) prima di
 * restituirla al modello: ogni chunk recuperato è DATO non fidato (contratto #2).
 * Parsing difensivo — se il body non è la forma attesa (es. JSON di errore), passa
 * verbatim con cap 16k (no crash, nessun dato non framato silenziosamente).
 */
export function frameRagSearchResponse(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.slice(0, 16_000); // non-JSON (improbabile) → passthrough capped
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { results?: unknown }).results)
  ) {
    // forma inattesa (es. { error }) → passthrough capped, niente framing fittizio
    return text.slice(0, 16_000);
  }
  const obj = parsed as { results: RagSearchResult[]; count?: number };
  const framed = frameRagResults(obj.results);
  const out = JSON.stringify({ ...obj, results: framed });
  if (out.length <= RAG_DISPLAY_CAP) return out;
  // #6 — cap che PRESERVA il marker di chiusura: slice grezzo + ri-append di
  // RAG_FRAME_CLOSE. Senza, lo slice troncava `<<<END_RAG_CONTENT>>>` → l'LLM vedeva un
  // frame APERTO → il testo successivo poteva essere interpretato fuori dal recinto
  // "dato non fidato" (breakout). L'output è una stringa letta dall'LLM (non ri-parsata):
  // un JSON troncato è innocuo, il marker mancante NO.
  const room = Math.max(0, RAG_DISPLAY_CAP - RAG_FRAME_CLOSE.length);
  return out.slice(0, room) + RAG_FRAME_CLOSE;
}

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: {
    runtimeBaseUrl: string;
    tenantId: string;
    token?: string | undefined;
    embedProvider: string;
    embedApiKey: string;
    embedModel: string;
    defaultRagDatabaseId?: string;
    defaultRagCollection?: string;
  },
): Promise<string> {
  if (toolName === 'get_time') {
    return new Date().toISOString();
  }
  if (toolName === 'rag_search') {
    // Defaults from agent config (configured via UI dropdowns) — the LLM
    // can override per-call but if it omits the params we fall back to
    // the agent's pre-bound knowledge base. This is the n8n-superior UX.
    const databaseId = (typeof toolInput.databaseId === 'string' && toolInput.databaseId) || ctx.defaultRagDatabaseId || '';
    const collection = (typeof toolInput.collection === 'string' && toolInput.collection) || ctx.defaultRagCollection || '';
    const query = typeof toolInput.query === 'string' ? toolInput.query : '';
    const topK = Math.min(20, Math.max(1, Number(toolInput.topK ?? 5)));
    if (!databaseId || !collection || !query) {
      return JSON.stringify({
        error: 'rag_search requires databaseId, collection, query. Set defaults in the node config to omit them per-call.',
      });
    }
    // H3 — `databaseId` è LLM-controlled e finisce in un PATH verso l'API INTERNA
    // (gatewayFetch allowDockerNet). Senza allowlist, `../../internal/...` colpirebbe
    // endpoint interni col token + X-Tenant-Id. Stretto allowlist (come la difesa del
    // nodo db, ondata 4): un id è un segmento singolo, mai un path.
    if (!SAFE_PATH_ID.test(databaseId)) {
      return JSON.stringify({ error: 'invalid databaseId: only [A-Za-z0-9_-], max 128 chars' });
    }
    if (!ctx.embedApiKey && ctx.embedProvider !== 'ollama') {
      return JSON.stringify({ error: `rag_search needs embedApiKey for provider "${ctx.embedProvider}"` });
    }
    try {
      const vector = await embedText(ctx.embedProvider, ctx.embedApiKey, ctx.embedModel, query);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Tenant-Id': ctx.tenantId,
      };
      if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
      const res = await gatewayFetch(`${ctx.runtimeBaseUrl}/vector/${encodeURIComponent(databaseId)}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ collection, vector, topK }),
        allowDockerNet: true,
        allowedHosts: runtimeAllowedHosts(ctx.runtimeBaseUrl),
      });
      const text = await readCappedText(res, 4 * 1024 * 1024); // cap anti-OOM sui risultati RAG
      // SICUREZZA contratto #2: la route /vector/:id/search ritorna { results,
      // count } con contenuto NON fidato. Ogni chunk va framato come DATO prima
      // di entrare nel context del modello — stesso guard del runtime (zero drift).
      return frameRagSearchResponse(text);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (toolName === 'http_request') {
    // N20 audit (2026-05-29): URL e headers sono LLM-controlled. Prompt
    // injection può fare:
    //  • fetch http://169.254.169.254/ → leak IAM credentials in context
    //  • fetch http://internal-redis:6379 → cross-tenant fingerprint
    //  • Bearer token leak su redirect cross-host (default fetch followes)
    // safeFetchWithRedirects fa tutto in un colpo: assertUrlSafe pre-flight,
    // manual redirect con SSRF re-validate per hop, strip cross-host di
    // Authorization/Cookie, timeout 30s, max 5 hop.
    const method = typeof toolInput.method === 'string' ? toolInput.method : 'GET';
    const url = typeof toolInput.url === 'string' ? toolInput.url : '';
    const headers = (toolInput.headers as Record<string, string> | undefined) ?? {};
    const body = typeof toolInput.body === 'string' ? toolInput.body : undefined;
    try {
      // Breaker per-host: anche l'http_request LLM-controlled passa per
      // executeWithHostBreaker → un endpoint impallato non blocca la run.
      const res = await gatewayFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const text = await readCappedText(res, 16_000); // http_request tool: cap = lo slice display
      return JSON.stringify({ status: res.status, body: text.slice(0, 16_000) });
    } catch (err) {
      // Return a structured tool-result error so the LLM can recover
      // (try a different URL, ask the user) without crashing the run.
      const isSsrf = err instanceof SsrfBlockedError;
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: isSsrf ? `URL blocked by SSRF guard: ${message}` : `http_request failed: ${message}`,
      });
    }
  }
  if (toolName === 'flowforge_invoke') {
    const workflowId = typeof toolInput.workflowId === 'string' ? toolInput.workflowId : '';
    if (!workflowId) return JSON.stringify({ error: 'workflowId required' });
    // H3 — `workflowId` è LLM-controlled e finisce in un PATH verso l'API interna →
    // allowlist stretta + encode (anti path-injection, come databaseId/ondata 4).
    if (!SAFE_PATH_ID.test(workflowId)) {
      return JSON.stringify({ error: 'invalid workflowId: only [A-Za-z0-9_-], max 128 chars' });
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': ctx.tenantId,
    };
    if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
    const res = await gatewayFetch(`${ctx.runtimeBaseUrl}/workflows/${encodeURIComponent(workflowId)}/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolInput.input ?? {}),
      allowDockerNet: true,
      allowedHosts: runtimeAllowedHosts(ctx.runtimeBaseUrl),
    });
    const text = await readCappedText(res, 16_000);
    return text.slice(0, 16_000);
  }
  return JSON.stringify({ error: `Unknown tool: ${toolName}` });
}

const agentToolLoopExecutor: NodeExecutor = async (config, input, ctx) => {
  const start = Date.now();
  // ── Risoluzione provider (Fase 2 #14) ────────────────────────────────────
  // LEGACY: il nodo era Anthropic-only (apiKey obbligatoria, NESSUN campo
  // provider). Una config salvata pre-Fase2 ha apiKey piena e provider assente
  // → resta anthropic, comportamento IDENTICO. Tutto il resto passa dallo
  // stesso resolveLlmConfig degli agent_* (Settings → AI Providers, Liara
  // free-tier come default finale).
  const rawProvider = typeof config.provider === 'string' ? config.provider.trim() : '';
  const rawApiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const rawModel = typeof config.model === 'string' ? config.model.trim() : '';
  let resolved = rawProvider === '' && rawApiKey !== ''
    ? { provider: 'anthropic', apiKey: rawApiKey, model: rawModel, baseUrl: undefined as string | undefined }
    : resolveLlmConfig(config, ctx.llmProviders);

  // Provider senza tool-calling (oggi SOLO perplexity, dai Settings auto-pick:
  // NON è selezionabile sul nodo) → fallback DICHIARATO su Liara, mai un
  // errore né uno swap nascosto: `providerFallback` finisce nell'output e
  // `_llm.provider` mostra il provider REALE usato (stesso pattern esplicito
  // del `degraded:'byok-fallback'` di action_llm_complete).
  let providerFallback: { from: string; reason: string } | undefined;
  if (resolved.provider !== 'anthropic' && !TOOL_CAPABLE_OPENAI_PROVIDERS.has(resolved.provider)) {
    providerFallback = { from: resolved.provider, reason: `il provider "${resolved.provider}" non supporta il tool-calling — agent eseguito su Liara` };
    resolved = { provider: 'liara', apiKey: '', model: '', baseUrl: undefined };
  }

  const apiKey = resolved.apiKey;
  const model = resolved.model;
  const baseSystemPrompt =
    typeof config.systemPrompt === 'string' && config.systemPrompt
      ? config.systemPrompt
      : 'You are a senior automation agent. Use the available tools to accomplish the user\'s goal. Be concise.';
  // CONTRATTO #2: rag_search è SEMPRE tra i tool → il modello può ricevere
  // contenuto recuperato non fidato. Prependi sempre il rinforzo di sicurezza
  // (cintura+bretelle col framing inline applicato da frameRagSearchResponse).
  const systemPrompt = `${RAG_SYSTEM_REINFORCEMENT}\n\n${baseSystemPrompt}`;
  // Guard input-rotto: maxIterations='' → Number('')=0 → l'agente non eseguiva
  // alcun round e tornava "exceeded maxIterations=0" (confuso). NaN/≤0 → default 10.
  // #6 — CAP SUPERIORE: ogni iterazione è 1 chiamata LLM + 1 tool (costo/latenza reali);
  // senza tetto, maxIterations=100000 = runaway/DoS/toll. 50 è ampio per un agente reale.
  const rawMaxIter = Number(config.maxIterations ?? 10);
  const maxIterations = Number.isFinite(rawMaxIter) && rawMaxIter >= 1
    ? Math.min(Math.trunc(rawMaxIter), MAX_AGENT_ITERATIONS)
    : 10;
  const userGoal = typeof config.goal === 'string'
    ? config.goal
    : typeof input === 'string'
      ? input
      : JSON.stringify(input);

  const messages: AnthropicMessage[] = [{ role: 'user', content: userGoal }];
  const runtimeBaseUrl = (typeof process !== 'undefined' && process.env.MEDEA_BASE_URL) || 'http://localhost:3100/api/v1';
  const embedProvider = typeof config.embedProvider === 'string' && config.embedProvider ? config.embedProvider : 'openai';
  const embedApiKey = typeof config.embedApiKey === 'string' ? config.embedApiKey : '';
  const embedModel = typeof config.embedModel === 'string' ? config.embedModel : '';
  const defaultRagDatabaseId = typeof config.defaultRagDatabaseId === 'string' ? config.defaultRagDatabaseId : '';
  const defaultRagCollection = typeof config.defaultRagCollection === 'string' ? config.defaultRagCollection : '';
  const toolCtx = {
    runtimeBaseUrl,
    tenantId: ctx.tenantId,
    embedProvider,
    embedApiKey,
    embedModel,
    defaultRagDatabaseId,
    defaultRagCollection,
  };

  const trace: { iteration: number; tool: string; input: unknown; output: string }[] = [];

  // ── Ramo OpenAI-format (liara/openai/openrouter/groq/mistral) ────────────
  if (resolved.provider !== 'anthropic') {
    try {
      const loopRes = await runOpenAiToolLoop({
        provider: resolved.provider,
        apiKey,
        model,
        baseUrl: resolved.baseUrl,
        systemPrompt,
        userGoal,
        maxIterations,
        tools: TOOLS,
        executeTool: (name, toolInput) => executeTool(name, toolInput, toolCtx),
        fetchFn: gatewayFetch,
        readJson: readJsonCapped,
        readErrText: (res) => readCappedText(res, 2000),
        abortSignal: ctx.abortSignal,
        nodeContext: ctx,
      });
      return {
        output: providerFallback ? { ...loopRes.output, providerFallback } : loopRes.output,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      // Provider non supportato per tool-calling (es. gemini/ollama) o errore
      // di rete non recuperabile → output d'errore strutturato, MAI throw nudo.
      return {
        output: { error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Ramo Anthropic nativo (tool_use/tool_result) ─────────────────────────
  if (!apiKey) {
    return { output: { error: 'apiKey required (Anthropic key for tool-calling agent). Configura la key in Settings → AI Providers o lascia il provider vuoto per Liara.' }, durationMs: Date.now() - start };
  }
  const anthropicModel = model || 'claude-sonnet-4-5';

  // Usage cumulativo sulle iterazioni (Fase 2 #14): dai campi usage della API.
  let usage: AgentLlmUsage | null = null;
  const accumulate = (reply: AnthropicReply): void => {
    const step = buildAgentUsage({
      provider: 'anthropic',
      model: anthropicModel,
      sentSystem: systemPrompt,
      sentUser: JSON.stringify(messages),
      receivedText: JSON.stringify(reply.content ?? ''),
      api: { input: reply.usage?.input_tokens, output: reply.usage?.output_tokens },
    });
    usage = usage === null ? step : sumAgentUsage(usage, step);
  };
  const withUsage = (out: Record<string, unknown>): Record<string, unknown> =>
    usage !== null ? { ...out, _llm: usage } : out;

  // Output strutturato di cancellazione (riusato: top-loop, in-flight LLM, tra i tool).
  const cancelledResult = (iter: number) => ({
    output: withUsage({ error: 'Agent annullato (run cancellato)', cancelled: true, trace, iterations: iter }),
    durationMs: Date.now() - start,
  });

  for (let iter = 0; iter < maxIterations; iter++) {
    // CANCEL cooperativo: check PRIMA della LLM-call + segnale passato al fetch → la
    // chiamata in volo aborta subito (non aspetta il timeout). Fix 2026-06-18: prima
    // il segnale NON era propagato (latenza fino a 30s) e i tool lunghi (sotto) NON
    // erano interrompibili affatto.
    if (ctx.abortSignal?.aborted) return cancelledResult(iter);

    let res: Response;
    try {
      res = await gatewayFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools: TOOLS,
          messages,
        }),
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) return cancelledResult(iter); // abort in volo → cancellato pulito
      throw err;
    }
    if (!res.ok) {
      // errText capped REALE (era res.text() = leggeva tutto poi sliceava → OOM).
      const errText = await readCappedText(res, 2000);
      return {
        output: withUsage({ error: `Anthropic ${res.status.toString()}: ${errText}`, trace, iterations: iter }),
        durationMs: Date.now() - start,
      };
    }
    const reply = await readJsonCapped<AnthropicReply>(res);
    accumulate(reply);
    const content = reply.content ?? [];
    // Fase 3 (#15): come nel ramo OpenAI — prompt integrale alla 1ª iterazione.
    logLlmExchange(ctx, {
      provider: 'anthropic',
      model: anthropicModel,
      system: iter === 0 ? systemPrompt : '',
      user: iter === 0 ? userGoal : '(tool results dell\'iterazione precedente — vedi trace)',
      response: content.map((b) => b.type === 'text' ? (b.text ?? '') : JSON.stringify({ tool_use: b.name, input: b.input })).join('\n'),
      phase: `iterazione ${String(iter + 1)}`,
    });
    messages.push({ role: 'assistant', content });

    if (reply.stop_reason === 'tool_use' || content.some((b) => b.type === 'tool_use')) {
      const toolUses = content.filter((b) => b.type === 'tool_use');
      const toolResults: AnthropicContentBlock[] = [];
      for (const tu of toolUses) {
        // CANCEL anche TRA i tool: un tool lungo (HTTP) non rende più l'agente
        // non-interrompibile (latenza cancel ≤ 1 tool, non maxIterations×tutto).
        if (ctx.abortSignal?.aborted) return cancelledResult(iter);
        const toolName = tu.name ?? '';
        const toolInput = (tu.input ?? {});
        const result = await executeTool(toolName, toolInput, toolCtx);
        trace.push({ iteration: iter, tool: toolName, input: toolInput, output: result.slice(0, 500) });
        toolResults.push({
          type: 'tool_result',
          ...(tu.id !== undefined ? { tool_use_id: tu.id } : {}),
          content: result,
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const finalText = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return {
      output: withUsage({
        finalAnswer: finalText,
        iterations: iter + 1,
        trace,
      }),
      durationMs: Date.now() - start,
    };
  }

  return {
    output: withUsage({ error: `Agent exceeded maxIterations=${maxIterations.toString()}`, trace, iterations: maxIterations }),
    durationMs: Date.now() - start,
  };
};

export const agentToolLoopNode: NodeModule = {
  def: {
    id: 'ai_agent_tool_loop',
    type: 'ai',
    label: 'AI Agent (Tool-Calling Loop)',
    icon: 'bot',
    color: '#8b5cf6',
    description:
      'Agente con tool-calling: cicla finché il modello non risponde senza richiedere altri tool. Default = Liara (gateway FlowForge, gratis, metered sulla quota); override per-nodo: Anthropic (nativo), OpenAI, Gemini, DeepSeek, xAI, OpenRouter, Groq, Mistral, Ollama. Tool disponibili: http_request, flowforge_invoke, get_time, rag_search.',
    configFields: [
      {
        key: 'provider',
        label: 'LLM provider (opzionale, override)',
        type: 'select',
        required: false,
        options: ['', 'liara', 'anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'openrouter', 'groq', 'mistral', 'ollama'],
        defaultValue: '',
        help: 'Vuoto = usa il default da Settings → AI Providers (Liara free se non configuri nulla). NB: se compili solo la API key senza provider, vale Anthropic (compatibilità con le config esistenti del nodo).',
      },
      { key: 'apiKey', label: 'API key (override)', type: 'secret', required: false, help: 'Vuoto = chiave da Settings → AI Providers (Liara non ne richiede). Compilata SENZA provider = Anthropic (legacy).' },
      {
        key: 'model',
        label: 'Modello (override)',
        type: 'text',
        required: false,
        placeholder: 'es. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash, llama-3.3-70b-versatile',
        help: 'Vuoto = default del provider (Liara: decide il gateway; Anthropic: claude-sonnet-4-5).',
      },
      { key: 'baseUrl', label: 'Base URL (per Ollama / self-hosted)', type: 'text', required: false, placeholder: 'http://localhost:11434', showIf: { field: 'provider', in: ['ollama'] } },
      {
        key: 'systemPrompt',
        label: 'System prompt',
        type: 'expression',
        required: false,
        defaultValue: 'You are a senior automation agent. Use the available tools (http_request, flowforge_invoke, get_time, rag_search) to accomplish the user\'s goal. Be concise.',
        help: 'Direttive di ruolo/tono/regole. Supporta {{espressioni}} per iniettare contesto dinamico (es. {{ctx.tenantId}}).',
      },
      {
        key: 'goal',
        label: 'Obiettivo (default = input)',
        type: 'expression',
        required: false,
        placeholder: 'Riassumi gli ordini di {{$today}} e mandami una notifica Slack',
        help: 'Cosa l\'agent deve fare. Se vuoto, usa l\'output del nodo precedente come obiettivo.',
      },
      {
        key: 'maxIterations',
        label: 'Iterazioni massime',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Quanti round tool-call → modello al massimo. Il modello chiama tool, vede l\'output, decide se chiamare altri tool o rispondere. Cap anti-loop infinito.',
      },
      {
        key: 'embedProvider',
        label: 'Provider embedding (per rag_search)',
        type: 'select',
        required: false,
        options: ['openai', 'voyage', 'ollama'],
        defaultValue: 'openai',
        help: 'Usato solo se l\'agent invoca il tool rag_search. Deve matchare il provider con cui hai popolato il vector DB.',
      },
      { key: 'embedApiKey', label: 'API key embedding', type: 'secret', required: false, help: 'Necessaria per openai/voyage. Vuoto per ollama (locale).', showIf: { field: 'embedProvider', in: ['openai', 'voyage'] } },
      { key: 'embedModel', label: 'Modello embedding', type: 'text', required: false, placeholder: 'text-embedding-3-small / voyage-3 / nomic-embed-text', help: 'Modello del provider scelto. DEVE matchare quello usato per popolare il vector DB.' },
      { key: 'defaultRagDatabaseId', label: 'Knowledge base default (DB vettoriale)', type: 'db-picker', required: false, help: 'Se impostato, l\'agente sa dove cercare quando invoca rag_search senza specificare il DB. Mantieni vuoto per richiederlo nel prompt.' },
      { key: 'defaultRagCollection', label: 'Collezione knowledge base', type: 'db-collection-picker', required: false, dependsOn: 'defaultRagDatabaseId', help: 'Collezione (namespace) all\'interno del DB selezionato sopra.' },
    ],
    vendor: 'flowforge',
    version: '1.2.0',
  },
  executor: agentToolLoopExecutor,
};
