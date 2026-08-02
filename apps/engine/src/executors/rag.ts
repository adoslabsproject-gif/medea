/**
 * Executor RAG per-tenant: rag_search / rag_ingest.
 *
 * Usano VectorService (isolamento per-tenant garantito: dbStudio.get(databaseId,
 * tenantId) + TenantScopedVectorStore su pgvector) + embedText (provider scelto dal
 * tenant, BYOK). In-process: niente HTTP, testabili mockando i due servizi.
 *
 * rag_search: embed query → KNN sullo store del tenant → top-k chunk al modello.
 * rag_ingest: embed contenuto → upsert nello store del tenant.
 */
import type { NodeExecutor, NodeExecutionResult } from '@medea/engine-nodes-stdlib';
import { VectorService } from '@/services/vector.service.js';
import { embedText, type EmbeddingProvider } from '@/services/embeddings.service.js';
import { ingestText, vectorPlanLimitsFromConfig, type VectorDistance } from '@/services/vector-ingest.js';
import { frameRagResults } from './rag-guard.js';

const VALID_PROVIDERS = new Set<EmbeddingProvider>(['openai', 'voyage', 'ollama']);

function str(config: Record<string, unknown>, key: string, def = ''): string {
  const v = config[key];
  return typeof v === 'string' ? v : def;
}
function num(config: Record<string, unknown>, key: string): number | undefined {
  const v = config[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
function jsonObj(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const p = JSON.parse(value) as unknown;
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function resolveProvider(config: Record<string, unknown>): EmbeddingProvider {
  const p = str(config, 'provider', 'openai');
  if (!VALID_PROVIDERS.has(p as EmbeddingProvider)) {
    throw new Error(`rag: provider embedding non valido "${p}" (ammessi: openai, voyage, ollama)`);
  }
  return p as EmbeddingProvider;
}

function embeddingReq(config: Record<string, unknown>, text: string): Parameters<typeof embedText>[0] {
  const provider = resolveProvider(config);
  const model = str(config, 'model', 'text-embedding-3-small');
  const apiKey = str(config, 'apiKey');
  const baseUrl = str(config, 'baseUrl');
  return {
    provider,
    model,
    text,
    ...(apiKey !== '' ? { apiKey } : {}),
    ...(baseUrl !== '' ? { baseUrl } : {}),
  };
}

export const ragSearchExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const databaseId = str(config, 'databaseId');
  const collection = str(config, 'collection');
  if (!databaseId || !collection) throw new Error('rag_search: databaseId e collection sono obbligatori');

  // query: dal config, altrimenti dall'input (stringa o { query }/{ text })
  let query = str(config, 'query');
  if (!query) {
    if (typeof input === 'string') query = input;
    else {
      const obj = input as Record<string, unknown> | null;
      query = typeof obj?.query === 'string' ? obj.query : typeof obj?.text === 'string' ? obj.text : '';
    }
  }
  if (query.trim() === '') throw new Error('rag_search: query vuota (config.query o input.query/text)');

  const topK = num(config, 'topK') ?? 5;
  const minScore = num(config, 'minScore');
  const filter = jsonObj(config.filterJson);
  const tenantId = context.tenantId ?? 'default';

  const vector = await embedText(embeddingReq(config, query));
  const vs = new VectorService();
  // CONTRATTO con VectorService.search: ritorna { results, count } (NON un array).
  // Trattarlo come array → `.map is not a function` a runtime. Vincolato dal
  // contract test (vector-search-shape.contract.test.ts) che lega questo consumer
  // alla forma prodotta dall'adapter reale.
  const searchRes = (await vs.search(
    databaseId,
    collection,
    { vector, topK, ...(minScore !== undefined ? { minScore } : {}), ...(filter ? { filter } : {}) },
    tenantId,
  )) as { results: { id: string; score: number; payload?: Record<string, unknown> }[]; count: number };
  const raw = searchRes.results;

  // SICUREZZA: ogni chunk recuperato è incapsulato come DATO non fidato (anti
  // indirect prompt-injection) prima di arrivare al modello. Difesa primaria.
  // Helper condiviso con il nodo agent → stesso framing, zero drift.
  const results = frameRagResults(raw);

  const ret: NodeExecutionResult = { output: { query, results }, durationMs: Date.now() - start };
  return ret;
};

export const ragIngestExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const databaseId = str(config, 'databaseId');
  const collection = str(config, 'collection');
  if (!databaseId || !collection) throw new Error('rag_ingest: databaseId e collection sono obbligatori');

  // contenuto: dal config, altrimenti dall'input (stringa o { content }/{ text })
  let content = str(config, 'content');
  if (!content) {
    if (typeof input === 'string') content = input;
    else {
      const obj = input as Record<string, unknown> | null;
      content = typeof obj?.content === 'string' ? obj.content : typeof obj?.text === 'string' ? obj.text : '';
    }
  }
  if (content.trim() === '') throw new Error('rag_ingest: contenuto vuoto (config.content o input.content/text)');

  // provider validato qui (throw su provider non valido prima di qualsiasi I/O).
  const provider = resolveProvider(config);
  const model = str(config, 'model', 'text-embedding-3-small');
  const apiKey = str(config, 'apiKey');
  const baseUrl = str(config, 'baseUrl');
  const distance = str(config, 'distance', 'cosine') as VectorDistance;
  const payload = jsonObj(config.payloadJson) ?? {};
  const idCfg = str(config, 'id');
  const tenantId = context.tenantId ?? 'default';

  // Tutta la pipeline (scan anti-injection + quota AGGREGATA + embed + upsert) è nel
  // core condiviso ingestText: stesso identico comportamento dell'endpoint UI
  // /vector/:id/ingest-text e dell'auto-embed → nessun path bypassa guard o quota.
  const result = await ingestText({
    databaseId,
    collection,
    content,
    tenantId,
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    distance,
    ...(idCfg ? { id: idCfg } : {}),
    payload,
    planLimits: vectorPlanLimitsFromConfig(),
  });

  const ret: NodeExecutionResult = { output: { id: result.id, upserted: result.upserted }, durationMs: Date.now() - start };
  return ret;
};
