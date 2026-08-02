/**
 * Template Cache Service — Livello 1 per-tenant retrieval.
 *
 * Filosofia: ogni workflow generato con successo dal singleshot scaffold
 * viene salvato come "template" con signature + tokens. Le request future
 * dello stesso tenant cercano match e:
 *   - score >= 0.90 → ritorna template (zero LLM call, ~50ms p99)
 *   - 0.70-0.90 → inject come few-shot example nel prompt (riduce
 *     hallucination + raddoppia precision)
 *   - < 0.70 → fallback singleshot puro
 *
 * Pattern Auth0/Stripe analogo: "smart defaults da pattern noti, AI solo
 * quando serve veramente". Riduce GPU cost del 50-70% su tenant attivi
 * con workflow ripetitivi (la maggior parte).
 *
 * Isolation: SQLite del container = 1 tenant per design, no WHERE
 * tenant_id necessario.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import {
  computeGraphSignature,
  extractDefIds,
  tokenizePrompt,
  jaccardSimilarity,
  defIdOverlap,
  cosineSimilarity,
  computeRetrievalScore,
} from './signature.js';

export interface SaveTemplateInput {
  promptText: string;
  workflow: {
    name: string;
    nodes: { id: string; defId: string }[];
    edges: { from: string; to: string }[];
  };
  workflowJson: string; // pre-serialized workflow JSON
  language?: string; // it/en/... — detect lingua prompt
  embedding?: number[] | null; // BGE-M3 1024d (popolato async, opzionale ora)
}

export interface RetrieveResult {
  template: TemplateRow;
  score: number;
  signals: {
    graphOverlap: number;
    promptJaccard: number;
    successRate: number;
    cosine: number;
  };
  /** Action recommended by score thresholds. */
  action: 'use_direct' | 'inject_fewshot' | 'fallback';
}

export interface TemplateRow {
  id: string;
  promptText: string;
  promptTokens: string[];
  graphSignature: string;
  graphDefIds: string[];
  workflowJson: string;
  name: string;
  language: string;
  embedding: number[] | null;
  importedCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string;
  createdAt: string;
  sharedWithCommunity: boolean;
}

const SCORE_USE_DIRECT = 0.9;
const SCORE_INJECT_FEWSHOT = 0.7;
const MAX_CANDIDATES = 20; // prima del scoring fine (limita SELECT)

function nowIso(): string {
  return new Date().toISOString();
}

function encodeEmbedding(vec: number[]): Buffer {
  // float32 LE for storage compactness (4 bytes/dim vs 8 for float64).
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i] ?? 0, i * 4);
  return buf;
}

function decodeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function rowToTemplate(row: Record<string, unknown>): TemplateRow {
  return {
    id: row.id as string,
    promptText: row.prompt_text as string,
    promptTokens: JSON.parse(row.prompt_tokens_json as string) as string[],
    graphSignature: row.graph_signature as string,
    graphDefIds: JSON.parse(row.graph_def_ids_json as string) as string[],
    workflowJson: row.workflow_json as string,
    name: row.name as string,
    language: row.language as string,
    embedding: decodeEmbedding(row.prompt_embedding as Buffer | null),
    importedCount: row.imported_count as number,
    successCount: row.success_count as number,
    failCount: row.fail_count as number,
    lastUsedAt: row.last_used_at as string,
    createdAt: row.created_at as string,
    sharedWithCommunity: (row.shared_with_community as number) === 1,
  };
}

