/**
 * TenantService — gestione first-class dei tenant (Phase 5 enterprise).
 *
 * Prima di Phase 5 il tenant era una stringa libera, "esisteva" se aveva
 * almeno un user. Ora è un'entità completa con lifecycle, status, plan,
 * quote, settings, soft-delete, audit log per ogni operazione.
 *
 * Operazioni:
 *   • create(input)              → provisiona nuovo tenant + audit
 *   • get(id)                    → lookup
 *   • list(opts)                 → paginated con filter status/plan
 *   • update(id, patch)          → patch metadata + audit
 *   • suspend(id, reason)        → status=suspended (impedisce login/run)
 *   • activate(id)               → status=active (re-enable)
 *   • archive(id)                → status=archived (read-only, no run)
 *   • softDelete(id)             → deleted_at=NOW (GDPR-compliant)
 *   • checkQuota(id, kind, n)    → throw QuotaExceededError se sopra limite
 *   • assertActive(id)           → throw TenantNotActiveError se non attivo
 *
 * Tutti i metodi che modificano scrivono audit log via AuditLogService.
 * Tutti i lookup escludono soft-deleted (deleted_at IS NULL).
 */

import { statfsSync } from 'node:fs';
import { getDatabase } from '@/storage/db.js';
import { loadConfig } from '@/config.js';
import { AuditLogService } from './audit.service.js';
import { logger } from '@/lib/logger.js';

export type TenantStatus = 'trial' | 'active' | 'suspended' | 'archived';
export type TenantPlan = 'trial' | 'starter' | 'pro' | 'enterprise';

export interface Tenant {
  id: string;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxCode: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  country: string;
  locale: string;
  timezone: string;
  status: TenantStatus;
  trialEndsAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  archivedAt: string | null;
  plan: TenantPlan;
  subscriptionRef: string | null;
  maxWorkflows: number;
  maxRunsPerMonth: number;
  maxStorageMb: number;
  settings: Record<string, unknown>;
  parentTenantId: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  deletedAt: string | null;
}

interface TenantRow {
  id: string;
  display_name: string;
  legal_name: string | null;
  vat_number: string | null;
  tax_code: string | null;
  billing_email: string | null;
  billing_address: string | null;
  country: string;
  locale: string;
  timezone: string;
  status: TenantStatus;
  trial_ends_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  archived_at: string | null;
  plan: TenantPlan;
  subscription_ref: string | null;
  max_workflows: number;
  max_runs_per_month: number;
  max_storage_mb: number;
  settings_json: string;
  parent_tenant_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  deleted_at: string | null;
}

function rowToTenant(r: TenantRow): Tenant {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(r.settings_json) as Record<string, unknown>; }
  catch { /* fall through to {} */ }
  return {
    id: r.id, displayName: r.display_name,
    legalName: r.legal_name, vatNumber: r.vat_number, taxCode: r.tax_code,
    billingEmail: r.billing_email, billingAddress: r.billing_address,
    country: r.country, locale: r.locale, timezone: r.timezone,
    status: r.status,
    trialEndsAt: r.trial_ends_at, suspendedAt: r.suspended_at,
    suspendedReason: r.suspended_reason, archivedAt: r.archived_at,
    plan: r.plan, subscriptionRef: r.subscription_ref,
    maxWorkflows: r.max_workflows, maxRunsPerMonth: r.max_runs_per_month,
    maxStorageMb: r.max_storage_mb, settings,
    parentTenantId: r.parent_tenant_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
    createdByUserId: r.created_by_user_id, deletedAt: r.deleted_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Custom errors per lifecycle enforcement
// ─────────────────────────────────────────────────────────────────────────

export class TenantNotFoundError extends Error {
  constructor(id: string) { super(`Tenant non trovato: "${id}"`); this.name = 'TenantNotFoundError'; }
}
export class TenantNotActiveError extends Error {
  constructor(id: string, status: TenantStatus, reason: string | null) {
    super(`Tenant "${id}" non operativo (status=${status}${reason ? `, motivo: ${reason}` : ''})`);
    this.name = 'TenantNotActiveError';
  }
}
export class TenantSlugConflictError extends Error {
  constructor(slug: string) { super(`Slug tenant "${slug}" già in uso`); this.name = 'TenantSlugConflictError'; }
}
export class QuotaExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly kind: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`Quota "${kind}" esaurita per tenant "${tenantId}" (limite ${limit.toString()}, uso ${current.toString()})`);
    this.name = 'QuotaExceededError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TenantService
