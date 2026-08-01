/**
 * User management — CRUD for tenant users. Owner-only.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hashPassword } from '@flowforge/auth-local';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { requireRole } from '@/middleware/auth.js';
import { getTenantId } from '@/lib/tenant.js';
import { revokeAllUserSessions } from '@/services/security/session-revocation.js';

const CreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(1).max(200),
  role: z.enum(['owner', 'editor', 'operator', 'viewer']),
});

const UpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  role: z.enum(['owner', 'editor', 'operator', 'viewer']).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(12).optional(),
});

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'editor' | 'operator' | 'viewer';
  enabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  oauth_provider: string | null;
}

export function createUsersRoutes(): Hono {
  const app = new Hono();

  // Path-specific — vedi commento in admin.ts. NON usare '*' wildcard quando
  // il sub-app e\` montato a /api/v1 (sibling routes /api/v1/dashboard/*
  // verrebbero bloccate dal middleware).
  app.use('/users/*', requireRole('owner'));
  app.use('/users', requireRole('owner'));

  app.get('/users', (c) => {
    // Always derive tenantId from the JWT-verified auth context — header
    // values are caller-controlled. Falling back to 'default' was wrong:
    // an owner authenticated on tenant X would silently CRUD against
    // tenant 'default' because the browser never sets x-tenant-id.
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    // is_system = 1 marks auto-provisioned CI accounts (e2e@flowforge.local
    // and similar). Hide them from the UI — they're not real users an
    // owner manages. Without this filter, owners see them reappear after
    // every deploy because the runtime re-provisions them on boot.
    const rows = sqlite
      .prepare("SELECT id, tenant_id, email, display_name, role, enabled, created_at, updated_at, last_login_at, oauth_provider FROM users WHERE tenant_id = ? AND COALESCE(is_system, 0) = 0 ORDER BY created_at DESC")
      .all(tenantId) as UserRow[];
    return c.json({
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastLoginAt: r.last_login_at,
        oauthProvider: r.oauth_provider,
      })),
    });
  });

  app.post('/users', zValidator('json', CreateSchema), async (c) => {
    // Always derive tenantId from the JWT-verified auth context — header
    // values are caller-controlled. Falling back to 'default' was wrong:
    // an owner authenticated on tenant X would silently CRUD against
    // tenant 'default' because the browser never sets x-tenant-id.
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const { sqlite } = getDatabase();
    const existing = sqlite
      .prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ?')
      .get(tenantId, body.email) as { id?: string } | undefined;
    if (existing?.id) return c.json({ error: 'Email già registrata' }, 409);
    const hash = await hashPassword(body.password);
    const id = nanoid();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(id, tenantId, body.email, body.displayName, hash, body.role, now, now);
    return c.json({ id, email: body.email, displayName: body.displayName, role: body.role }, 201);
  });

  app.patch('/users/:id', zValidator('json', UpdateSchema), async (c) => {
    // Always derive tenantId from the JWT-verified auth context — header
    // values are caller-controlled. Falling back to 'default' was wrong:
    // an owner authenticated on tenant X would silently CRUD against
    // tenant 'default' because the browser never sets x-tenant-id.
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const { sqlite } = getDatabase();
    const existing = sqlite
      .prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as UserRow | undefined;
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.displayName !== undefined) { updates.push('display_name = ?'); params.push(body.displayName); }
    if (body.role !== undefined) { updates.push('role = ?'); params.push(body.role); }
    if (body.enabled !== undefined) { updates.push('enabled = ?'); params.push(body.enabled ? 1 : 0); }
    if (body.password !== undefined) {
      const hash = await hashPassword(body.password);
      updates.push('password_hash = ?');
      params.push(hash);
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(tenantId);
    params.push(id);
    sqlite
      .prepare(`UPDATE users SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`)
      .run(...params);
    return c.json({ id, updated: true });
  });

  app.delete('/users/:id', (c) => {
    // Always derive tenantId from the JWT-verified auth context — header
    // values are caller-controlled. Falling back to 'default' was wrong:
    // an owner authenticated on tenant X would silently CRUD against
    // tenant 'default' because the browser never sets x-tenant-id.
    const auth = c.get('auth');
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (auth?.userId === id) return c.json({ error: 'Non puoi eliminare te stesso (logout e cancellati da un altro owner)' }, 400);
    const { sqlite } = getDatabase();
    const existing = sqlite
      .prepare('SELECT is_system FROM users WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as { is_system?: number } | undefined;
    if (!existing) {
      // Either the user doesn't exist or belongs to a different tenant.
      // Don't leak which — caller still gets a clear "not found".
      return c.json({ error: 'Utente non trovato nel tuo tenant' }, 404);
    }
    if (existing.is_system === 1) {
      // System accounts (CI / smoke test users) are protected so owners
      // who try to clean their user list don't see them reappear after
      // every deploy. To remove permanently, disable FLOWFORGE_E2E_AUTO_PROVISION.
      return c.json({ error: 'Utente di sistema non eliminabile via UI. Disattiva FLOWFORGE_E2E_AUTO_PROVISION nel server env per rimuoverlo.' }, 403);
    }
    const info = sqlite
      .prepare('DELETE FROM users WHERE tenant_id = ? AND id = ?')
      .run(tenantId, id);
    return c.json({ removed: info.changes > 0 });
  });

  // POST /users/:id/revoke-sessions — l'owner butta fuori TUTTE le sessioni
  // attive di un utente all'istante (account compromesso, dipendente uscito,
  // device perso). Su token stateless usa il cutoff per-utente: ogni token con
  // iat < now viene rifiutato dal middleware; un eventuale re-login successivo
  // funziona. Owner-only (guard /users/* gia\` applicato).
  app.post('/users/:id/revoke-sessions', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const { sqlite } = getDatabase();
    const exists = sqlite.prepare('SELECT 1 AS x FROM users WHERE tenant_id = ? AND id = ?').get(tenantId, id);
    if (!exists) return c.json({ error: 'Utente non trovato nel tuo tenant' }, 404);
    revokeAllUserSessions(id);
    return c.json({ ok: true, userId: id, revoked: 'all-sessions' });
  });

  return app;
}
