/**
 * Core di INGEST vettoriale — autorità UNICA server-side per indicizzare testo.
 *
 * Pipeline (in quest'ordine, NON aggirabile): scan anti prompt-injection (hard-block)
 * → quota per-tenant AGGREGATA (net-add) → embed → ensureCollection → upsert.
 *
 * Perché un core condiviso: ogni percorso che scrive vettori (nodo rag_ingest,
 * endpoint UI /vector/:id/ingest-text, auto-embed bulk) DEVE passare di qui, così
 * non esiste un path che bypassa il guard o la quota. Non esiste un endpoint HTTP
 * raw di upsert (rimosso): l'enforcement è strutturale, non solo convenzione.
 *
 * VectorService e embedText sono iniettabili (default = reali) per test mirati.
 */
import { VectorService } from './vector.service.js';
import { embedText as defaultEmbedText, dimensionsForModel, type EmbeddingProvider } from './embeddings.service.js';
import { checkVectorQuota, estimateVectorDiskMb, type VectorPlanLimits } from './vector-quota.js';
import { scanForInjection } from '@/executors/rag-guard.js';
import { loadConfig } from '@/config.js';
import { getVectorQuotaOverride } from './vector-quota-flag.service.js';

/**
 * Limiti quota vettoriale del piano. Precedenza: override LIVE (spinto dal portal su
 * cambio piano, Inc.6) > env del container (`MEDEA_PLAN_VECTOR_MAX_*`, set a
 * provision/redeploy). L'override rende up/downgrade effettivo SUBITO, senza
 * dipendere dal recreate del container. null = illimitato.
 */
export function vectorPlanLimitsFromConfig(): VectorPlanLimits {
  const override = getVectorQuotaOverride();
  if (override) return { maxVectors: override.maxVectors, maxDiskMb: override.maxDiskMb };
  const cfg = loadConfig();
  return {
    maxVectors: cfg.MEDEA_PLAN_VECTOR_MAX_VECTORS ?? null,
    maxDiskMb: cfg.MEDEA_PLAN_VECTOR_MAX_DISK_MB ?? null,
  };
}

export type VectorDistance = 'cosine' | 'euclidean' | 'dot';

export interface IngestTextInput {
  databaseId: string;
  collection: string;
  content: string;
  tenantId: string;
  provider: EmbeddingProvider;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  distance?: VectorDistance | undefined;
  /** id esplicito; se assente → hash deterministico del contenuto (idempotenza upsert). */
  id?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  /** limiti del piano; maxVectors/maxDiskMb null = illimitato → quota non interrogata. */
  planLimits: VectorPlanLimits;
}

export interface IngestTextResult {
  id: string;
  upserted: number;
}

export interface IngestDeps {
  vectors?: VectorService;
  embed?: typeof defaultEmbedText;
}

/**
 * Indicizza un singolo contenuto testuale applicando scan + quota + embed + upsert.
 * Lancia se: contenuto vuoto, prompt-injection rilevata, quota superata.
 */
export async function ingestText(input: IngestTextInput, deps: IngestDeps = {}): Promise<IngestTextResult> {
  const vs = deps.vectors ?? new VectorService();
  const embed = deps.embed ?? defaultEmbedText;

  const content = input.content;
  if (content.trim() === '') throw new Error('ingest: contenuto vuoto');

  // SICUREZZA: hard-block (rifiuto di indicizzare) del contenuto con pattern di
  // prompt-injection ad alta confidenza IT/EN. Lo scan normalizza unicode + base64.
  const scan = scanForInjection(content);
  if (!scan.safe) {
    throw new Error(`ingest: contenuto bloccato (possibile prompt-injection: ${scan.reasons.join(', ')})`);
  }

  const id = input.id && input.id.trim() !== '' ? input.id : `c_${simpleHash(content)}`;
  const model = input.model || 'text-embedding-3-small';
  const distance = input.distance ?? 'cosine';
  const payload = input.payload ?? {};

  // QUOTA: limite AGGREGATO per-tenant. net-add 0 se l'id esiste già (re-ingest
  // idempotente = upsert UPDATE) → un re-ingest al limite NON viene bloccato.
  if (input.planLimits.maxVectors !== null || input.planLimits.maxDiskMb !== null) {
    const exists = await vs.recordExists(input.databaseId, input.collection, id, input.tenantId);
    const netAdd = exists ? 0 : 1;
    const addDiskMb = estimateVectorDiskMb(netAdd, dimensionsForModel(model));
    const usage = await vs.tenantVectorUsage(input.tenantId);
    const decision = checkVectorQuota(usage, netAdd, addDiskMb, input.planLimits);
    if (!decision.allowed) throw new Error(`ingest: ${decision.reason ?? 'quota vettoriale superata'}`);
  }

  const vector = await embed({
    provider: input.provider,
    model,
    text: content,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  });
  await vs.ensureCollection(input.databaseId, input.collection, dimensionsForModel(model), distance, input.tenantId);
  const res = await vs.upsert(input.databaseId, input.collection, [{ id, vector, payload: { ...payload, content } }], input.tenantId);

  return { id, upserted: res.count };
}

/**
 * Proiezione quota per un INGEST BULK (auto-embed): controlla UNA volta prima di
 * scrivere, con net-add = numero di item (upper bound conservativo: non scala il
 * costo di N recordExists su migliaia di righe). Se il piano è illimitato → no-op.
 * Lancia se la proiezione supera la quota.
 *
 * Limite noto (documentato): un re-ingest bulk di righe già presenti viene contato
 * come net-add pieno → può rifiutare un'operazione che sarebbe net-zero. Scelta
 * di sicurezza: meglio conservativo che un bypass di quota. Il path single
 * (ingestText) resta preciso col recordExists per-id.
 */
export async function assertBulkQuota(
  tenantId: string,
  itemCount: number,
  model: string,
  planLimits: VectorPlanLimits,
  vs: VectorService = new VectorService(),
): Promise<void> {
  if (planLimits.maxVectors === null && planLimits.maxDiskMb === null) return;
  if (itemCount <= 0) return;
  const addDiskMb = estimateVectorDiskMb(itemCount, dimensionsForModel(model));
  const usage = await vs.tenantVectorUsage(tenantId);
  const decision = checkVectorQuota(usage, itemCount, addDiskMb, planLimits);
  if (!decision.allowed) {
    throw new Error(`auto-embed: ${decision.reason ?? 'quota vettoriale superata'} (richiesti ${itemCount.toString()} vettori)`);
  }
}

/** Hash stabile non-crittografico per id deterministico (idempotenza). */
export function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