export class TemplateCacheService {
  /**
   * Salva (o aggiorna se signature identica) un template post-scaffold.
   * Idempotent su graph_signature: stessa pipeline = upsert imported_count++.
   */
  save(input: SaveTemplateInput): TemplateRow {
    const { sqlite } = getDatabase();
    const tokens = tokenizePrompt(input.promptText);
    const signature = computeGraphSignature(input.workflow.nodes, input.workflow.edges);
    const defIds = extractDefIds(input.workflow.nodes);
    const now = nowIso();
    const language = input.language ?? 'it';
    const embeddingBuf = input.embedding ? encodeEmbedding(input.embedding) : null;
    const embeddedAt = input.embedding ? now : null;

    // Idempotency: se esiste gia\` template con stessa signature, bump
    // imported_count + last_used_at + override workflow_json (potrebbe
    // essere migliorato). Altrimenti insert nuovo.
    const existing = sqlite
      .prepare(
        `SELECT id, imported_count FROM ai_workflow_templates WHERE graph_signature = ? LIMIT 1`,
      )
      .get(signature) as { id: string; imported_count: number } | undefined;

    if (existing) {
      sqlite
        .prepare(
          `UPDATE ai_workflow_templates SET
           prompt_text = ?,
           prompt_tokens_json = ?,
           workflow_json = ?,
           name = ?,
           language = ?,
           prompt_embedding = COALESCE(?, prompt_embedding),
           embedded_at = COALESCE(?, embedded_at),
           imported_count = imported_count + 1,
           last_used_at = ?
         WHERE id = ?`,
        )
        .run(
          input.promptText,
          JSON.stringify(tokens),
          input.workflowJson,
          input.workflow.name,
          language,
          embeddingBuf,
          embeddedAt,
          now,
          existing.id,
        );
      logger.info(
        { id: existing.id, signature, importedCount: existing.imported_count + 1 },
        '[template-cache] upserted',
      );
      return this.getById(existing.id)!;
    }

    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO ai_workflow_templates (
        id, prompt_text, prompt_tokens_json, graph_signature, graph_def_ids_json,
        workflow_json, name, language, prompt_embedding, embedded_at,
        imported_count, success_count, fail_count, last_used_at, created_at,
        shared_with_community
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 0)`,
      )
      .run(
        id,
        input.promptText,
        JSON.stringify(tokens),
        signature,
        JSON.stringify(defIds),
        input.workflowJson,
        input.workflow.name,
        language,
        embeddingBuf,
        embeddedAt,
        now,
        now,
      );
    logger.info({ id, signature, nodes: defIds.length }, '[template-cache] saved new');
    return this.getById(id)!;
  }

  getById(id: string): TemplateRow | null {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`SELECT * FROM ai_workflow_templates WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTemplate(row) : null;
  }

  /**
   * Retrieve best matching template for a new prompt.
   * Algorithm:
   *   1. SELECT candidates: tutti i template language-match + ordina per
   *      last_used DESC, limit MAX_CANDIDATES (caldo + recente).
   *   2. Score ogni candidato (graph + jaccard + success + cosine se emb).
   *   3. Ritorna best score + action threshold.
   *   4. Se 0 template → null (fallback singleshot).
   */
  retrieve(opts: {
    promptText: string;
    language?: string;
    queryEmbedding?: number[] | null;
  }): RetrieveResult | null {
    const { sqlite } = getDatabase();
    const tokens = tokenizePrompt(opts.promptText);
    const language = opts.language ?? 'it';
    const candidates = sqlite
      .prepare(
        `SELECT * FROM ai_workflow_templates
       WHERE language = ?
       ORDER BY last_used_at DESC
       LIMIT ?`,
      )
      .all(language, MAX_CANDIDATES) as Record<string, unknown>[];

    if (candidates.length === 0) return null;

    let best: RetrieveResult | null = null;
    for (const row of candidates) {
      const tmpl = rowToTemplate(row);
      const totalRuns = tmpl.successCount + tmpl.failCount;
      const successRate = totalRuns >= 3 ? tmpl.successCount / totalRuns : 0.5; // neutral fino a 3+ runs
      const graphOverlap = defIdOverlap(
        extractDefIds(parseDefIdsFromTokens(tmpl.promptTokens)),
        tmpl.graphDefIds,
      );
      // Override graphOverlap: usare il vero overlap su defId del template
      // (non sui token del prompt, che NON sono defId). Calcolato meglio
      // sotto, qui per ora 0 — il prompt jaccard fa il lavoro.
      // FIX: per L1 con prompt-only (no graph from query), usa solo jaccard
      // sui token del query vs token del template prompt.
      const promptJaccard = jaccardSimilarity(tokens, tmpl.promptTokens);
      const cosine =
        opts.queryEmbedding && tmpl.embedding
          ? Math.max(0, cosineSimilarity(opts.queryEmbedding, tmpl.embedding))
          : 0;
      // graphOverlap qui = 0 perche\` non abbiamo defId del query.
      // Sara\` ricalcolato dopo singleshot generation (POST validation)
      // se serve. Per ora il signal e\` 0.
      const score = computeRetrievalScore({ graphOverlap: 0, promptJaccard, successRate, cosine });
      if (best === null || score > best.score) {
        const action: RetrieveResult['action'] =
          score >= SCORE_USE_DIRECT
            ? 'use_direct'
            : score >= SCORE_INJECT_FEWSHOT
              ? 'inject_fewshot'
              : 'fallback';
        best = {
          template: tmpl,
          score,
          signals: { graphOverlap, promptJaccard, successRate, cosine },
          action,
        };
      }
    }

    return best;
  }

