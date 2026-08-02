/**
 * Embedding client — chiama BGE-M3 via portal gateway /api/v1/llm/embed.
 *
 * Auth: license key (MEDEA_LICENSE_KEY env, gia\` usato da llm-chat).
 * Circuit breaker: 5 fail consecutive → OPEN 15s → degradation graceful
 * (return null, cosine signal in template-cache resta 0 = solo
 * graph+jaccard scoring).
 *
 * Pattern allineato a `apps/liara/src/lib/embedding.ts` per consistency.
 */

import { CircuitBreaker } from '@medea/engine-shared';
import { readJsonCapped } from '@/lib/capped-response.js';
import { logger } from '@/lib/logger.js';

const PORTAL_URL = process.env.MEDEA_PORTAL_URL ?? 'http://172.20.0.1:3006';
const LICENSE_KEY = process.env.MEDEA_LICENSE_KEY ?? '';
const EMBED_URL = `${PORTAL_URL}/api/v1/llm/embed`;
const TIMEOUT_MS = 3_000;
export const EMBEDDING_DIMENSIONS = 1024;

const breaker = new CircuitBreaker('template-embedding', {
  failureThreshold: 5,
  resetTimeout: 15_000,
  successThreshold: 2,
  probeTimeout: 5_000,
  onStateChange: (from, to, name) => {
    logger.warn({ name, from, to }, '[template-cache embedding CB] state change');
  },
});

/**
 * Genera embedding 1024d via BGE-M3. Null on any failure (timeout,
 * CB open, server error) — template-cache continua a funzionare con
 * jaccard-only scoring.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!LICENSE_KEY) {
    logger.debug('[template-cache embedding] MEDEA_LICENSE_KEY missing — skip');
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // BGE-M3 max context ~8K char, ma il prompt e\` di solito < 500 char.
  const safeText = trimmed.length > 8000 ? trimmed.slice(0, 8000) : trimmed;
  try {
    return await breaker.execute(async () => {
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LICENSE_KEY}`,
        },
        body: JSON.stringify({ text: safeText }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`embed ${res.status.toString()}`);
      const data = await readJsonCapped<{ embedding: number[]; dimensions: number }>(res);
      if (!Array.isArray(data.embedding) || data.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`unexpected embedding shape (len=${data.embedding?.length ?? 0})`);
      }
      return data.embedding;
    });
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[template-cache embedding] failed (graceful)',
    );
    return null;
  }
}
