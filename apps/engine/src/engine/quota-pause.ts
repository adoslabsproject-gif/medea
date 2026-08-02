/**
 * Pausa-su-quota: quando uno step LLM esaurisce la quota del tenant (429) e NON
 * c'è una chiave BYOK, il run viene SOSPESO (anziché fallire) e ripreso al
 * rinnovo della quota (giorno di abbonamento). Riusa l'infrastruttura
 * pause/resume esistente (`paused_workflows` + timeout janitor) — vedi
 * `PausedWorkflowsService` e `RunService.resumeFromPause`.
 *
 * Questo modulo è PURO e tiene l'engine DISACCOPPIATO dal layer service:
 * riconosce l'errore quota per FORMA (type-guard strutturale), senza importare
 * `LlmQuotaExceededError` da `services/`.
 *
 * @module engine/quota-pause
 */

/** Prefisso del signal di resume — un run sospeso su quota riprende su questo. */
export const QUOTA_RESUME_SIGNAL_PREFIX = 'quota:renewed:';

/** Nome del signal di resume per un tenant (es. su upgrade il portal può fire-arlo). */
export function quotaResumeSignal(tenantId: string): string {
  return `${QUOTA_RESUME_SIGNAL_PREFIX}${tenantId}`;
}

/**
 * True se il signal di una pausa è una pausa-su-quota (vs wait_signal utente).
 * Difensiva su input non-stringa (righe legacy / cast di test) → false.
 */
export function isQuotaResumeSignal(signalName: string | null | undefined): boolean {
  return typeof signalName === 'string' && signalName.startsWith(QUOTA_RESUME_SIGNAL_PREFIX);
}

/** Forma minima dell'errore quota che serve all'engine (periodEnd per il timeout). */
export interface QuotaPauseError {
  name: 'LlmQuotaExceededError';
  periodEndIso: string | null;
}

function matchQuota(err: unknown): QuotaPauseError | null {
  if (err === null || typeof err !== 'object') return null;
  if ((err as { name?: unknown }).name !== 'LlmQuotaExceededError') return null;
  const periodEndIso = (err as { periodEndIso?: unknown }).periodEndIso;
  return {
    name: 'LlmQuotaExceededError',
    periodEndIso: typeof periodEndIso === 'string' ? periodEndIso : null,
  };
}

/**
 * Type-guard strutturale: riconosce `LlmQuotaExceededError` (services/) senza
 * importarlo. Controlla ANCHE `err.cause`: il middleware `withErrorMapping`
 * della stdlib converte ogni throw in `NodeError(INTERNAL_ERROR)` preservando
 * l'originale in `.cause` (vedi node-error.ts `asNodeError`). Ritorna la forma
 * minima o null.
 */
export function asQuotaPauseError(err: unknown): QuotaPauseError | null {
  const direct = matchQuota(err);
  if (direct) return direct;
  if (err !== null && typeof err === 'object' && 'cause' in err) {
    return matchQuota((err as { cause?: unknown }).cause);
  }
  return null;
}

/** Secondi minimi di sospensione: anti-loop se periodEnd è oggi/passato. */
const MIN_PAUSE_SECONDS = 60;
/** Fallback se periodEnd è ignoto: ricontrolla tra 24h. */
const FALLBACK_PAUSE_SECONDS = 24 * 60 * 60;

/**
 * Secondi fino al rinnovo quota (periodEnd, mezzanotte UTC del giorno di
 * abbonamento). `null`/malformato → 24h. Clamp a ≥60s così il janitor non
 * riprende immediatamente un run la cui quota è ancora esaurita (loop).
 */
export function secondsUntilQuotaReset(
  periodEndIso: string | null,
  now: Date = new Date(),
): number {
  if (!periodEndIso) return FALLBACK_PAUSE_SECONDS;
  const end = new Date(`${periodEndIso}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return FALLBACK_PAUSE_SECONDS;
  const secs = Math.ceil((end.getTime() - now.getTime()) / 1000);
  return Math.max(MIN_PAUSE_SECONDS, secs);
}
