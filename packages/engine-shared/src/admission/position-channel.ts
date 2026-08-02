/**
 * Canale-posizione (sidecar) — pubblica la posizione in coda di una richiesta
 * su Redis, correlata da `requestId`, così un endpoint di status SSE può
 * streammarla al client SENZA inquinare lo stream LLM (OpenAI) sottostante.
 *
 * Stato per chiave `liara:adm:pos:<requestId>` (JSON, TTL breve auto-pulente):
 *   - { s:'q', p, a }  → in coda: posizione 1-based `p`, davanti `a`
 *   - { s:'a' }        → ammessa (lo slot è stato ottenuto)
 *   - chiave assente   → 'gone' (mai esistita, scaduta, o pulita)
 *
 * TTL: la posizione è effimera (vale solo durante l'attesa). Se il publisher
 * muore, la chiave scade da sola → nessuno stato fantasma.
 *
 * @module admission/position-channel
 */

/** Subset Redis per il canale posizione — strutturale → mockabile. */
export interface PositionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export type QueuePosition =
  | { state: 'queued'; position: number; ahead: number }
  | { state: 'admitted' }
  | { state: 'gone' };

const DEFAULT_TTL_SEC = 30;

function keyFor(requestId: string): string {
  return `liara:adm:pos:${requestId}`;
}

/** Pubblica la posizione in coda (TTL breve). */
export async function publishQueued(
  redis: PositionRedis,
  requestId: string,
  pos: { position: number; ahead: number },
  ttlSeconds: number = DEFAULT_TTL_SEC,
): Promise<void> {
  await redis.set(
    keyFor(requestId),
    JSON.stringify({ s: 'q', p: pos.position, a: pos.ahead }),
    'EX',
    ttlSeconds,
  );
}

/** Segnala che la richiesta è stata AMMESSA (il client può smettere di attendere). */
export async function publishAdmitted(
  redis: PositionRedis,
  requestId: string,
  ttlSeconds: number = DEFAULT_TTL_SEC,
): Promise<void> {
  await redis.set(keyFor(requestId), JSON.stringify({ s: 'a' }), 'EX', ttlSeconds);
}

/** Legge lo stato corrente. Chiave assente o malformata → 'gone' (fail-safe). */
export async function readPosition(
  redis: PositionRedis,
  requestId: string,
): Promise<QueuePosition> {
  const raw = await redis.get(keyFor(requestId));
  if (raw === null || raw === '') return { state: 'gone' };
  try {
    const v = JSON.parse(raw) as { s?: unknown; p?: unknown; a?: unknown };
    if (v.s === 'a') return { state: 'admitted' };
    if (v.s === 'q' && typeof v.p === 'number' && typeof v.a === 'number') {
      return { state: 'queued', position: v.p, ahead: v.a };
    }
    return { state: 'gone' };
  } catch {
    return { state: 'gone' };
  }
}

/** Pulisce la chiave (fine richiesta). Idempotente. */
export async function clearPosition(redis: PositionRedis, requestId: string): Promise<void> {
  await redis.del(keyFor(requestId));
}
