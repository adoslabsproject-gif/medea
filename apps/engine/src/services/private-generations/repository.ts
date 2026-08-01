/**
 * Repository delle generazioni: salva (blob + riga), vota, elenca.
 *
 * Tutte le scritture passano per i metodi PARAMETRIZZATI di DbStudioService
 * (`insert`/`updateRow`/`query`) → niente SQL costruito con input utente. I
 * byte del media vanno nel BinaryStore content-addressed; la riga porta solo
 * il `media_ref` (sha256) + i metadati.
 *
 * @module services/private-generations/repository
 */
import { randomUUID } from 'node:crypto';
import { GENERATIONS_TABLE, RATINGS, type Rating } from './schema.js';
import type {
  BlobStorePort,
  ConversationItem,
  ConversationSummary,
  DbStudioPort,
  GenerationRecord,
  SaveGenerationInput,
  SaveGenerationResult,
} from './types.js';

export interface RepoDeps {
  dbStudio: DbStudioPort;
  blobStore: BlobStorePort;
  tenantId: string;
  dbId: string;
}

/** Salva i byte nel blob-store e inserisce la riga. Ritorna id + ref. */
export async function saveGeneration(deps: RepoDeps, input: SaveGenerationInput): Promise<SaveGenerationResult> {
  if (input.bytes.length === 0) throw new Error('media vuoto (0 byte)');
  // ⛔ NIENTE obbligo di prompt: una generazione SENZA testo è legittima
  // (es. "anima" = i2v da foto, img2img puro). Bug 2026-06-18: l'obbligo faceva
  // fallire il SALVATAGGIO di un video i2v già generato (21 min di GPU sprecati) con
  // "prompt mancante". Il media è il dato che conta; il prompt è opzionale.

  const { ref, size } = await deps.blobStore.writeBuffer(input.bytes);
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    created_at: new Date().toISOString(),
    kind: input.kind,
    prompt: input.prompt,
    negative: input.negative ?? null,
    params: input.params ? JSON.stringify(input.params) : null,
    seed: input.seed ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    checkpoint: input.checkpoint ?? null,
    mime: input.mime,
    media_ref: ref,
    size_bytes: size,
    rating: null,
    notes: null,
    conversation_id: input.conversationId ?? null,
  };
  await deps.dbStudio.insert(deps.dbId, GENERATIONS_TABLE, row, deps.tenantId);
  return { id, mediaRef: ref, size };
}

/** Imposta/azzera il voto di una generazione. `null` = togli il voto. */
export async function rateGeneration(deps: RepoDeps, id: string, rating: Rating | null): Promise<void> {
  if (!id.trim()) throw new Error('id mancante');
  if (rating !== null && !RATINGS.includes(rating)) throw new Error(`rating non valido: ${String(rating)}`);
  await deps.dbStudio.updateRow(deps.dbId, GENERATIONS_TABLE, { id }, { rating }, deps.tenantId);
}

/** Stringa sicura da un valore DB `unknown` (mai '[object Object]'). */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

