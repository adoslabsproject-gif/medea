/**
 * Admin tenants — stats + CRUD multi-tenant (Phase 5 enterprise).
 *
 * Estratto da routes/admin.ts (#199 H14 split) — 10 endpoint:
 *   GET    /admin/stats                                  — instance stats
 *   GET    /admin/tenants                                — list (?status,?plan,?include=stats)
 *   GET    /admin/tenants/:tenantId                      — single tenant (no stats)
 *   GET    /admin/tenants/:tenantId/dashboard            — dashboard per-tenant
 *   POST   /admin/tenants                                — provision tenant + owner atomic
 *   PATCH  /admin/tenants/:tenantId                      — update metadata
 *   POST   /admin/tenants/:tenantId/suspend              — status=suspended
 *   POST   /admin/tenants/:tenantId/activate             — riattiva sospeso
 *   POST   /admin/tenants/:tenantId/archive              — archive (read-only)
 *   DELETE /admin/tenants/:tenantId                      — soft delete (GDPR)
 */

import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { hashPassword } from '@medea/engine-auth-local';
import { AdminStatsService } from '@/services/admin-stats.service.js';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from '@/services/audit.service.js';
import { tenantService, TenantNotFoundError, TenantSlugConflictError } from '@/services/tenant.service.js';
import { parseIntParam } from './_shared/query-int.js';
import { logger } from '@/lib/logger.js';

const audit = new AuditLogService();

const CreateTenantSchema = z.object({
  tenantSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u, 'Slug: 3-64 char, a-z 0-9 -').toLowerCase(),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1).max(100),
  ownerPassword: z.string().min(12).max(200),
  displayName: z.string().min(1).max(200).optional(),
  legalName: z.string().max(200).optional(),
  vatNumber: z.string().max(32).optional(),
  taxCode: z.string().max(32).optional(),
  billingEmail: z.string().email().optional(),
  billingAddress: z.string().max(500).optional(),
  country: z.string().length(2).optional(),
  locale: z.string().min(2).max(8).optional(),
  timezone: z.string().max(64).optional(),
  status: z.enum(['trial', 'active', 'suspended', 'archived']).optional(),
  plan: z.enum(['trial', 'starter', 'pro', 'enterprise']).optional(),
  trialEndsAt: z.string().datetime().optional(),
  maxWorkflows: z.number().int().min(0).optional(),
  maxRunsPerMonth: z.number().int().min(0).optional(),
  maxStorageMb: z.number().int().min(0).optional(),
});

const UpdateTenantSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  legalName: z.string().max(200).nullable().optional(),
  vatNumber: z.string().max(32).nullable().optional(),
  taxCode: z.string().max(32).nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  billingAddress: z.string().max(500).nullable().optional(),
  country: z.string().length(2).optional(),
  locale: z.string().min(2).max(8).optional(),
  timezone: z.string().max(64).optional(),
  plan: z.enum(['trial', 'starter', 'pro', 'enterprise']).optional(),
  subscriptionRef: z.string().max(200).nullable().optional(),
  maxWorkflows: z.number().int().min(0).optional(),
  maxRunsPerMonth: z.number().int().min(0).optional(),
  maxStorageMb: z.number().int().min(0).optional(),
  trialEndsAt: z.string().datetime().nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});

// reason OBBLIGATORIO su ogni azione di stato distruttiva/reversibile
// (suspend/archive/delete) — accountability GDPR (audit 2026-07-02 #5).
const ReasonSchema = z.object({
  reason: z.string().min(3).max(500),
});

