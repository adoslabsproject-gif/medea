export {
  assertUrlSafe,
  validateUrlForFetch,
  validateIpForFetch,
  SsrfBlockedError,
  type SsrfBlockReason,
  type SsrfValidationResult,
} from './ssrf-guard.js';

export { isIP } from './is-ip.js';

export {
  parseInternalHostAllowlist,
  isHostAllowlisted,
  internalGatewayTrustedHost,
} from './internal-host-allowlist.js';

export {
  safeFetchWithRedirects,
  CROSS_HOST_STRIP_HEADERS,
  type SafeFetchOptions,
} from './safe-fetch.js';

// Lettura body anti-OOM — primitivo CONDIVISO. `safeFetchWithRedirects` torna una
// Response GREZZA (SSRF+redirect, body NON limitato): ogni consumer DEVE leggere
// con questi al posto di res.json()/text() diretti, altrimenti una risposta enorme
// (API list, endpoint compromesso, URL sbagliato) → OOM del container tenant.
export {
  DEFAULT_RESPONSE_CAP_BYTES,
  readTextCapped,
  readJsonCapped,
  readTextTruncated,
  readBytesCapped,
} from './capped-response.js';
