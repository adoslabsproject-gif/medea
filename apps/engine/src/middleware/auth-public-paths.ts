/**
 * Allowlist dei path pubblici del runtime tenant — UNICA fonte di verità,
 * estratta da server.ts per essere testabile in isolamento (un errore qui apre
 * un endpoint sensibile senza auth: va coperto da test, non solo E2E).
 *
 * Due meccanismi:
 *  - PUBLIC_PREFIXES: bypass per prefisso (startsWith). Per famiglie di path.
 *  - PUBLIC_PATH_PATTERNS: regex ANCORATE (^…$) per path con segmenti dinamici
 *    o per singoli endpoint che devono restare pubblici SENZA aprire vicini.
 *
 * I path NON elencati qui (né in `publicPaths` del middleware) richiedono SEMPRE
 * un JWT valido + (per /api/v1/*) il check originCsrf.
 */

/** Bypass per prefisso (startsWith). */
export const PUBLIC_PREFIXES: readonly string[] = [
  // Public share dashboard for clients (read-only, token-gated in body).
  '/api/v1/share/',
  '/api/v1/portal/', // Client Portal token-gated
  '/api/v1/oauth-connect/callback',
  // OAuth callback is hit by the BROWSER after Google redirects — no session
  // header present. The signed `state` token is the authenticator (HMAC + 10min
  // TTL + single-use jti).
  '/api/v1/integrations/oauth/google/callback',
  // Portal-centric Gmail OAuth import: hit by the browser after the portal
  // callback redirects with a signed JWE handoff. The JWE audience claim binds
  // the call to this workspaceId.
  '/api/v1/email-accounts/oauth/google/import',
  // Email tracking pixel + click redirect — called by recipients' mail clients
  // with zero auth context. The HMAC token in the URL IS the auth.
  '/api/track/',
];

/**
 * SECURITY #200 P0-1: SSO callback dinamici (provider variabile in URL). Solo
 * callback + SAML metadata sono pubblici. `/providers` (CRUD admin) e `/start`
 * (richiede sessione) restano gated. Regex ANCORATE per non aprire path vicini.
 */
export const PUBLIC_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/v1\/auth\/oauth\/[a-zA-Z0-9_-]+\/callback$/,
  /^\/api\/v1\/auth\/saml\/[a-zA-Z0-9_-]+\/callback$/,
  /^\/api\/v1\/auth\/saml\/[a-zA-Z0-9_-]+\/metadata$/,
  // Logout DEVE essere pubblico: cancella solo il cookie del chiamante e deve
  // funzionare anche con token scaduto/assente (altrimenti la sessione non si
  // chiude mai). CSRF coperto da originCsrf su /api/v1/*.
  /^\/api\/v1\/auth\/logout$/,
];
