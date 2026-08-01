/**
 * Upsert del tenant locale dal claim SSO — A2 free-trial.
 *
 * Estratto da routes/sso.ts (modularità + test isolato su SQLite reale).
 * Il portal è source-of-truth del billing e porta nel claim `tenantStatus`
 * ('trial'|'active') + `trialEndsAt` (= createdAt+14gg finché senza subscription).
 */
import { getDatabase } from '@/storage/db.js';

/**
 * Stato tenant trasportabile nel claim SSO (subset di TenantStatus). Solo
 * questi due: 'suspended'/'archived' sono azioni admin nel runtime, MAI dal
 * billing/claim.
 */
export type TenantStatusClaim = 'trial' | 'active';

/** Normalizza il claim tenantStatus → fail-safe su 'active' (mai trial spurio). */
export function normalizeTenantStatusClaim(raw: unknown): TenantStatusClaim {
  return raw === 'trial' ? 'trial' : 'active';
}

/**
 * Upsert del tenant al (primo e ad ogni) SSO:
 *  - INSERT con lo stato dal claim (default 'active' se claim assente →
 *    retrocompatibile: nessun trial retroattivo sui tenant esistenti).
 *  - ON CONFLICT: sincronizza status + trial_ends_at dal claim (es. trial→active
 *    dopo il pagamento), MA NON sovrascrive 'suspended'/'archived' — azioni
 *    admin punitive che il billing non deve annullare (anti-bypass).
 */
export function ensureTenant(args: {
  tenantId: string;
  displayName: string;
  status?: TenantStatusClaim;
  trialEndsAt?: string | null;
}): void {
  const { sqlite } = getDatabase();
  const status: TenantStatusClaim = args.status ?? 'active';
  const trialEndsAt = args.trialEndsAt ?? null;
  sqlite
    .prepare(
      `INSERT INTO tenants
         (id, display_name, status, plan, country, locale, timezone, max_workflows, max_runs_per_month, max_storage_mb, trial_ends_at)
       VALUES (?, ?, ?, 'enterprise', 'IT', 'it', 'Europe/Rome', 0, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         trial_ends_at = excluded.trial_ends_at
       WHERE tenants.status NOT IN ('suspended', 'archived')`,
    )
    .run(args.tenantId, args.displayName || args.tenantId, status, trialEndsAt);
}
