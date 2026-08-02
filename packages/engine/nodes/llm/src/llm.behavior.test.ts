/**
 * Behavior test — nodi LLM/RAG (review nodi 2026-06-20).
 *
 * Verifica con transport mockato (ma readJsonCapped + circuit breaker REALI):
 *  1. ai_gemini: la API key viaggia nell'HEADER x-goog-api-key, MAI nella query
 *     string dell'URL (no leak su log/breaker-key/redirect cross-host).
 *  2. ai_embed / ai_rag_search: la shape di output PROMESSA dalla description
 *     coincide con quella REALMENTE prodotta (anti-aspirazionale: prima la
 *     description citava tokensUsed / matches / queryEmbedding / k inesistenti).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';

const m = vi.hoisted(() => ({ fetch: vi.fn<(...a: unknown[]) => Promise<Response>>() }));
vi.mock('@medea/engine-safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: (...a: unknown[]) => m.fetch(...a),
}));

import { aiGeminiNode } from './index.js';
import { aiEmbedNode, aiRagSearchNode } from './rag.js';

function ctx(): NodeExecutionContext {
  return { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };
}
const jsonRes = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => { m.fetch.mockReset(); });

describe('ai_gemini — API key nell\'header, mai in URL', () => {
  it('🚨 key in x-goog-api-key header; query string SENZA key (anti-leak)', async () => {
    m.fetch.mockResolvedValue(jsonRes({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const r = await aiGeminiNode.executor!(
      { apiKey: 'SECRET_KEY_123', model: 'gemini-2.0-flash', prompt: 'ciao' }, undefined, ctx(),
    );
    const [url, init] = m.fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).not.toContain('key=');
    expect(url).not.toContain('SECRET_KEY_123');
    expect(init.headers['x-goog-api-key']).toBe('SECRET_KEY_123');
    expect((r.output as { text: string }).text).toBe('ok');
  });
});

describe('ai_embed — shape output = description', () => {
  it('🚨 output { text, vector, dimensions, provider, model, tokensUsed } + tokensUsed da usage', async () => {
    m.fetch.mockResolvedValue(jsonRes({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { total_tokens: 7 } }));
    const r = await aiEmbedNode.executor!(
      { provider: 'openai', apiKey: 'k', text: 'ciao mondo' }, undefined, ctx(),
    );
    expect(Object.keys(r.output as object).sort()).toEqual(['dimensions', 'model', 'provider', 'text', 'tokensUsed', 'vector']);
    const out = r.output as { vector: number[]; dimensions: number; tokensUsed: number | null };
    expect(out.vector).toEqual([0.1, 0.2, 0.3]);
    expect(out.dimensions).toBe(3);
    expect(out.tokensUsed).toBe(7); // estratto da usage.total_tokens (IMPLEMENTATO, non più fantasma)
    expect(aiEmbedNode.def.description).toContain('tokensUsed');
  });

  it('tokensUsed = null quando il provider non riporta usage (es. Ollama)', async () => {
    m.fetch.mockResolvedValue(jsonRes({ data: [{ embedding: [1] }] })); // niente usage
    const r = await aiEmbedNode.executor!({ provider: 'openai', apiKey: 'k', text: 'x' }, undefined, ctx());
    expect((r.output as { tokensUsed: number | null }).tokensUsed).toBeNull();
  });
});

describe('ai_rag_search — shape output = description', () => {
  it('🚨 output = { query, results, count } (no matches/queryEmbedding/k fantasma)', async () => {
    // 1ª fetch = embed query (openai); 2ª = search runtime → { results, count }.
    m.fetch
      .mockResolvedValueOnce(jsonRes({ data: [{ embedding: [1, 0, 0] }] }))
      .mockResolvedValueOnce(jsonRes({ results: [{ id: 'a', score: 0.9, payload: { content: 'x' } }], count: 1 }));
    const r = await aiRagSearchNode.executor!(
      { databaseId: 'db1', collection: 'col', embedProvider: 'openai', apiKey: 'k', queryText: 'domanda' },
      undefined, ctx(),
    );
    expect(Object.keys(r.output as object).sort()).toEqual(['count', 'query', 'results']);
    const out = r.output as { query: string; results: { id: string }[]; count: number };
    expect(out.query).toBe('domanda');
    expect(out.results[0]?.id).toBe('a');
    expect(out.count).toBe(1);
    const desc = aiRagSearchNode.def.description;
    // 'matches' resta lecito nella prosa ("top-K matches"); il fantasma è la FIRMA
    // d'output: niente queryEmbedding, e l'Output esplicito deve citare results/count.
    expect(desc).not.toContain('queryEmbedding');
    expect(desc).toContain('results: [{ id, score, payload }]');
    expect(desc).toContain('count');
  });
});