// ─────────────────────────────────────────────────────────────────────────

export interface CreateTenantInput {
  slug: string;
  displayName: string;
  legalName?: string;
  vatNumber?: string;
  taxCode?: string;
  billingEmail?: string;
  billingAddress?: string;
  country?: string;
  locale?: string;
  timezone?: string;
  status?: TenantStatus;
  plan?: TenantPlan;
  trialEndsAt?: string;
  maxWorkflows?: number;
  maxRunsPerMonth?: number;
  maxStorageMb?: number;
  parentTenantId?: string;
  createdByUserId?: string;
  settings?: Record<string, unknown>;
}

export interface UpdateTenantInput {
  displayName?: string;
  legalName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  billingEmail?: string | null;
  billingAddress?: string | null;
  country?: string;
  locale?: string;
  timezone?: string;
  plan?: TenantPlan;
  subscriptionRef?: string | null;
  maxWorkflows?: number;
  maxRunsPerMonth?: number;
  maxStorageMb?: number;
  trialEndsAt?: string | null;
  settings?: Record<string, unknown>;
}

export interface ListTenantsOpts {
  status?: TenantStatus | 'all';
  plan?: TenantPlan;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export class TenantService {
  private readonly audit = new AuditLogService();

  /** Provision nuovo tenant. Slug deve essere unico (anche fra deleted_at NOT NULL? no, riusabile). */
  create(input: CreateTenantInput, actorUserId?: string): Tenant {
    const { sqlite } = getDatabase();
    const slug = input.slug.toLowerCase().trim();

    // Validation slug — regex stessa di /admin/tenants endpoint
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) {
      throw new Error(`Slug "${slug}" non valido: serve 3-64 char, [a-z 0-9 -], no leading/trailing dash.`);
    }
    // Conflitto solo su tenant ATTIVI (deleted_at IS NULL)
    const existing = sqlite.prepare('SELECT 1 FROM tenants WHERE id = ? AND deleted_at IS NULL').get(slug);
    if (existing) throw new TenantSlugConflictError(slug);

    const settingsJson = JSON.stringify(input.settings ?? {});
    sqlite.prepare(`
      INSERT INTO tenants (
        id, display_name, legal_name, vat_number, tax_code,
        billing_email, billing_address, country, locale, timezone,
        status, trial_ends_at, plan,
        max_workflows, max_runs_per_month, max_storage_mb,
        settings_json, parent_tenant_id, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug,
      input.displayName,
      input.legalName ?? null,
      input.vatNumber ?? null,
      input.taxCode ?? null,
      input.billingEmail ?? null,
      input.billingAddress ?? null,
      input.country ?? 'IT',
      input.locale ?? 'it',
      input.timezone ?? 'Europe/Rome',
      input.status ?? 'active',
      input.trialEndsAt ?? null,
      input.plan ?? 'enterprise',
      input.maxWorkflows ?? 0,
      input.maxRunsPerMonth ?? 0,
      input.maxStorageMb ?? 0,
      settingsJson,
      input.parentTenantId ?? null,
      input.createdByUserId ?? actorUserId ?? null,
    );
    this.audit.appendSync({
      tenantId: slug,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.created', resourceType: 'tenant', resourceId: slug,
      metadata: { displayName: input.displayName, plan: input.plan ?? 'enterprise' },
    });
    logger.info({ slug, plan: input.plan ?? 'enterprise' }, 'Tenant provisioned');
    return this.get(slug);
  }

  /** Lookup by id — throw se non trovato o soft-deleted. */
  get(id: string): Tenant {
    const tenant = this.find(id);
    if (!tenant) throw new TenantNotFoundError(id);
    return tenant;
  }

  /** Lookup by id — null se non trovato. NON include deleted. */
  find(id: string): Tenant | null {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(
      'SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as TenantRow | undefined;
    return row ? rowToTenant(row) : null;
  }

  /** Lista tenant con filter+paginate. */
  list(opts: ListTenantsOpts = {}): { tenants: Tenant[]; total: number } {
    const { sqlite } = getDatabase();
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeDeleted) where.push('deleted_at IS NULL');
    if (opts.status && opts.status !== 'all') { where.push('status = ?'); params.push(opts.status); }
    if (opts.plan) { where.push('plan = ?'); params.push(opts.plan); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (sqlite.prepare(`SELECT COUNT(*) AS n FROM tenants ${whereSql}`).get(...params) as { n: number }).n;
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = sqlite.prepare(
      `SELECT * FROM tenants ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as TenantRow[];
    return { tenants: rows.map(rowToTenant), total };
  }

  /** Patch metadata. Status NON modificabile da qui (usa suspend/activate/archive). */
  update(id: string, patch: UpdateTenantInput, actorUserId?: string): Tenant {
    const current = this.get(id);  // throw if not found
    const { sqlite } = getDatabase();
    const sets: string[] = [];
    const params: unknown[] = [];
    const colMap: Record<keyof UpdateTenantInput, string> = {
      displayName: 'display_name', legalName: 'legal_name',
      vatNumber: 'vat_number', taxCode: 'tax_code',
      billingEmail: 'billing_email', billingAddress: 'billing_address',
      country: 'country', locale: 'locale', timezone: 'timezone',
      plan: 'plan', subscriptionRef: 'subscription_ref',
      maxWorkflows: 'max_workflows', maxRunsPerMonth: 'max_runs_per_month',
      maxStorageMb: 'max_storage_mb', trialEndsAt: 'trial_ends_at',
      settings: 'settings_json',
    };
    for (const [k, col] of Object.entries(colMap) as [keyof UpdateTenantInput, string][]) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      const v = patch[k];
      params.push(k === 'settings' ? JSON.stringify(v ?? {}) : v ?? null);
    }
    if (sets.length === 0) return current;
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    sqlite.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    this.audit.appendSync({
      tenantId: id,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.updated', resourceType: 'tenant', resourceId: id,
      metadata: { changes: Object.keys(patch) },
    });
    return this.get(id);
  }

