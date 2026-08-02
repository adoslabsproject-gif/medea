import { createMiddleware } from 'hono/factory';
import type { AuthContext } from './auth.js';

const ROLE_RANK: Record<NonNullable<AuthContext>['role'], number> = {
  viewer: 0,
  operator: 1,
  editor: 2,
  owner: 3,
  superadmin: 4,
};

export type Role = NonNullable<AuthContext>['role'];

/**
 * Require the authenticated user to have AT LEAST the given role.
 * Roles are ordered: viewer < operator < editor < owner.
 * Public paths (those allowed by authMiddleware) won't have auth set;
 * if required=true on the outer middleware, requireRole will return 401.
 *
 * FAIL-CLOSED (fix 2026-06-12, gap #3 masterplan): un ruolo FUORI dall'union
 * (es. 'admin'/'super_admin' dal vocabolario portal pre-normalizzazione, o
 * garbage in un token alterato) ha rank -1 → SEMPRE 403. Pre-fix
 * `ROLE_RANK[ruolo_ignoto]` era undefined e `undefined < n` è false → il
 * gate PASSAVA qualunque ruolo sconosciuto (verifySessionToken non valida
 * il payload con zod, quindi il valore raw arrivava fin qui).
 */
export function requireRole(minRole: Role) {
  return createMiddleware(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const rank = (ROLE_RANK as Record<string, number | undefined>)[auth.role] ?? -1;
    if (rank < ROLE_RANK[minRole]) {
      return c.json(
        { error: `Forbidden: requires role ${minRole} or higher (you are ${auth.role})` },
        403,
      );
    }
    await next();
    return;
  });
}

/**
 * Require the authenticated user to belong to a specific tenant.
 * Tenant-id is taken from the JWT, not from headers — headers can lie.
 */
export function requireTenant(tenantId: string) {
  return createMiddleware(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (auth.tenantId !== tenantId) {
      return c.json({ error: 'Forbidden: cross-tenant access blocked' }, 403);
    }
    await next();
    return;
  });
}

/**
 * superadmin guard — only the SaaS provider (you) can access cross-tenant
 * routes. Tenants' owner role grants admin within OWN tenant; superadmin
 * grants admin across ALL tenants.
 */
export function requireSuperAdmin() {
  return createMiddleware(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (auth.role !== 'superadmin') {
      return c.json({ error: 'Forbidden: superadmin only' }, 403);
    }
    await next();
    return;
  });
}