export function registerTenantsRoutes(app: Hono): void {
  const stats = new AdminStatsService();

  app.get('/admin/stats', (c) => {
    return c.json({ instance: stats.instance() });
  });

  /**
   * Lista tutti i tenant (Phase 5 enterprise). Query params:
   *   ?status=active|suspended|archived|trial|all (default: non-deleted)
   *   ?plan=trial|starter|pro|enterprise
   *   ?include=stats per merge userCount/workflowCount/runs24h/errors24h
   *   ?limit=50&offset=0 paginated
   */
  app.get('/admin/tenants', (c) => {
    const statusParam = c.req.query('status');
    const planParam = c.req.query('plan');
    const includeStats = (c.req.query('include') ?? '').includes('stats');
    // Clamp difensivo (audit #10): NaN (`?limit=abc`) o overflow (`?limit=9e9`)
    // non devono raggiungere LIMIT/OFFSET del driver.
    const limit = parseIntParam(c.req.query('limit'), { def: 50, min: 1, max: 200 });
    const offset = parseIntParam(c.req.query('offset'), { def: 0, min: 0, max: 5_000_000 });
    const opts: Parameters<typeof tenantService.list>[0] = { limit, offset };
    if (statusParam === 'trial' || statusParam === 'active' || statusParam === 'suspended' || statusParam === 'archived' || statusParam === 'all') {
      opts.status = statusParam;
    }
    if (planParam === 'trial' || planParam === 'starter' || planParam === 'pro' || planParam === 'enterprise') {
      opts.plan = planParam;
    }
    const { tenants, total } = tenantService.list(opts);
    if (!includeStats) return c.json({ tenants, total, limit, offset });
    const statsMap = new Map(stats.tenants().map((s) => [s.tenantId, s]));
    return c.json({
      tenants: tenants.map((t) => ({ ...t, stats: statsMap.get(t.id) ?? null })),
      total, limit, offset,
    });
  });

  app.get('/admin/tenants/:tenantId/dashboard', (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    try {
      const tenant = tenantService.get(tenantId);
      return c.json({ tenantId, tenant, ...stats.tenantDashboard(tenantId) });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.get('/admin/tenants/:tenantId', (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    try {
      return c.json({ tenant: tenantService.get(tenantId) });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  /**
   * Provisiona nuovo tenant (Phase 5 enterprise):
   *   1. Crea record tenants con tutti i metadata (legal_name, P.IVA, billing, ecc.)
   *   2. Crea utente owner del tenant atomically
   *   3. Audit log tenant.provision
   * Se uno dei due fallisce, transazione SQLite rollback completo.
   */
  app.post('/admin/tenants', zValidator('json', CreateTenantSchema), async (c) => {
    const body = c.req.valid('json');
    const auth = c.get('auth');
    const { sqlite } = getDatabase();

    const userId = nanoid();
    const passwordHash = await hashPassword(body.ownerPassword);
    const now = new Date().toISOString();

    const txn = sqlite.transaction(() => {
      const createInput: Parameters<typeof tenantService.create>[0] = {
        slug: body.tenantSlug,
        displayName: body.displayName ?? body.tenantSlug,
        ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
        ...(body.vatNumber !== undefined ? { vatNumber: body.vatNumber } : {}),
        ...(body.taxCode !== undefined ? { taxCode: body.taxCode } : {}),
        ...(body.billingEmail !== undefined ? { billingEmail: body.billingEmail } : {}),
        ...(body.billingAddress !== undefined ? { billingAddress: body.billingAddress } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.plan !== undefined ? { plan: body.plan } : {}),
        ...(body.trialEndsAt !== undefined ? { trialEndsAt: body.trialEndsAt } : {}),
        ...(body.maxWorkflows !== undefined ? { maxWorkflows: body.maxWorkflows } : {}),
        ...(body.maxRunsPerMonth !== undefined ? { maxRunsPerMonth: body.maxRunsPerMonth } : {}),
        ...(body.maxStorageMb !== undefined ? { maxStorageMb: body.maxStorageMb } : {}),
        ...(auth?.userId ? { createdByUserId: auth.userId } : {}),
      };
      const tenant = tenantService.create(createInput, auth?.userId);
      sqlite
        .prepare(
          'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        )
        .run(userId, body.tenantSlug, body.ownerEmail, body.ownerName, passwordHash, 'owner', now, now);
      return tenant;
    });

    let tenant;
    try {
      tenant = txn();
    } catch (e) {
      if (e instanceof TenantSlugConflictError) {
        return c.json({ error: e.message }, 409);
      }
      throw e;
    }

    // #208 P0-9: await — audit MUST be durable (no fire-and-forget).
    // Se crashiamo tra return e fsync, perdiamo l'evento → audit chain gap.
    await audit.append({
      tenantId: body.tenantSlug,
      action: 'tenant.provision',
      resourceType: 'tenant',
      resourceId: body.tenantSlug,
      ...(auth?.userId ? { actorId: auth.userId } : {}),
      metadata: { ownerEmail: body.ownerEmail, provisionedBy: auth?.email ?? 'unknown', plan: tenant.plan },
    });

    logger.info({ tenantSlug: body.tenantSlug, plan: tenant.plan, by: auth?.email }, 'Tenant provisioned (Phase 5)');

    return c.json({
      ok: true,
      tenant,
      owner: { id: userId, email: body.ownerEmail, displayName: body.ownerName },
    }, 201);
  });

  app.patch('/admin/tenants/:tenantId', zValidator('json', UpdateTenantSchema), (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    const auth = c.get('auth');
    const rawPatch = c.req.valid('json');
    const patch: Parameters<typeof tenantService.update>[1] = {};
    for (const [k, v] of Object.entries(rawPatch)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    try {
      const tenant = tenantService.update(tenantId, patch, auth?.userId);
      return c.json({ tenant });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post('/admin/tenants/:tenantId/suspend', zValidator('json', ReasonSchema), (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    const auth = c.get('auth');
    const { reason } = c.req.valid('json');
    try {
      const tenant = tenantService.suspend(tenantId, reason, auth?.userId);
      return c.json({ tenant });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post('/admin/tenants/:tenantId/activate', (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    const auth = c.get('auth');
    try {
      const tenant = tenantService.activate(tenantId, auth?.userId);
      return c.json({ tenant });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post('/admin/tenants/:tenantId/archive', zValidator('json', ReasonSchema), (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    const auth = c.get('auth');
    const { reason } = c.req.valid('json');
    try {
      const tenant = tenantService.archive(tenantId, reason, auth?.userId);
      return c.json({ tenant });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  /**
   * Soft delete tenant (GDPR-compliant). Il record resta per audit + ricostruzione
   * legale, ma è invisibile a query normali. NON cancella i dati operativi
   * (workflows, runs, users) — quelli vanno cancellati separatamente con
   * un endpoint dedicato di GDPR-purge (out of scope qui).
   */
  app.delete('/admin/tenants/:tenantId', zValidator('json', ReasonSchema), (c) => {
    const tenantId = c.req.param('tenantId');
    if (!tenantId) return c.json({ error: 'Bad request' }, 400);
    if (tenantId === 'default') {
      return c.json({ error: 'Il tenant "default" è di sistema, non eliminabile.' }, 400);
    }
    const auth = c.get('auth');
    const { reason } = c.req.valid('json');
    try {
      tenantService.softDelete(tenantId, reason, auth?.userId);
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof TenantNotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });
}
