/**
 * GET /api/v1/tenant/health — stato runtime del container del tenant.
 *
 * Alimenta la tab Settings → "Stato tenant" (ex tab "Multi-tenant" legacy).
 * Espone solo dati che il runtime conosce con certezza (vedi
 * services/tenant-health.service.ts). Auth: cookie token (come gli altri
 * /api/v1/account|tenant endpoint).
 */
import type { Hono } from 'hono';
import { getBinaryStore } from '@/services/binary-store.service.js';
import { getDatabase } from '@/storage/db.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import { collectTenantHealth } from '@/services/tenant-health.service.js';

const BYTES_PER_GB = 1024 ** 3;

/** COUNT(*) fail-soft su una tabella del SQLite locale. */
function countRows(table: 'workflows' | 'runs'): number {
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch (e) {
    logger.warn({ err: e, table }, '[tenant-health] count failed');
    return 0;
  }
}

export function registerTenantHealthRoute(app: Hono): void {
  app.get('/api/v1/tenant/health', async (c) => {
    const cfg = loadConfig();
    const health = await collectTenantHealth({
      tenantId: cfg.MEDEA_TENANT_ID ?? null,
      plan: {
        code: cfg.MEDEA_PLAN_CODE,
        diskGb: cfg.MEDEA_PLAN_DISK_GB,
        vectorMaxVectors: cfg.MEDEA_PLAN_VECTOR_MAX_VECTORS ?? null,
        vectorMaxDiskMb: cfg.MEDEA_PLAN_VECTOR_MAX_DISK_MB ?? null,
      },
      uptimeSeconds: process.uptime(),
      countWorkflows: () => countRows('workflows'),
      countRuns: () => countRows('runs'),
      // usedBytes = blob binari del tenant (probe leggera già usata da
      // /account/storage). total = quota disco del piano.
      storageUsedBytes: () => getBinaryStore().usage(),
      storageTotalBytes: cfg.MEDEA_PLAN_DISK_GB * BYTES_PER_GB,
    });
    return c.json({ ok: true, health });
  });
}