  /** Sospensione: il tenant non può più login/eseguire workflow. Reversibile via activate(). */
  suspend(id: string, reason: string, actorUserId?: string): Tenant {
    this.get(id);
    const { sqlite } = getDatabase();
    sqlite.prepare(`
      UPDATE tenants SET status = 'suspended',
        suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        suspended_reason = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(reason, id);
    this.audit.appendSync({
      tenantId: id,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.suspended', resourceType: 'tenant', resourceId: id,
      metadata: { reason },
    });
    logger.warn({ tenantId: id, reason }, 'Tenant suspended');
    return this.get(id);
  }

  /** Riattiva tenant sospeso. */
  activate(id: string, actorUserId?: string): Tenant {
    this.get(id);
    const { sqlite } = getDatabase();
    sqlite.prepare(`
      UPDATE tenants SET status = 'active',
        suspended_at = NULL, suspended_reason = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
    this.audit.appendSync({
      tenantId: id,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.activated', resourceType: 'tenant', resourceId: id,
    });
    logger.info({ tenantId: id }, 'Tenant activated');
    return this.get(id);
  }

  /**
   * Archivio: read-only, niente run. Usato per fine-contratto senza GDPR-delete.
   * `reason` OBBLIGATORIO (audit 2026-07-02 #5): un'operazione distruttiva DEVE
   * lasciare il MOTIVO nell'audit (query anti-abuso + accountability GDPR).
   */
  archive(id: string, reason: string, actorUserId?: string): Tenant {
    this.get(id);
    const { sqlite } = getDatabase();
    sqlite.prepare(`
      UPDATE tenants SET status = 'archived',
        archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
    this.audit.appendSync({
      tenantId: id,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.archived', resourceType: 'tenant', resourceId: id,
      metadata: { reason },
    });
    return this.get(id);
  }

  /**
   * Soft delete GDPR-compliant. Il record resta per audit ma è invisibile a
   * tutti i query. `reason` OBBLIGATORIO (audit 2026-07-02 #5) — è l'azione più
   * distruttiva del lifecycle tenant, il motivo va tracciato.
   */
  softDelete(id: string, reason: string, actorUserId?: string): void {
    this.get(id);
    const { sqlite } = getDatabase();
    sqlite.prepare(`
      UPDATE tenants SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(id);
    this.audit.appendSync({
      tenantId: id,
      ...(actorUserId ? { actorId: actorUserId } : {}),
      action: 'tenant.deleted', resourceType: 'tenant', resourceId: id,
      metadata: { reason },
    });
    logger.warn({ tenantId: id, reason }, 'Tenant soft-deleted');
  }

  /**
   * Guard: chiama all'inizio di ogni operazione critica (login,
   * workflow run, file upload). Throw se tenant non attivo.
   */
  assertActive(id: string): Tenant {
    const t = this.get(id);
    if (t.status !== 'active' && t.status !== 'trial') {
      throw new TenantNotActiveError(id, t.status, t.suspendedReason);
    }
    if (t.status === 'trial' && t.trialEndsAt && new Date(t.trialEndsAt) < new Date()) {
      throw new TenantNotActiveError(id, t.status, 'trial scaduto');
    }
    return t;
  }

  /**
   * Quota enforcement (limite=0 → unlimited).
   *
   * 2026-06-04 policy update — `workflows` quota = ATTIVI (`enabled=1`), non
   * totali. L'utente può creare quanti workflow vuole come bozze, ma può
   * tenerne abilitati al massimo `max_workflows` parallelamente. Allinea
   * la semantica al pattern n8n (più permissivo lato content authoring,
   * stretto lato esecuzione concorrente). Disattivare un workflow libera
   * subito lo slot per attivarne un altro.
   */
  checkQuota(id: string, kind: 'workflows' | 'runs_per_month' | 'storage_mb', requested = 1): void {
    const t = this.get(id);
    const { sqlite } = getDatabase();
    let limit = 0;
    let current = 0;
    if (kind === 'workflows') {
      limit = t.maxWorkflows;
      if (limit <= 0) return;
      // Conta SOLO i workflow `enabled=1`. La quota è sui "running parallel".
      current = (sqlite.prepare('SELECT COUNT(*) AS n FROM workflows WHERE tenant_id = ? AND enabled = 1').get(id) as { n: number }).n;
    } else if (kind === 'runs_per_month') {
      limit = t.maxRunsPerMonth;
      if (limit <= 0) return;
      const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      // FIX 2026-06-06 (db-schema-coverage test): la tabella è `runs`, non
      // `workflow_runs` (fantasma) → la quota runs_per_month andava in errore
      // "no such table" per ogni piano con limite finito. `runs` ha tenant_id
      // + started_at (migrate.schema.ts).
      current = (sqlite.prepare(`SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ? AND started_at >= ?`).get(id, firstOfMonth) as { n: number }).n;
    } else if (kind === 'storage_mb') {
      limit = t.maxStorageMb;
      if (limit <= 0) return;
      // Misura reale del volume del tenant via statfs (vedi getStorageUsageMb).
      current = this.getStorageUsageMb();
    }
    if (current + requested > limit) {
      throw new QuotaExceededError(id, kind, limit, current);
    }
  }

  /**
   * Uso disco reale del volume del tenant, in MB. Il runtime gira DENTRO il
   * container: `MEDEA_DATA_DIR` è il mount ext4 (loop device) del tenant,
   * quindi `statfs` misura ESATTAMENTE lo spazio occupato dal tenant — DB
   * SQLite, embeddings RAG, run log, file caricati: tutto vive su quel volume.
   * Stessa primitiva (statfs, no shell/sudo) di `portal getMountUsageBytes`, ma
   * lato container e SINCRONA perché `checkQuota` è sincrona.
   *
   * `used = (blocks − bfree) × bsize` (identico al portal, per coerenza).
   *
   * Fail-open su errore di misura (return 0): il kernel impone già ENOSPC hard
   * alla dimensione del loop device (`plan.diskGb`), quindi la quota app-level
   * è difesa-in-profondità, non l'unica linea. Un errore `statfs` transitorio
   * non deve bloccare le operazioni del tenant.
   */
  getStorageUsageMb(): number {
    try {
      const config = loadConfig();
      const st = statfsSync(config.MEDEA_DATA_DIR);
      const usedBytes = Math.max(0, (Number(st.blocks) - Number(st.bfree)) * Number(st.bsize));
      return Math.floor(usedBytes / (1024 * 1024));
    } catch (err) {
      logger.warn({ err: String(err) }, '[QUOTA] statfs storage measure failed — fail-open (kernel ENOSPC resta backstop)');
      return 0;
    }
  }
}

export const tenantService = new TenantService();
