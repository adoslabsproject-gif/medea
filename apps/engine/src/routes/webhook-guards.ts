/**
 * Guardie di ingresso webhook — rate-limit + idempotency + audit (review nodi #4).
 *
 * La description di trigger_webhook prometteva "rate-limit configurabile",
 * "dedup via header Idempotency-Key" e "audit on-hit con body_hash": NON erano
 * implementate (claim fantasma rimosso, poi RIPRISTINATO implementandolo qui).
 * Estratto da webhooks.ts (già 675 righe) in modulo dedicato e PURO (clock
 * iniettabile) → testabile senza rete, cap di memoria bounded.
 *
 * Tutte le cache sono in-process (come l'anti-replay HMAC esistente): un webhook
 * gira nel container del tenant, non serve store condiviso.
 */

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit per-webhook (fixed window 1 min).
// Chiave consigliata: `${nodeId}:${ip}` → un IP abusivo non esaurisce la quota
// degli altri chiamanti dello stesso webhook.
// ─────────────────────────────────────────────────────────────────────────────

interface RateWindow { count: number; resetAtMs: number }
const WINDOW_MS = 60_000;
const RATE_CACHE_CAP = 10_000;
const rateWindows = new Map<string, RateWindow>();

export interface RateLimitResult {
  allowed: boolean;
  /** Secondi al reset della finestra (per Retry-After) — 0 se permesso. */
  retryAfterSec: number;
  /** Richieste ancora disponibili nella finestra corrente. */
  remaining: number;
}

/**
 * Conta la request nella finestra corrente. `limitPerMin <= 0` = rate-limit
 * DISABILITATO (passa sempre). Supera il limite → allowed=false + Retry-After.
 */
export function checkWebhookRateLimit(key: string, limitPerMin: number, now: number = Date.now()): RateLimitResult {
  if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) {
    return { allowed: true, retryAfterSec: 0, remaining: Number.POSITIVE_INFINITY };
  }
  let w = rateWindows.get(key);
  if (!w || w.resetAtMs <= now) {
    w = { count: 0, resetAtMs: now + WINDOW_MS };
    rateWindows.set(key, w);
  }
  w.count += 1;
  if (rateWindows.size > RATE_CACHE_CAP) gcRate(now);
  if (w.count > limitPerMin) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAtMs - now) / 1000)), remaining: 0 };
  }
  return { allowed: true, retryAfterSec: 0, remaining: limitPerMin - w.count };
}

function gcRate(now: number): void {
  for (const [k, w] of rateWindows) {
    if (w.resetAtMs <= now) rateWindows.delete(k);
  }
}

export function __resetWebhookRateLimit(): void {
  rateWindows.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency-Key dedup (LRU con TTL). Una request con lo stesso Idempotency-Key
// (header) già vista entro il TTL viene riconosciuta come duplicato → il workflow
// NON viene rieseguito (pattern Stripe: i retry del client sono safe).
// ─────────────────────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h (standard provider)
const IDEMPOTENCY_CAP = 50_000;
const idempotencySeen = new Map<string, number>(); // `${nodeId}:${key}` → expiresAtMs

/**
 * true = Idempotency-Key GIÀ visto entro il TTL (duplicato → skip esecuzione).
 * false = prima volta (registrato → procedi). Chiave vuota → mai duplicato
 * (l'header è assente: nessuna semantica di idempotenza richiesta).
 */
export function webhookIdempotencySeen(
  nodeId: string,
  idempotencyKey: string,
  now: number = Date.now(),
  ttlMs: number = IDEMPOTENCY_TTL_MS,
): boolean {
  if (idempotencyKey === '') return false;
  const k = `${nodeId}:${idempotencyKey}`;
  const existing = idempotencySeen.get(k);
  if (existing !== undefined && existing > now) {
    // Refresh LRU recency senza estendere la scadenza logica.
    return true;
  }
  if (idempotencySeen.size >= IDEMPOTENCY_CAP) {
    const oldest = idempotencySeen.keys().next().value;
    if (oldest !== undefined) idempotencySeen.delete(oldest);
  }
  idempotencySeen.set(k, now + ttlMs);
  return false;
}

export function __resetWebhookIdempotency(): void {
  idempotencySeen.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit on-hit: digest del body per forensics SENZA loggare PII/payload in chiaro.
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 esadecimale del raw body — identifica payload duplicati/manomessi senza esporli. */
export function bodyHash(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf-8').digest('hex');
}
