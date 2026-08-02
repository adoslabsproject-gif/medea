/**
 * Tenant-status middleware — enforce lifecycle del tenant.
 *
 * Da applicare su tutte le route "data-modifying" o "expensive" che NON
 * devono funzionare se il tenant è suspended / archived / soft-deleted:
 *   • workflow run / triggers
 *   • file upload
 *   • LLM call (consumi quota)
 *   • DB studio write
 *
 * NON applicare a:
 *   • Route auth (`/auth/login`) — il login deve poter restituire 403
 *     suspended con messaggio chiaro all'utente
 *   • Route admin/superadmin — il superadmin deve poter agire SUI tenant
 *     suspended (es. per riattivarli)
 *   • Route read-only "billing/account" — l'owner suspended deve poter
 *     vedere lo stato + magari rinnovare/pagare
 *
 * Pattern: chiamato come `tenantStatusMiddleware()` dentro `app.use(...)`
 * dopo `authMiddleware()`. Throw 403 con codice macchina-friendly per UI.
 */

import type { MiddlewareHandler } from 'hono';
import { getTenantIdOrNull } from '@/lib/tenant.js';
import {
  tenantService,
  TenantNotFoundError,
  TenantNotActiveError,
} from '@/services/tenant.service.js';

/**
 * READ_ONLY_METHODS — letture sempre permesse anche su tenant suspended.
 * Il tenant suspended deve poter vedere il proprio stato (UI) per capire
 * cosa è successo. Solo mutazioni e endpoint expensive vengono bloccati.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * SKIP_PREFIXES — paths esenti dal check tenant-active (always pass):
 *   • Auth flow (login, logout, password reset) — l'utente deve poter
 *     vedere/risolvere lo stato anche se tenant suspended
 *   • SSO bridge dal portal — è il portal che decide se permettere SSO
 *   • Health/metrics — observability
 *   • Webhook server-to-server (con loro proprio auth check su signature)
 *   • Internal route (Sentinel etc)
 *   • Account billing/profile — la UI ha bisogno di rendere il banner
 *     "tenant suspended — rinnova qui"
 */
const SKIP_PREFIXES: readonly string[] = [
  '/api/v1/auth',
  '/sso',
  '/api/v1/health',
  '/api/v1/metrics',
  '/api/v1/webhooks',
  '/api/v1/internal',
  '/webhooks',
];

function isSkipped(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

export function tenantStatusMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // 1. READ-only methods sempre permessi (no mutation → no harm)
    if (READ_ONLY_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    // 2. Skip-paths: auth + SSO + health + webhooks + internal
    if (isSkipped(c.req.path)) {
      await next();
      return;
    }
    const tenantId = getTenantIdOrNull(c);
    if (!tenantId) {
      // Route non autenticata o tenant non risolto — il middleware auth
      // si occupa di rifiutare; qui passiamo trasparenti.
      await next();
      return;
    }
    try {
      tenantService.assertActive(tenantId);
    } catch (e) {
      if (e instanceof TenantNotFoundError) {
        return c.json(
          {
            error: 'tenant_not_found',
            message: `Tenant "${tenantId}" non esiste o è stato eliminato.`,
          },
          404,
        );
      }
      if (e instanceof TenantNotActiveError) {
        return c.json(
          {
            error: 'tenant_not_active',
            message: e.message,
          },
          403,
        );
      }
      throw e;
    }
    await next();
  };
}