/** Estrae l'array righe dal risultato (forma variabile dell'adapter). */
function extractRows(result: unknown): Record<string, unknown>[] {
  if (result === null || typeof result !== 'object') return [];
  const r = result as { rows?: unknown; statementResults?: { rows?: unknown }[] };
  const rows = r.rows ?? r.statementResults?.[0]?.rows ?? [];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Ultime N generazioni (default 50), più recenti prima. */
export async function listGenerations(deps: RepoDeps, limit = 50): Promise<GenerationRecord[]> {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const result = await deps.dbStudio.query(
    deps.dbId,
    { table: GENERATIONS_TABLE, filters: [], orderBy: [{ column: 'created_at', direction: 'desc' }], limit: safeLimit },
    deps.tenantId,
  );
  return extractRows(result).map((row): GenerationRecord => ({
    id: asText(row.id),
    created_at: asText(row.created_at),
    kind: asText(row.kind),
    prompt: asText(row.prompt),
    negative: row.negative === null || row.negative === undefined ? null : asText(row.negative),
    seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
    rating: row.rating === 'up' || row.rating === 'down' ? row.rating : null,
    mime: asText(row.mime),
    media_ref: asText(row.media_ref),
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
  }));
}

/** Conversation id ammesso: alfanumerico + trattini (no injection nelle query raw). */
const CONV_RE = /^[\w-]{1,64}$/;
function assertConv(id: string): string {
  if (!CONV_RE.test(id)) throw new Error('conversation id non valido');
  return id;
}

/** Lista conversazioni (raggruppa per conversation_id): id, n. elementi, ultima data, un prompt come titolo. */
export async function listConversations(deps: RepoDeps): Promise<ConversationSummary[]> {
  const sql = `SELECT conversation_id AS id, COUNT(*) AS n, MAX(created_at) AS last, MAX(prompt) AS title `
    + `FROM ${GENERATIONS_TABLE} WHERE conversation_id IS NOT NULL AND conversation_id != '' `
    + `GROUP BY conversation_id ORDER BY last DESC LIMIT 200`;
  const res = await deps.dbStudio.executeRaw(deps.dbId, sql, { dryRun: false, rowLimit: 200 }, deps.tenantId);
  return extractRows(res).map((r) => ({
    id: asText(r.id),
    count: Number(r.n) || 0,
    lastAt: asText(r.last),
    title: asText(r.title) || '(senza prompt)',
  }));
}

/** Elementi di una conversazione (per ri-renderizzarla), ordine cronologico. */
export async function getConversation(deps: RepoDeps, convId: string): Promise<ConversationItem[]> {
  const id = assertConv(convId);
  const sql = `SELECT id, created_at, kind, prompt, media_ref, mime, rating FROM ${GENERATIONS_TABLE} `
    + `WHERE conversation_id = '${id}' ORDER BY created_at ASC LIMIT 500`;
  const res = await deps.dbStudio.executeRaw(deps.dbId, sql, { dryRun: false, rowLimit: 500 }, deps.tenantId);
  return extractRows(res).map((r) => ({
    id: asText(r.id),
    created_at: asText(r.created_at),
    kind: asText(r.kind),
    prompt: asText(r.prompt),
    media_ref: asText(r.media_ref),
    mime: asText(r.mime),
    rating: r.rating === 'up' || r.rating === 'down' ? r.rating : null,
  }));
}

/** Una singola generazione per id (per l'estensione video): media_ref + params + prompt. */
export async function getGeneration(deps: RepoDeps, id: string): Promise<{ prompt: string; mime: string; mediaRef: string; kind: string; params: Record<string, unknown> } | null> {
  const safe = assertConv(id); // stesso formato sicuro (uuid/alnum-trattini) → no injection
  const sql = `SELECT prompt, mime, media_ref, kind, params FROM ${GENERATIONS_TABLE} WHERE id = '${safe}' LIMIT 1`;
  const res = await deps.dbStudio.executeRaw(deps.dbId, sql, { dryRun: false, rowLimit: 1 }, deps.tenantId);
  const rows = extractRows(res);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  let params: Record<string, unknown> = {};
  try {
    const raw = asText(r.params);
    if (raw) params = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* params malformati → {} */ }
  return { prompt: asText(r.prompt), mime: asText(r.mime), mediaRef: asText(r.media_ref), kind: asText(r.kind), params };
}

/** Cancella tutte le generazioni di una conversazione (i blob restano: content-addressed, GC li ripulisce). */
export async function deleteConversation(deps: RepoDeps, convId: string): Promise<void> {
  const id = assertConv(convId);
  await deps.dbStudio.executeRaw(deps.dbId, `DELETE FROM ${GENERATIONS_TABLE} WHERE conversation_id = '${id}'`, { dryRun: false, rowLimit: 0 }, deps.tenantId);
}
