/**
 * Audit degli accessi CROSS-TENANT del superadmin (fix 2026-06-15).
 *
 * La vista "gestore del server" (dashboard stream/workflows del superadmin
 * SENZA impersonate) espone dati di TUTTI i tenant: run, errori, nomi e
 * struttura dei workflow. Su una piattaforma GDPR-native con audit chain,
 * un accesso privilegiato che ATTRAVERSA il confine tenant DEVE lasciare una
 * traccia. Prima un commento in dashboard.ts dichiarava "audit tracciato" ma
 * NESSUN audit veniva emesso (rassicurazione falsa). Ora la traccia è reale:
 * va sul canale `audit` del logging PSR-3 (file giornaliero audit-YYYY-MM-DD.log,
 * interrogabile via read_logs dal super_admin).
 *
 * @module lib/audit-log
 */
import { loggerFor } from './logger.js';

// moduleName con prefisso `audit.` → detectChannel lo instrada sul canale 'audit'.
const auditLogger = loggerFor('audit.cross_tenant_access');

export interface CrossTenantAccessAudit {
  userId: string;
  email?: string;
  /** Azione che ha esposto dati cross-tenant (es. 'dashboard.stream'). */
  action: string;
  /** 'all-tenants' (bird's-eye, no impersonate) o il tenantId impersonato. */
  scope: string;
  /** IP del chiamante, se ricavabile dagli header proxy. */
  ip?: string;
}

/** Emette una voce di audit per un accesso cross-tenant del superadmin. */
export function auditCrossTenantAccess(a: CrossTenantAccessAudit): void {
  auditLogger.warn(
    { event: 'cross_tenant_access', ...a },
    `superadmin cross-tenant access: ${a.action} (scope=${a.scope})`,
  );
}
