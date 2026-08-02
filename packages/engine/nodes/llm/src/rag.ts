import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import {
  safeFetchWithRedirects,
  readJsonCapped,
  readTextTruncated,
} from '@medea/engine-safe-fetch';

// Isomorfico: importato anche dal bundle browser dell'editor (dead-code lì, ma
// il top-level gira a load). `process` esiste solo sul runtime server → guard.
const RUNTIME_BASE =
  (typeof process !== 'undefined' ? process.env.MEDEA_RUNTIME_URL : undefined) ??
  'http://127.0.0.1:3100';
/** host:porta del runtime interno (loopback) per l'esenzione SSRF mirata. */
const RUNTIME_HOST = ((): string => {
  try {
    return new URL(RUNTIME_BASE).host.toLowerCase();
  } catch {
    return '';
  }
})();

const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Gateway: ogni outbound passa per safeFetchWithRedirects (SSRF guard +
 * timeout AbortSignal 30s + max-5-redirect + cross-host Authorization strip)
 * e per executeWithHostBreaker (per-host CB 5 fail → 30s open + HALF_OPEN
 * probe). Senza il breaker per-host, un provider giù farebbe degradare la
 * runtime per N retry × 30s; con questo, fail-fast immediato dopo 5 trip.
 *
 * FIX 2026-06-26: RUNTIME_BASE è loopback (127.0.0.1:3100) → `allowDockerNet`
 * NON lo esenta (esenta solo gli hostname *.flowforge-net, non gli IP privati/
 * loopback). Il commento precedente era ASPIRAZIONALE e la vector-search era di
 * fatto bloccata dal guard. Si esenta per host:porta ESATTO via `allowedHosts`
 * (l'URL è FISSO server-side, RUNTIME_BASE da env di sistema → non user-payload).
 */
async function gatewayJsonPost<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { allowDockerNet?: boolean; allowedHosts?: readonly string[] } = {},
): Promise<{ res: Response; data: T }> {
  return executeWithHostBreaker(url, async () => {
    const res = await safeFetchWithRedirects(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      ...(opts.allowDockerNet ? { allowDockerNet: true } : {}),
      ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    });
    if (!res.ok) {
      const { text } = await readTextTruncated(res, 65_536);
      throw new Error(`${new URL(url).host} ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    const data = await readJsonCapped<T>(res, 4 * 1024 * 1024);
    return { res, data };
  });
}

interface EmbedResult {
  vector: number[];
  tokensUsed: number | null;
}

/** Estrae i token consumati dalle varie shape `usage` dei provider (null se assente). */
function pickTokens(v: unknown): number | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as {
    usage?: { total_tokens?: unknown; input_tokens?: unknown };
    meta?: { billed_units?: { input_tokens?: unknown } };
  };
  const cand = o.usage?.total_tokens ?? o.usage?.input_tokens ?? o.meta?.billed_units?.input_tokens;
  return typeof cand === 'number' && Number.isFinite(cand) ? cand : null;
}

async function callEmbed(
  provider: string,
  apiKey: string,
  model: string,
  text: string,
): Promise<EmbedResult> {
  switch (provider) {
    case 'openai': {
      const { data } = await gatewayJsonPost<{
        data: { embedding: number[] }[];
        usage?: { total_tokens?: number };
      }>(
        'https://api.openai.com/v1/embeddings',
        { model: model || 'text-embedding-3-small', input: text },
        { Authorization: `Bearer ${apiKey}` },
      );
      return { vector: data.data[0]?.embedding ?? [], tokensUsed: pickTokens(data) };
    }
    case 'cohere': {
      const { data } = await gatewayJsonPost<{
        embeddings: { float: number[][] };
        meta?: { billed_units?: { input_tokens?: number } };
      }>(
        'https://api.cohere.com/v2/embed',
        { model: model || 'embed-multilingual-v3.0', texts: [text], input_type: 'search_document' },
        { Authorization: `Bearer ${apiKey}` },
      );
      return { vector: data.embeddings.float[0] ?? [], tokensUsed: pickTokens(data) };
    }
    case 'voyage': {
      const { data } = await gatewayJsonPost<{
        data: { embedding: number[] }[];
        usage?: { total_tokens?: number };
      }>(
        'https://api.voyageai.com/v1/embeddings',
        { model: model || 'voyage-3', input: text },
        { Authorization: `Bearer ${apiKey}` },
      );
      return { vector: data.data[0]?.embedding ?? [], tokensUsed: pickTokens(data) };
    }
    case 'ollama': {
      const baseUrl = process.env.MEDEA_OLLAMA_URL ?? 'http://localhost:11434';
      // Ollama spesso loopback → allowDockerNet non basta; esenta l'host esatto (env sistema).
      const ollamaHost = ((): string => {
        try {
          return new URL(baseUrl).host.toLowerCase();
        } catch {
          return '';
        }
      })();
      const { data } = await gatewayJsonPost<{ embedding?: number[] }>(
        `${baseUrl}/api/embeddings`,
        { model: model || 'nomic-embed-text', prompt: text },
        {},
        ollamaHost ? { allowedHosts: [ollamaHost] } : {},
      );
      return { vector: data.embedding ?? [], tokensUsed: null }; // Ollama locale: nessun usage
    }
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

const embedExecutor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const provider = typeof config.provider === 'string' ? config.provider : 'openai';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  const model = typeof config.model === 'string' ? config.model : '';
  const text =
    typeof config.text === 'string' && config.text.length > 0
      ? config.text
      : typeof input === 'string'
        ? input
        : JSON.stringify(input);

  const { vector, tokensUsed } = await callEmbed(provider, apiKey, model, text);
  return {
    output: { text, vector, dimensions: vector.length, provider, model, tokensUsed },
    durationMs: Date.now() - start,
  };
};

const ragSearchExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const databaseId = typeof config.databaseId === 'string' ? config.databaseId : '';
  const collection = typeof config.collection === 'string' ? config.collection : '';
  const provider = typeof config.embedProvider === 'string' ? config.embedProvider : 'openai';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  const model = typeof config.embedModel === 'string' ? config.embedModel : '';
  const queryText =
    typeof config.queryText === 'string' && config.queryText.length > 0
      ? config.queryText
      : typeof input === 'string'
        ? input
        : JSON.stringify(input);
  const topK = Number(config.topK ?? 5);
  const minScore = config.minScore !== undefined ? Number(config.minScore) : undefined;

  if (!databaseId || !collection)
    throw new Error('ai_rag_search: databaseId and collection are required');

  const { vector } = await callEmbed(provider, apiKey, model, queryText);

  const body: Record<string, unknown> = { collection, vector, topK };
  if (minScore !== undefined && !Number.isNaN(minScore)) body.minScore = minScore;

  const headers: Record<string, string> = { 'X-Tenant-Id': context.tenantId };
  const internalToken = process.env.MEDEA_INTERNAL_TOKEN;
  if (internalToken) headers['X-Internal-Token'] = internalToken;
  const { data } = await gatewayJsonPost<unknown>(
    `${RUNTIME_BASE}/api/v1/vector/${databaseId}/search`,
    body,
    headers,
    // Esenzione SSRF per il runtime interno (loopback) — host esatto, URL fisso server-side.
    RUNTIME_HOST ? { allowedHosts: [RUNTIME_HOST] } : {},
  );
  return { output: { query: queryText, ...(data as object) }, durationMs: Date.now() - start };
};

export const aiEmbedNode: NodeModule = {
  def: {
    id: 'ai_embed',
    type: 'ai',
    label: 'AI: Generate Embedding',
    icon: 'binary',
    color: '#a855f7',
    description:
      'Genera un vettore embedding da testo per RAG/semantic search. Provider supportati: ' +
      'OpenAI (text-embedding-3-small/large), Cohere (embed-english-v3), Voyage (voyage-3 top-quality), Ollama (locale gratis). ' +
      'Output: { text, vector: number[], dimensions, provider, model, tokensUsed (null per Ollama locale) }. Dimensione tipica 1024-3072. ' +
      'Use case: indicizzare knowledge base aziendale per chatbot, similarity search prodotti e-commerce, ' +
      'clustering documenti, dedup semantico ticket/FAQ, populate vector DB downstream con ai_rag_search.',
    configFields: [
      {
        key: 'provider',
        label: 'Provider embedding',
        type: 'select',
        required: true,
        options: ['openai', 'cohere', 'voyage', 'ollama'],
        defaultValue: 'openai',
        help: 'openai = text-embedding-3-small (default, qualità/costo ottimo). cohere/voyage = qualità top per RAG. ollama = locale, gratis ma più lento.',
      },
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: false,
        showIf: { field: 'provider', in: ['openai', 'cohere', 'voyage'] },
        help: 'Necessaria per i provider cloud. Non serve per ollama (locale).',
      },
      {
        key: 'model',
        label: 'Modello embedding',
        type: 'text',
        required: false,
        placeholder:
          'text-embedding-3-small (OpenAI), embed-english-v3.0 (Cohere), voyage-3 (Voyage)',
        help: 'Modello specifico del provider. Vuoto = default. Per OpenAI: text-embedding-3-small (1536 dim) o text-embedding-3-large (3072 dim).',
      },
      {
        key: 'text',
        label: 'Testo da embeddare',
        type: 'expression',
        required: false,
        placeholder: '{{input.text}}',
        help: "Testo di cui calcolare il vettore. Se vuoto, usa l'input.",
      },
    ],
    vendor: 'flowforge',
    version: '1.2.0',
  },
  executor: embedExecutor,
};

export const aiRagSearchNode: NodeModule = {
  def: {
    id: 'ai_rag_search',
    type: 'ai',
    label: 'AI: RAG Search',
    icon: 'search',
    color: '#a855f7',
    description:
      'Ricerca semantica su un FlowForge vector database (cosine similarity). Genera embedding query → top-K matches con score 0-1. ' +
      'Filtri opzionali pre-search (where clause su metadata). Re-ranking opzionale tramite cross-encoder downstream. ' +
      'Output: { query, results: [{ id, score, payload }], count }. ' +
      'Use case: RAG retrieval pre-LLM completion (Q&A su docs), suggest articoli correlati per CMS, ' +
      'semantic search prodotti e-commerce, dedup ticket support tramite similarity ≥0.8.',
    configFields: [
      {
        key: 'databaseId',
        label: 'Database vettoriale',
        type: 'db-picker',
        required: true,
        help: 'Database FlowForge configurato come vector store (DB Studio → Databases).',
      },
      {
        key: 'collection',
        label: 'Collezione',
        type: 'db-collection-picker',
        required: true,
        dependsOn: 'databaseId',
        help: 'Collezione (namespace) di vettori dentro il database selezionato.',
      },
      {
        key: 'queryText',
        label: 'Testo query',
        type: 'expression',
        required: false,
        placeholder: '{{input.question}}',
        help: 'Testo da cercare. Viene embedded e confrontato con i vettori in DB. Vuoto = usa input.',
      },
      {
        key: 'embedProvider',
        label: 'Provider embedding (per la query)',
        type: 'select',
        required: true,
        options: ['openai', 'cohere', 'voyage', 'ollama'],
        defaultValue: 'openai',
        help: 'Deve essere lo STESSO provider usato quando hai popolato il DB, altrimenti i vettori non sono confrontabili.',
      },
      {
        key: 'apiKey',
        label: 'API key embedding',
        type: 'secret',
        required: false,
        showIf: { field: 'embedProvider', in: ['openai', 'cohere', 'voyage'] },
      },
      {
        key: 'embedModel',
        label: 'Modello embedding',
        type: 'text',
        required: false,
        placeholder: 'es. text-embedding-3-small',
        help: "DEVE matchare il modello usato all'embedding originale per avere stesse dimensioni.",
      },
      {
        key: 'topK',
        label: 'Top-K risultati',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Numero massimo di risultati ritornati (default 5).',
      },
      {
        key: 'minScore',
        label: 'Score minimo (0-1)',
        type: 'number',
        required: false,
        placeholder: '0.7',
        help: 'Filtra i risultati con similarità < soglia. 0.7+ = molto rilevante, 0.5+ = generico, vuoto = nessun filtro.',
      },
    ],
    vendor: 'flowforge',
    version: '1.2.0',
  },
  executor: ragSearchExecutor,
};
