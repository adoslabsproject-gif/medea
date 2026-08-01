/**
 * Client S2S runtime→portal per l'usato quota token del PERIODO corrente.
 *
 * La tabella `llm_quotas` e l'enforcement vivono nel PORTAL: il container tenant
 * non vi accede direttamente. Prima il runtime stubava `tokensUsedMonth: null`
 * → il PlanUsageWidget mostrava SEMPRE 0. Qui leggiamo il dato reale via
 * `GET /api/v1/internal/quota-usage/:workspaceId`.
 *
 * Fail-soft: qualunque errore/timeout → `null` (il widget degrada con grazia,
 * non rompe). Cache TTL 25s < poll widget 30s → al massimo ~1 call/poll/tenant.
 *
 * @module services/portal-quota.service
 */
import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';
import { logger } from '@/lib/logger.js';

const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://host.docker.internal:3006';
const CACHE_TTL_MS = 25_000;
const FETCH_TIMEOUT_MS = 4_000;

export interface PortalTokenUsage {
  tokensUsed: number;
  tokensLimit: number | null;
  periodStartIso: string;
  periodEndIso: string;
  /** Limite sub-users del piano (null = illimitato). */
  maxUsers: number | null;
}

interface CacheEntry {
  at: number;
  data: PortalTokenUsage | null;
}
const cache = new Map<string, CacheEntry>();

interface QuotaUsageResponse {
  ok?: boolean;
  tokensUsed?: number;
  tokensLimit?: number | null;
  periodStartIso?: string;
  periodEndIso?: string;
  maxUsers?: number | null;
}

/**
 * Recupera l'usato quota token del workspace dal portal. `null` su QUALSIASI
 * errore (rete/timeout/non-200/payload malformato) — il chiamante degrada con
 * grazia. `now` iniettabile per test deterministici della cache.
 */
export async function fetchPortalTokenUsage(
  workspaceId: string,
  now: number = Date.now(),
): Promise<PortalTokenUsage | null> {
  const cached = cache.get(workspaceId);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  let data: PortalTokenUsage | null = null;
  try {
    const url = `${PORTAL_URL.replace(/\/$/, '')}/api/v1/internal/quota-usage/${workspaceId}`;
    const res = await internalAwareFetch(url, {
      headers: { 'X-Internal-Token': getOutboundPortalToken() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as QuotaUsageResponse;
      if (
        body.ok === true &&
        typeof body.tokensUsed === 'number' &&
        typeof body.periodStartIso === 'string' &&
        typeof body.periodEndIso === 'string'
      ) {
        data = {
          tokensUsed: body.tokensUsed,
          tokensLimit: typeof body.tokensLimit === 'number' ? body.tokensLimit : null,
          periodStartIso: body.periodStartIso,
          periodEndIso: body.periodEndIso,
          maxUsers: typeof body.maxUsers === 'number' ? body.maxUsers : null,
        };
      } else {
        logger.warn({ workspaceId }, '[PORTAL_QUOTA] payload malformato');
      }
    } else {
      logger.warn({ status: res.status, workspaceId }, '[PORTAL_QUOTA] non-200');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      '[PORTAL_QUOTA] fetch failed',
    );
  }
  cache.set(workspaceId, { at: now, data });
  return data;
}

/**
 * Riporta al portal i token AI spesi su un percorso HOST-INTERNO che non passa
 * dal gateway license (metering gamba vision di agent_video_summarizer —
 * follow-up Fase 2 #14). FIRE-AND-FORGET: qualunque errore viene loggato e
 * ingoiato — il metering non deve MAI far fallire il nodo.
 */
export async function reportPortalTokenUsage(
  workspaceId: string,
  usage: { tokensIn: number; tokensOut: number; source: string },
): Promise<void> {
  if (usage.tokensIn <= 0 && usage.tokensOut <= 0) return;
  try {
    const url = `${PORTAL_URL.replace(/\/$/, '')}/api/v1/internal/quota-usage/${workspaceId}/increment`;
    const res = await internalAwareFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': getOutboundPortalToken() },
      body: JSON.stringify({ tokensIn: Math.trunc(usage.tokensIn), tokensOut: Math.trunc(usage.tokensOut), calls: 1, source: usage.source }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, workspaceId, source: usage.source }, '[PORTAL_QUOTA] increment non-200');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId, source: usage.source },
      '[PORTAL_QUOTA] increment failed',
    );
  }
}

/** Test helper: svuota la cache in-memory. */
export function __clearPortalQuotaCache(): void {
  cache.clear();
}