  /**
   * Lookup per graph signature — il ponte run→template del feedback loop:
   * a fine run si calcola la signature del workflow eseguito e, se combacia
   * con un template, l'esito alimenta recordOutcome (rank boost/penalty).
   * Zero modifiche allo schema Workflow: il matching è strutturale.
   */
  findIdBySignature(graphSignature: string): string | null {
    try {
      const { sqlite } = getDatabase();
      const row = sqlite
        .prepare(`SELECT id FROM ai_workflow_templates WHERE graph_signature = ? LIMIT 1`)
        .get(graphSignature) as { id: string } | undefined;
      return row?.id ?? null;
    } catch {
      return null; // fail-soft: il feedback è best-effort, mai rompe un run
    }
  }

  /**
   * Bump success/fail counters quando un workflow basato su template
   * runa successfully / fails. Usato per rank boost/penalty.
   */
  recordOutcome(templateId: string, ok: boolean): void {
    const { sqlite } = getDatabase();
    const col = ok ? 'success_count' : 'fail_count';
    sqlite
      .prepare(
        `UPDATE ai_workflow_templates SET ${col} = ${col} + 1, last_used_at = ? WHERE id = ?`,
      )
      .run(nowIso(), templateId);
  }

  /**
   * List templates (per UI gallery — Settings → AI Templates).
   * Default top 50 by imported_count.
   */
  list(opts?: { limit?: number }): TemplateRow[] {
    const { sqlite } = getDatabase();
    const limit = opts?.limit ?? 50;
    const rows = sqlite
      .prepare(
        `SELECT * FROM ai_workflow_templates ORDER BY imported_count DESC, last_used_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToTemplate);
  }

  /**
   * Hard-delete template (GDPR right-to-erasure on individual entry).
   */
  delete(id: string): boolean {
    const { sqlite } = getDatabase();
    const r = sqlite.prepare(`DELETE FROM ai_workflow_templates WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /**
   * Aggregate metrics: cache hit rate, GPU savings estimate, top templates.
   *
   * Modello:
   *   - 1 save = 1 inserzione iniziale (cache miss, LLM call paid)
   *   - imported_count > 1 = N-1 hit (cache reuse, zero LLM call)
   *   - GPU savings: ~60s per cache hit (stima conservativa avg LLM call)
   */
  getMetrics(): {
    templatesCount: number;
    totalImports: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    gpuSecondsSaved: number;
    topTemplates: { id: string; name: string; importedCount: number; successRate: number }[];
    embeddedCount: number;
  } {
    const { sqlite } = getDatabase();
    const agg = sqlite
      .prepare(
        `SELECT
        COUNT(*) AS cnt,
        COALESCE(SUM(imported_count), 0) AS total_imports,
        COALESCE(SUM(CASE WHEN embedded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded
      FROM ai_workflow_templates`,
      )
      .get() as { cnt: number; total_imports: number; embedded: number };
    const templatesCount = agg.cnt;
    const totalImports = agg.total_imports;
    const cacheMisses = templatesCount;
    const cacheHits = Math.max(0, totalImports - cacheMisses);
    const cacheHitRate = totalImports > 0 ? cacheHits / totalImports : 0;
    const gpuSecondsSaved = cacheHits * 60;
    const topRows = sqlite
      .prepare(
        `SELECT id, name, imported_count, success_count, fail_count
       FROM ai_workflow_templates
       ORDER BY imported_count DESC, success_count DESC
       LIMIT 10`,
      )
      .all() as {
      id: string;
      name: string;
      imported_count: number;
      success_count: number;
      fail_count: number;
    }[];
    const topTemplates = topRows.map((r) => {
      const total = r.success_count + r.fail_count;
      return {
        id: r.id,
        name: r.name,
        importedCount: r.imported_count,
        successRate: total >= 3 ? r.success_count / total : 0,
      };
    });
    return {
      templatesCount,
      totalImports,
      cacheHits,
      cacheMisses,
      cacheHitRate,
      gpuSecondsSaved,
      topTemplates,
      embeddedCount: agg.embedded,
    };
  }
}

/**
 * Helper inline: estrae potenziali defId dai token (heuristic) — usato
 * SOLO per il graphOverlap signal del retrieve(), che e\` corrente a 0.
 * Mantenuto come placeholder per la future "second pass" retrieval.
 */
function parseDefIdsFromTokens(tokens: readonly string[]): { defId: string }[] {
  return tokens
    .filter((t) => /^(trigger|action|agent|community|logic|db)_/.test(t))
    .map((defId) => ({ defId }));
}

export const templateCache = new TemplateCacheService();
