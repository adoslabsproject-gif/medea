/**
 * Tenant resolution — single source of truth for "which tenant is this request in?".
 *
 * Background
 * ----------
 * FlowForge was born single-tenant ("default"). Multi-tenancy was layered in
 * later: auth was migrated to JWT-bound `tenantId`, but the per-route reads
 * stayed on the legacy header pattern `c.req.header('x-tenant-id') ?? 'default'`.
 * The browser client never sends that header, so a non-default tenant user
 * would actually operate on `default` — a tenant-isolation bug.
 *
 * This helper centralizes the lookup so every route reads the SAME source.
 *
 * Resolution policy
 * -----------------
 *   1. If `auth.role === 'superadmin'` AND header `x-tenant-id` is present:
 *      use the header. This is the platform-operator override (admin dashboard,
 *      cross-tenant debug, customer support). Logged at info level for audit.
 *
 *   2. Otherwise: use `auth.tenantId` from the verified JWT. The header is
 *      ignored. This is the normal case: tenant comes from the signed token,
 *      not from a client-controllable header. Spoof-proof by construction.
 *
 *   3. If there's no `auth` (public route reached this helper by mistake):
 *      throw. Public routes should never need a tenant.
 *
 * Why a helper and not middleware
 * --------------------------------
 * Middleware would have to mutate the request context (set `tenantId` on it),
 * which is an implicit side-effect that's invisible at the call site. A
 * function call `getTenantId(c)` is explicit, greppable, and forces every
 * route author to confront the question "what's my tenant here?" at the
 * exact line that needs it.
 */

import type { Context } from 'hono';
import { logger } from './logger.js';
import { loadConfig } from '@/config.js';
import type { AuthContext } from '@/middleware/auth.js';

/**
 * Resolve the effective tenant for the current request.
 *
 * @param c - Hono context (auth must have been set by authMiddleware upstream)
 * @returns the tenant slug (string)
 * @throws Error if called from a route without authentication
 *
 * @example
 * ```ts
 * app.get('/workflows', (c) => {
 *   const tenantId = getTenantId(c);            // ← spoof-proof
 *   return c.json({ workflows: service.list(tenantId) });
 * });
 * ```
 */
export function getTenantId(c: Context): string {
  const auth = c.get('auth') as AuthContext | null | undefined;

  if (!auth) {
    // This indicates a coding mistake: a public route is calling getTenantId.
    // Fail loud — silent fallback to 'default' would re-introduce the same
    // class of isolation bug we're fixing here.
    throw new Error(
      `getTenantId() called on unauthenticated request (path=${c.req.path}). ` +
      `Either the route shouldn't need a tenant (public), or authMiddleware ` +
      `is missing required=true above this handler.`,
    );
  }

  const headerOverride = c.req.header('x-tenant-id');

  if (auth.role === 'superadmin' && headerOverride && headerOverride !== auth.tenantId) {
    // Superadmin is impersonating / inspecting another tenant. Log it.
    // This is the SAME mechanism the cross-tenant Admin Dashboard uses to
    // page through tenants without forcing the operator to log in N times.
    logger.info(
      {
        actor: auth.email,
        actorTenant: auth.tenantId,
        targetTenant: headerOverride,
        path: c.req.path,
        method: c.req.method,
      },
      'Superadmin cross-tenant access',
    );
    return headerOverride;
  }

  return auth.tenantId;
}

/**
 * Best-effort tenant lookup that returns null (instead of throwing) when no
 * auth context is present. For routes that legitimately handle both
 * authenticated and unauthenticated cases (e.g. webhooks signed with a
 * different key, public form submissions). Such routes must do their own
 * tenant resolution (e.g. from the form's owner_tenant_id in DB).
 */
export function getTenantIdOrNull(c: Context): string | null {
  const auth = c.get('auth') as AuthContext | null | undefined;
  if (!auth) return null;
  return getTenantId(c);
}

/**
 * Resolve the tenant for PUBLIC / unauthenticated routes that run inside a
 * per-tenant container: SAML SSO callbacks (the IdP POST carries no JWT and no
 * custom header), the client-error sink, public form webhooks, etc.
 *
 * Source of truth = `MEDEA_TENANT_ID`, the workspace UUID the portal injects
 * into the container at provision time (see `config.ts`). It is the container's
 * own identity — NOT a client-controllable value.
 *
 * Why NOT the `x-tenant-id` header (the bug this fixes)
 * -----------------------------------------------------
 * These routes used `c.req.header('x-tenant-id') ?? 'default'`. Two problems:
 *
 *   1. CORRECTNESS — the IdP's SAML POST never sends `x-tenant-id`, so it
 *      resolved to `'default'`, while the provider row was stored under the
 *      real tenant UUID (the admin created it via `getTenantId()`). The lookup
 *      missed → 404 → SAML SSO was effectively BROKEN in container mode.
 *
 *   2. SECURITY — trusting a client header to pick the tenant is the exact
 *      spoofing class `getTenantId()` was built to eliminate. The minted
 *      session token would otherwise inherit a caller-chosen tenant.
 *
 * Reading the env makes both moot: the container IS one tenant; spoofing the
 * header can't move you elsewhere because each tenant has its own container+DB.
 *
 * Falls back to `'default'` only when the env is unset (non-container dev mode),
 * preserving local-dev ergonomics.
 *
 * @returns the container's tenant slug (UUID in prod, `'default'` in dev)
 */
export function getContainerTenantId(): string {
  return loadConfig().MEDEA_TENANT_ID ?? 'default';
}
