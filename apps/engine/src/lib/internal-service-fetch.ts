/**
 * internal-service-fetch — confine di fiducia CENTRALIZZATO per le chiamate
 * verso i NOSTRI servizi interni (Liara LLM, code-runner, portal, whisper,
 * vision, runtime loopback). Questi vivono su `host.docker.internal:PORT` o
 * loopback (IP privati) → il SSRF guard di `safeOutboundFetch` li bloccherebbe.
 *
 * PERCHÉ un'astrazione e non `allowPrivateHost: true` sparso sui callsite:
 *   1. Singola fonte di verità: i servizi interni sono UN registro, non N flag
 *      sparsi che è facile dimenticare (→ rottura) o mettere per sbaglio su una
 *      chiamata user-controlled (→ buco SSRF).
 *   2. Trust derivata dall'URL, non asserita dal callsite: `internalAwareFetch`
 *      concede il bypass SSRF SOLO se l'origin dell'URL è uno dei servizi
 *      REGISTRATI. Un endpoint user-overridable (es. `video_summarizer`
 *      `cfg.whisperEndpoint`) che punta a un IP privato ARBITRARIO (10.x,
 *      169.254, loopback non-nostro) NON è registrato → resta protetto.
 *   3. Defense-in-depth: anche un futuro typo/bug in un callsite interno non può
 *      raggiungere un host privato non-nostro.
 *
 * Comportamento `internalAwareFetch(url, opts)`:
 *   - url è un servizio interno registrato → `safeOutboundFetch` con
 *     `allowPrivateHost: true` (raggiunge l'IP privato del servizio).
 *   - altrimenti → `safeOutboundFetch` normale: host pubblici OK, IP privati
 *     ARBITRARI BLOCCATI dal SSRF guard. Così un endpoint user-overridable
 *     legittimo esterno funziona, ma un tentativo SSRF resta bloccato.
 *
 * Node-only. Il registro è costruito lazy dalla config server (env + default)
 * al primo uso e memoizzato.
 */

import { safeOutboundFetch, type SafeFetchOptions } from './safe-outbound-fetch.js';

/**
 * URL dei servizi interni — STESSI default usati dagli executor (single source
 * of truth; un test verifica che non driftino). Override via env quando esiste.
 */
export function internalServiceUrls(): Record<string, string> {
  return {
    portal: process.env.PORTAL_INTERNAL_URL ?? 'http://host.docker.internal:3006',
    liara: process.env.LIARA_URL ?? 'http://host.docker.internal:3003',
    codeRunner: process.env.CODE_RUNNER_URL ?? 'http://host.docker.internal:5003',
    whisper: process.env.WHISPER_URL ?? 'http://host.docker.internal:5005',
    vision: process.env.VISION_URL ?? 'http://host.docker.internal:5004',
    runtime: process.env.MEDEA_RUNTIME_URL ?? 'http://127.0.0.1:3100',
  };
}

let originsCache: Set<string> | undefined;

/** Set degli `origin` (scheme://host:port) dei servizi interni. Memoizzato. */
function registeredOrigins(): Set<string> {
  if (originsCache) return originsCache;
  const set = new Set<string>();
  for (const raw of Object.values(internalServiceUrls())) {
    try {
      set.add(new URL(raw).origin);
    } catch {
      /* URL malformata in env → ignora */
    }
  }
  originsCache = set;
  return set;
}

/** Chiave di un servizio interno noto (per lo scope per-callsite). */
export type InternalServiceKey = keyof ReturnType<typeof internalServiceUrls>;

/** True se `url` punta a uno dei NOSTRI servizi interni registrati. */
export function isInternalServiceUrl(url: string): boolean {
  try {
    return registeredOrigins().has(new URL(url).origin);
  } catch {
    return false;
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

/**
 * Fetch "internal-aware": bypassa il SSRF guard SOLO per i servizi interni
 * REGISTRATI; per tutto il resto usa `safeOutboundFetch` protetto (esterni OK,
 * IP privati arbitrari bloccati).
 *
 * `scope` (allowlist per-callsite, raccomandato per endpoint user-overridable):
 *   - con `scope.allow`: il bypass è concesso SOLO se l'origin dell'URL è
 *     ESATTAMENTE quello del servizio dichiarato. Così un callsite che deve
 *     chiamare "whisper" NON ottiene il bypass se l'utente devia l'endpoint
 *     verso un ALTRO nostro servizio (es. Liara) — confine minimo per-callsite.
 *   - senza `scope`: back-compat → bypass per qualsiasi servizio registrato
 *     (ok per callsite a URL FISSO server-side, non user-overridable).
 */
export function internalAwareFetch(
  url: string,
  opts: SafeFetchOptions = {},
  scope?: { allow: InternalServiceKey },
): ReturnType<typeof safeOutboundFetch> {
  const trusted = scope
    ? originOf(url) !== '' && originOf(url) === originOf(internalServiceUrls()[scope.allow] ?? '')
    : isInternalServiceUrl(url);
  return safeOutboundFetch(url, trusted ? { ...opts, allowPrivateHost: true } : opts);
}

/** Reset memoizzazione (per i test che variano le env). */
export function __resetInternalServiceCacheForTest(): void {
  originsCache = undefined;
}
