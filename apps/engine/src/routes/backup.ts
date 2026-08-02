/**
 * Backup & restore endpoints. Dumps every persisted table into a single
 * JSON envelope; restore writes back into the SAME tenant only (cross-tenant
 * restore is refused for safety).
 *
 * The endpoints stream — for production-scale runs a CLI alternative
 * (apps/cli backup) is the recommended path.
 */

import { Hono } from 'hono';
import { getDatabase } from '@/storage/db.js';
import { getTenantId } from '@/lib/tenant.js';
import { requireRole } from '@/middleware/auth.js';

interface BackupEnvelope {
  schemaVersion: '1.0.0';
  exportedAt: string;
  tenantId: string;
  workflows: unknown[];
  runs: unknown[];
  credentials: unknown[];
  db_studio_databases: unknown[];
  workflow_variables: unknown[];
  workflow_versions: unknown[];
  audit_log: unknown[];
}

/**
 * Allowlist delle tabelle tenant-scoped esportabili/ripristinabili. Esportata
 * come SOURCE OF TRUTH: il gate schema-coverage (db-schema-coverage.test.ts) la
 * importa per validare le query a nome-tabella dinamico (`FROM ${table}`) contro
 * OGNI tabella reale dell'allowlist — così un drift su una qualunque di queste
 * (es. tenant_id rinominato) fa fallire il build invece di rompere in prod.
 */
export const EXPORT_TABLES = [
  'workflows',
  'runs',
  'credentials',
  'db_studio_databases',
  'workflow_variables',
  'workflow_versions',
  'audit_log',
  'user_credentials',
] as const;

export function createBackupRoutes(): Hono {
  const app = new Hono();

  // SECURITY (broken-access-control fix): backup espone E sovrascrive tabelle
  // sensibili — `credentials`, `user_credentials` (segreti integrazione) e
  // `audit_log` (immutabile by design). Senza questo guard QUALSIASI ruolo
  // autenticato (anche `viewer` sola-lettura) poteva esfiltrare tutte le
  // credenziali del tenant via /export e riscrivere l'audit log via /restore.
  // Owner-only, coerente con il router /users.
  app.use('/backup/*', requireRole('owner'));

  app.get('/backup/export', (c) => {
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    const envelope: Record<string, unknown> = {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      tenantId,
    };
    for (const table of EXPORT_TABLES) {
      try {
        const rows = sqlite.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?`).all(tenantId);
        envelope[table] = rows;
      } catch {
        envelope[table] = [];
      }
    }
    return c.json(envelope satisfies Partial<BackupEnvelope>);
  });

  app.post('/backup/restore', async (c) => {
    const tenantId = getTenantId(c);
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object')
      return c.json({ error: 'Body must be a JSON envelope' }, 400);
    const envelope = raw as Record<string, unknown>;
    if (envelope.tenantId !== tenantId) {
      return c.json(
        { error: 'Cross-tenant restore refused. Headers tenant must match envelope tenant.' },
        403,
      );
    }
    const { sqlite } = getDatabase();
    const counts: Record<string, number> = {};
    for (const table of EXPORT_TABLES) {
      const rows = envelope[table];
      if (!Array.isArray(rows)) continue;
      try {
        const sample = rows[0] as Record<string, unknown> | undefined;
        if (!sample) continue;
        // SECURITY: i nomi colonna NON sono parametrizzabili (`?` non vale per
        // identifier) → vanno validati. Le chiavi vengono dal JSON utente:
        // senza whitelist sarebbe identifier-injection. Whitelisto contro lo
        // schema REALE via PRAGMA (table è da EXPORT_TABLES, allowlist → safe).
        const realCols = new Set(
          (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
            (r) => r.name,
          ),
        );
        const cols = Object.keys(sample).filter((k) => realCols.has(k));
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = sqlite.prepare(
          `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
        );
        let count = 0;
        const txn = sqlite.transaction((items: Record<string, unknown>[]) => {
          for (const item of items) {
            // Valori nell'ordine ESATTO delle colonne validate (non
            // Object.values, che includerebbe chiavi scartate / ordine errato).
            stmt.run(...cols.map((k) => item[k] ?? null));
            count += 1;
          }
        });
        txn(rows as Record<string, unknown>[]);
        counts[table] = count;
      } catch {
        counts[table] = -1;
      }
    }
    return c.json({ restored: counts });
  });

  return app;
}
