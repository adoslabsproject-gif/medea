/**
 * Client DISCOVERY marketplace — il runtime chiede al portal i nodi del
 * marketplace pertinenti a una richiesta, per farli SUGGERIRE da Liara.
 *
 * S2S verso il portal (MEDEA_PORTAL_URL + x-internal-token, stesso
 * meccanismo di runtime-metrics/template-cache). Fail-soft TOTALE: timeout,
 * circuit breaker, qualunque errore → [] (la chat non deve MAI rompersi per
 * colpa del discovery; un marketplace giù non blocca Liara). Liara propone, non
 * esegue: un nodo non installato non finisce mai in un workflow.
 *
 * @module services/catalog-retrieval/marketplace-discovery
 */

import { CircuitBreaker } from '@medea/engine-shared';
import { readJsonCapped } from '@/lib/capped-response.js';
import { loadConfig } from '@/config.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';
import { logger } from '@/lib/logger.js';

export interface MarketplaceSuggestion {
  defId: string;
  displayName: string;
  description: string;
  category: string;
  /** 'free' | 'one_time' | 'per_run' | 'subscription'. */
  pricingModel: string;
  priceCents: number;
  currency: string;
  installCount: number;
  ratingAvg: number | null;
}

const TIMEOUT_MS = 2_500;

const breaker = new CircuitBreaker<MarketplaceSuggestion[]>('marketplace-discovery', {
  failureThreshold: 5,
  resetTimeout: 30_000,
  successThreshold: 2,
  probeTimeout: 5_000,
});

/**
 * Cerca nel marketplace i nodi pertinenti a `query`. Ritorna [] su qualunque
 * problema (token assente, portal giù, timeout, breaker aperto). Mai throw.
 */
export async function searchMarketplace(query: string, limit = 6): Promise<MarketplaceSuggestion[]> {
  const token = getOutboundPortalToken();
  if (!token || query.trim().length < 2) return [];
  const url = `${loadConfig().MEDEA_PORTAL_URL.replace(/\/$/, '')}/api/v1/internal/marketplace/search`;
  try {
    return await breaker.execute(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({ query: query.slice(0, 500), limit }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`marketplace search HTTP ${String(res.status)}`);
      const body = await readJsonCapped<{ results?: MarketplaceSuggestion[] }>(res);
      return Array.isArray(body.results) ? body.results : [];
    });
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[marketplace-discovery] skip (fail-soft)');
    return [];
  }
}

/** Prezzo human-readable per il prompt: "gratis" o "4,99 € una tantum". */
export function formatPrice(s: MarketplaceSuggestion): string {
  if (s.pricingModel === 'free' || s.priceCents === 0) return 'gratis';
  const amount = (s.priceCents / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 });
  const suffix = s.pricingModel === 'subscription' ? '/mese'
    : s.pricingModel === 'per_run' ? '/esecuzione' : ' una tantum';
  return `${amount} ${s.currency}${suffix}`;
}

/**
 * Blocco prompt dei suggerimenti marketplace. Vuoto se nessun risultato.
 * Marcato chiaramente come "NON installati" così Liara li PROPONE (install/
 * acquisto) e NON li mette in un workflow.
 */
export function formatMarketplaceSuggestions(items: readonly MarketplaceSuggestion[]): string {
  if (items.length === 0) return '';
  const lines = items
    .map((s) => `- ${s.defId} (${s.category}): ${s.description.split(/(?<=[.!?])\s/u)[0] ?? s.description} — ${formatPrice(s)}`)
    .join('\n');
  return [
    '',
    'NODI DAL MARKETPLACE (NON installati nel workspace — puoi SOLO proporli all\'utente,',
    'NON usarli in un patch; per il free suggerisci di installarlo, per il paid di acquistarlo):',
    lines,
  ].join('\n');
}
