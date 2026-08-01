/**
 * Superadmin routes — cross-tenant visibility for the SaaS provider.
 * All endpoints require role === 'superadmin'.
 *
 * #199 H14 split (749 → ~50 LOC):
 *   - admin/tenants.ts            → stats + tenants CRUD (10 route)
 *   - admin/users.ts              → users list + role + enabled (3 route)
 *   - admin/workers.ts            → fleet control + log streaming (7 route)
 *   - admin/breakers.ts           → circuit breakers ops (5 route)
 *   - admin/imap-diagnostics.ts   → IMAP debug per system account (1 route)
 *   - admin/workflows-health.ts   → workflow schema diagnostics (1 route)
 *
 * Auth: requireSuperAdmin path-specific (NON wildcard '*' — vedi bug
 * 2026-05-28 dove dashboard/workflows era 403 a causa di sub-app catch-all).
 */

import { Hono } from 'hono';
import { requireSuperAdmin } from '@/middleware/rbac.js';
import { registerTenantsRoutes } from './admin/tenants.js';
import { registerUsersRoutes } from './admin/users.js';
import { registerWorkersRoutes } from './admin/workers.js';
import { registerBreakersRoutes } from './admin/breakers.js';
import { registerImapDiagnosticsRoutes } from './admin/imap-diagnostics.js';
import { registerWorkflowsHealthRoutes } from './admin/workflows-health.js';

export function createAdminRoutes(): Hono {
  const app = new Hono();

  // Path-specific middleware — NON usare app.use('*', ...) perché Hono
  // applica i middleware del sub-app a TUTTE le request matchanti il prefix
  // mount (`/api/v1/*`), bloccando anche sibling sub-apps come /dashboard/*.
  // Bug 2026-05-28: dashboard/workflows era 403 a causa di questo wildcard
  // che intercettava request /api/v1/* PRIMA che Hono trovasse il match
  // route nel sub-app dashboard.
  app.use('/admin/*', requireSuperAdmin());

  registerTenantsRoutes(app);
  registerUsersRoutes(app);
  registerWorkersRoutes(app);
  registerBreakersRoutes(app);
  registerImapDiagnosticsRoutes(app);
  registerWorkflowsHealthRoutes(app);

  return app;
}
