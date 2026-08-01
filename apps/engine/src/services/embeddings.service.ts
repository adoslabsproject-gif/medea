/**
 * Embeddings provider switchboard — extracted so any service / route can
 * compute a vector for a string without going through an AI-agent node.
 *
 * Providers supported: openai, voyage, ollama. Returns float[] of fixed
 * dimensionality (3072 for text-embedding-3-large, 1536 for 3-small,
 * provider-specific otherwise). Caller is responsible for ensuring the
 * collection's `dimensions` matches the chosen model.
 */

import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

export type EmbeddingProvider = 'openai' | 'voyage' | 'ollama';

export interface EmbeddingRequest {
  provider: EmbeddingProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  text: string;
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-large-2': 1536,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
};

export function dimensionsForModel(model: string): number {
  return DEFAULT_DIMENSIONS[model] ?? 1536;
}

export async function embedText(req: EmbeddingRequest): Promise<number[]> {
  const { provider, apiKey, model, baseUrl, text } = req;
  if (text.trim() === '') return new Array<number>(dimensionsForModel(model)).fill(0);

  switch (provider) {
    case 'openai': {
      if (!apiKey) throw new Error('OpenAI embeddings require an API key');
      const res = await safeOutboundFetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'text-embedding-3-small', input: text }),
        spanName: 'embed.openai',
      });
      if (!res.ok) throw new Error(`OpenAI embed ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 300)}`);
      const data = await readJsonCapped<{ data: { embedding: number[] }[] }>(res);
      return data.data[0]?.embedding ?? [];
    }
    case 'voyage': {
      if (!apiKey) throw new Error('Voyage embeddings require an API key');
      const res = await safeOutboundFetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'voyage-3', input: text }),
        spanName: 'embed.voyage',
      });
      if (!res.ok) throw new Error(`Voyage embed ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 300)}`);
      const data = await readJsonCapped<{ data: { embedding: number[] }[] }>(res);
      return data.data[0]?.embedding ?? [];
    }
    case 'ollama': {
      const url = `${baseUrl ?? 'http://localhost:11434'}/api/embeddings`;
      // ollama = server self-hosted (default loopback) → allowPrivateHost per non
      // farsi bloccare dal SSRF guard sul localhost. baseUrl è config server-side.
      const res = await safeOutboundFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'nomic-embed-text', prompt: text }),
        allowPrivateHost: true,
        spanName: 'embed.ollama',
      });
      if (!res.ok) throw new Error(`Ollama embed ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 300)}`);
      const data = await readJsonCapped<{ embedding: number[] }>(res);
      return data.embedding;
    }
    default:
      throw new Error(`Unknown embedding provider: ${String(provider)}`);
  }
}

/**
 * Batch embedding with rate-limit-friendly serial execution. We intentionally
 * avoid parallelism here because most providers throttle low-tier keys, and a
 * naive Promise.all over 10k rows would burn through quotas instantly.
 */
export async function embedBatch(
  req: Omit<EmbeddingRequest, 'text'>,
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? '';
    out.push(await embedText({ ...req, text }));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return out;
}
