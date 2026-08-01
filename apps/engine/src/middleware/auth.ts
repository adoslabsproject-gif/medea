import { createMiddleware } from 'hono/factory';
import { verifySessionToken, type SessionTokenPayload } from '@flowforge/auth-local';
import { logger } from '@/lib/logger.js';
import { isPayloadRevoked } from '@/services/security/session-revocation.js';
import { verifyInternalToken } from '@/lib/internal-token.js';

export interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: SessionTokenPayload['role'];
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext | null;
  }
}

export interface AuthMiddlewareOptions {
  publicPrefixes?: string[];
  publicKeyPem: string;
  required?: boolean;
  publicPaths?: string[];
  /**
   * Regex patterns per path con segmenti dinamici (es. callback OAuth/SAML
   * con `:provider` nel mezzo). Match → bypass auth.
   * Esempio: /^\/api\/v1\/auth\/oauth\/[^/]+\/callback$/
   */
  publicPathPatterns?: RegExp[];
}

export function authMiddleware(options: AuthMiddlewareOptions) {
  const required = options.required ?? true;
  const publicPaths = new Set(options.publicPaths ?? [
    '/health',
    '/ready',
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/signup',
    '/api/v1/auth/status',
    '/api/v1/client-errors',
  ]);
  // SECURITY #200 P0-1: NO wildcard bypass su /api/v1/auth/oauth/* né
  // /api/v1/auth/saml/* — gli endpoint amministrativi (provider CRUD)
  // sotto quei prefix devono richiedere JWT. Solo callback + metadata SAML
  // possono essere pubblici (chiamati da provider esterno senza JWT).
  // Bug pre-fix: GET/POST/DELETE /oauth/providers ⇒ chiunque poteva
  // listare/creare/eliminare provider OAuth → account takeover via SSO injection.
  const publicPrefixes = [...(options.publicPrefixes ?? [])];
  // Pattern-based bypass per path con segmenti dinamici (SSO callback).
  // Il caller (server.ts) deve enumerare i pattern esatti — niente wildcard
  // larghi tipo `/api/v1/auth/oauth/*` (vedi bug fix sopra).
  const publicPathPatterns = options.publicPathPatterns ?? [];

  // Service-to-service internal token: executors that talk back to their
  // own runtime over HTTP (db_query, db_insert, rag_search, subworkflow,
  // invoke, etc.) inject this header. It's generated at boot, lives only
  // in process env, and is NEVER served by the API. Match → auth bypass
  // with a synthetic "internal" auth context.
  // Tenant ID source-of-truth: env var FLOWFORGE_TENANT_ID. Single-tenant
  // container (CLAUDE.md REGOLA 1) → NO trust su header.
  const config = { FLOWFORGE_TENANT_ID: process.env.FLOWFORGE_TENANT_ID ?? '' };

  return createMiddleware(async (c, next) => {
    if (
      publicPaths.has(c.req.path) ||
      publicPrefixes.some((p) => c.req.path.startsWith(p)) ||
      publicPathPatterns.some((re) => re.test(c.req.path))
    ) {
      c.set('auth', null);
      await next();
      return;
    }

    // Internal service-to-service token (executors → runtime API).
    // Role is 'owner' (NOT superadmin) — the token is for legitimate
    // executor→runtime callbacks (db_query, rag_search, subworkflow,
    // invoke) within the same host, NOT for bypassing RBAC.
    //
    // FIX HIGH-2 security audit 2026-05-31: tenantId è SEMPRE preso da
    // config.FLOWFORGE_TENANT_ID (source of truth per single-tenant
    // container, vedi CLAUDE.md REGOLA 1). L'header x-tenant-id era
    // trust-on-input → se internal-token leakava, attaccante poteva
    // forge tenantId via header e accedere a dati cross-tenant.
    const xInternal = c.req.header('x-internal-token') ?? '';
    if (verifyInternalToken(xInternal)) {
      const tenantId = config.FLOWFORGE_TENANT_ID || 'default';
      c.set('auth', {
        userId: 'internal',
        tenantId,
        email: 'internal@flowforge',
        role: 'owner',
      });
      await next();
      return;
    }

    const header = c.req.header('authorization');
    let tokenFromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null;
    // Sanitize: editor SPA può mandare `Bearer null`/`Bearer undefined`
    // durante il bootstrap iniziale (localStorage vuoto post-SSO). Ignora
    // quei valori per permettere il fallback al cookie ff_session che il
    // browser invia same-origin.
    // #203 P0-4: l'editor SPA dopo /auth/bootstrap manda Bearer 'cookie-session'
    // come sentinel (token NON più esposto a JS dal bootstrap). Skip JWT
    // verify in quel caso → fallback diretto al cookie HttpOnly.
    if (
      tokenFromHeader === 'null' ||
      tokenFromHeader === 'undefined' ||
      tokenFromHeader === '' ||
      tokenFromHeader === 'cookie-session'
    ) {
      tokenFromHeader = null;
    }
    // FIX 2026-05-29: dual-name lookup post __Host- migration. Pre-fix
    // cercava SOLO `ff_session=` legacy → in prod il cookie e\` `__Host-ff_session=`
    // → tokenFromCookie sempre null → 401 + redirect loop SSO bootstrap.
    // Order: __Host- PRIMARY (prod), fallback legacy `ff_session=`.
    const tokenFromCookie = (() => {
      const segs = c.req.header('cookie')?.split(';').map((s) => s.trim()) ?? [];
      const primary = segs.find((s) => s.startsWith('__Host-ff_session='));
      if (primary) return primary.slice('__Host-ff_session='.length);
      const legacy = segs.find((s) => s.startsWith('ff_session='));
      if (legacy) return legacy.slice('ff_session='.length);
      return null;
    })();
    // ZERO token in URL. Anche per gli endpoint SSE — EventSource passa
    // automaticamente i cookie same-origin (`ff_session` HttpOnly settato
    // dal POST /sso bridge). Prima accettavamo `?token=` per stream — ora
    // RIMOSSO: token in URL appare in nginx access log, browser history,
    // Referer headers, server-error stacktraces. Inaccettabile.

    if (!tokenFromHeader && !tokenFromCookie) {
      c.set('auth', null);
      if (required) return c.json({ error: 'Unauthorized: missing session token' }, 401);
      await next();
      return;
    }

    // Prova prima il Bearer header (se presente). Se invalido — tipicamente
    // un token stale da localStorage che l'SPA ricorda di una sessione
    // precedente sullo stesso subdomain — fall-back AUTOMATICO al cookie
    // ff_session. Senza questo fallback, la prima /auth/me post-SSO ritorna
    // 401 perché l'editor invia il Bearer stale prima che /auth/bootstrap
    // ripristini la sessione, e l'utente vede un 401 lampo in console.
    let payload = null;
    if (tokenFromHeader) {
      payload = await verifySessionToken(tokenFromHeader, options.publicKeyPem);
    }
    if (!payload && tokenFromCookie && tokenFromCookie !== tokenFromHeader) {
      payload = await verifySessionToken(tokenFromCookie, options.publicKeyPem);
    }
    if (!payload) {
      logger.warn({ path: c.req.path }, 'Invalid session token');
      if (required) return c.json({ error: 'Unauthorized: invalid or expired token' }, 401);
      c.set('auth', null);
      await next();
      return;
    }

    // Blocklist di revoca (hardening 2026-06-07): un token firmato resta valido
    // fino a exp anche dopo il logout. Qui lo rifiutiamo SUBITO se è stato
    // revocato — sia il singolo token (logout) sia tutte le sessioni dell'utente
    // (revoca admin / cutoff) — anche se il token è stato copiato/rubato.
    if (isPayloadRevoked(payload)) {
      logger.warn({ path: c.req.path, sub: payload.sub }, 'Revoked session token rejected');
      if (required) return c.json({ error: 'Unauthorized: session revoked' }, 401);
      c.set('auth', null);
      await next();
      return;
    }

    // FIX HIGH (security audit 2026-06-09): tenant-scope assertion sul path
    // sessione normale — defense-in-depth identica a quella già presente sul
    // path internal-token (riga ~100). Un container è single-tenant: il token
    // DEVE essere stato emesso per QUESTO workspace. Le chiavi di firma sono
    // già per-tenant (cross-tenant verify fallirebbe a monte), ma se mai un
    // secret venisse condiviso/mis-configurato per errore, questa è la seconda
    // muraglia: un token mintato per il workspace A non autentica sul runtime
    // del workspace B. Vale anche per superadmin: il suo accesso legittimo a
    // un workspace passa SEMPRE da un SSO fresh con tenantId=quel workspace.
    //
    // Enforce SOLO se FLOWFORGE_TENANT_ID è configurato: in dev / disaster
    // recovery (single-tenant non impostato → '') non blocchiamo, coerente con
    // il fallback 'default' del path internal-token.
    if (
      config.FLOWFORGE_TENANT_ID !== '' &&
      payload.tenantId !== config.FLOWFORGE_TENANT_ID
    ) {
      logger.warn(
        { path: c.req.path, sub: payload.sub, tokenTenant: payload.tenantId, containerTenant: config.FLOWFORGE_TENANT_ID },
        '[SECURITY] cross-tenant session token rejected (tenantId mismatch)',
      );
      if (required) return c.json({ error: 'Unauthorized: tenant scope mismatch' }, 401);
      c.set('auth', null);
      await next();
      return;
    }

    c.set('auth', {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: payload.email,
      role: payload.role,
    });
    await next();
    return;
  });
}

export function requireRole(...allowedRoles: SessionTokenPayload['role'][]) {
  return createMiddleware(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    // superadmin is the SaaS-provider role: bypasses all per-tenant role
    // gates by design (it's how YOU can support/debug ANY tenant from the
    // admin UI without having to be added to that tenant's user list).
    if (auth.role === 'superadmin') {
      await next();
      return;
    }
    if (!allowedRoles.includes(auth.role)) {
      return c.json({ error: `Forbidden: role ${auth.role} not in ${allowedRoles.join(',')}` }, 403);
    }
    await next();
    return;
  });
}
