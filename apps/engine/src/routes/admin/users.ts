/**
 * Admin users — cross-tenant users CRUD (superadmin only).
 *
 * Estratto da routes/admin.ts (#199 H14 split) — 3 endpoint:
 *   GET   /admin/users                       — list all users
 *   PATCH /admin/users/:userId/role          — promote/demote (incl. superadmin)
 *   PATCH /admin/users/:userId/enabled       — toggle enabled/disabled
 */

import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from '@/services/audit.service.js';
import {
  assertSuperadminSafe,
  countEnabledSuperadmins,
  SuperadminSafetyError,
} from './_shared/superadmin-safety.js';

const audit = new AuditLogService();

const PromoteRoleSchema = z.object({
  role: z.enum(['superadmin', 'owner', 'editor', 'operator', 'viewer']),
});

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: string;
  enabled: number;
  created_at: string;
  last_login_at: string | null;
}

export function registerUsersRoutes(app: Hono): void {
  app.get('/admin/users', (c) => {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT id, tenant_id, email, display_name, role, enabled, created_at, last_login_at FROM users ORDER BY tenant_id, created_at DESC',
      )
      .all() as UserRow[];
    return c.json({
      users: rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      })),
    });
  });

  /**
   * Change a user's role (incl. promote to superadmin).
   * Note: this is the ONLY way to promote to superadmin via UI — the
   * `owner` role of `/users` (per-tenant) only allows owner/editor/operator/viewer.
   */
  app.patch('/admin/users/:userId/role', zValidator('json', PromoteRoleSchema), async (c) => {
    const auth = c.get('auth');
    const userId = c.req.param('userId');
    if (!userId) return c.json({ error: 'Bad request' }, 400);
    const { role } = c.req.valid('json');
    const { sqlite } = getDatabase();

    const target = sqlite
      .prepare('SELECT id, email, role, tenant_id, enabled FROM users WHERE id = ?')
      .get(userId) as
      | { id: string; email: string; role: string; tenant_id: string; enabled: number }
      | undefined;
    if (!target) return c.json({ error: 'User not found' }, 404);

    // Anti-lockout (audit #6): niente self-demote né demote dell'ultimo
    // superadmin attivo → altrimenti console cross-tenant irraggiungibile.
    try {
      assertSuperadminSafe({
        kind: 'role',
        actorUserId: auth?.userId,
        target: { id: target.id, role: target.role, enabled: target.enabled === 1 },
        newRole: role,
        activeSuperadminCount: countEnabledSuperadmins(sqlite),
      });
    } catch (e) {
      if (e instanceof SuperadminSafetyError)
        return c.json({ error: e.message, reason: e.reason }, 403);
      throw e;
    }

    sqlite
      .prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
      .run(role, new Date().toISOString(), userId);

    // #208 P0-9: await — audit MUST be durable (no fire-and-forget).
    await audit.append({
      tenantId: target.tenant_id,
      action: 'user.role.change',
      resourceType: 'user',
      resourceId: userId,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { from: target.role, to: role, by: auth?.email ?? 'unknown' },
    });

    return c.json({ ok: true, user: { id: userId, email: target.email, role } });
  });

  /** Toggle user enabled/disabled (lockout senza cancellazione). */
  app.patch(
    '/admin/users/:userId/enabled',
    zValidator('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      const auth = c.get('auth');
      const userId = c.req.param('userId');
      if (!userId) return c.json({ error: 'Bad request' }, 400);
      const { enabled } = c.req.valid('json');
      const { sqlite } = getDatabase();

      const target = sqlite
        .prepare('SELECT id, role, enabled, tenant_id FROM users WHERE id = ?')
        .get(userId) as
        | { id: string; role: string; enabled: number; tenant_id: string }
        | undefined;
      if (!target) return c.json({ error: 'User not found' }, 404);

      // Anti-lockout (audit #6): niente self-disable né disable dell'ultimo superadmin attivo.
      try {
        assertSuperadminSafe({
          kind: 'enabled',
          actorUserId: auth?.userId,
          target: { id: target.id, role: target.role, enabled: target.enabled === 1 },
          newEnabled: enabled,
          activeSuperadminCount: countEnabledSuperadmins(sqlite),
        });
      } catch (e) {
        if (e instanceof SuperadminSafetyError)
          return c.json({ error: e.message, reason: e.reason }, 403);
        throw e;
      }

      sqlite
        .prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, new Date().toISOString(), userId);

      // #208 P0-9 (audit #2): il lockout/sblocco È una write di sicurezza → audit
      // DUREVOLE (await), come il cambio ruolo. Prima non scriveva NULLA.
      await audit.append({
        tenantId: target.tenant_id,
        action: 'user.enabled.change',
        resourceType: 'user',
        resourceId: userId,
        ...(auth?.userId ? { actorId: auth.userId } : {}),
        metadata: { enabled, by: auth?.email ?? 'unknown' },
      });

      return c.json({ ok: true, enabled });
    },
  );
}
