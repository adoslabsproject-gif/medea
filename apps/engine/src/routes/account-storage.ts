/**
 * Account → Storage endpoint (F2 Cappella batch 2026-06-07 sera).
 *
 * Espone le quote tier-aware del tenant + l'usage corrente del disco.
 * Consumato dalla UI Settings → Logging per disegnare la barra "spazio
 * usato vs disponibile" + dal banner di alert F4 quando saturo.
 *
 * Auth: token cookie (tutti i ruoli viewer-up). Pattern allineato agli
 * altri /account endpoint del runtime tenant.
 */
import type { Hono } from 'hono';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentQuotas } from '@/services/storage-quota.service.js';
import { getBinaryStore } from '@/services/binary-store.service.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';

/**
 * Walk ricorsivo per misurare lo spazio occupato da una directory.
 * Best-effort: errori (permessi, broken symlink) loggati e contati come 0.
 */
function dirSizeBytes(path: string): number {
  let total = 0;
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const child = join(path, name);
      try {
        if (entry.isDirectory()) total += dirSizeBytes(child);
        else if (entry.isFile()) total += statSync(child).size;
      } catch { /* skip */ }
    }
  } catch { /* dir not present yet */ }
  return total;
}

export function registerAccountStorageRoute(app: Hono): void {
  app.get('/api/v1/account/storage', async (c) => {
    const quotas = getCurrentQuotas();
    const dataDir = loadConfig().MEDEA_DATA_DIR;
    let workflowDataUsedBytes = 0;
    let logUsedBytes = 0;
    try {
      // Workflow data = SQLite + user-databases + installed-nodes
      const sqliteSize = (() => {
        try { return statSync(join(dataDir, 'flowforge.sqlite')).size; } catch { return 0; }
      })();
      const walSize = (() => {
        try { return statSync(join(dataDir, 'flowforge.sqlite-wal')).size; } catch { return 0; }
      })();
      const userDbs = dirSizeBytes(join(dataDir, 'user-databases'));
      workflowDataUsedBytes = sqliteSize + walSize + userDbs;
      // Log retention = archives dir (creato in F3)
      logUsedBytes = dirSizeBytes(join(dataDir, 'archives'));
    } catch (e) {
      logger.warn({ err: e }, '[account-storage] usage probe failed');
    }

    // Binary blob usage (gap #13): BinaryStore.usage() somma i byte dei blob
    // content-addressed (allegati, output binari ref). I blob vivono SUL disco
    // del tenant (contano già nel totale loop-ext4), ma esporli a parte dà
    // visibilità su "quanto dei miei dati sono file binari". Fail-soft: una
    // probe fallita non deve rompere la dashboard storage.
    let binaryUsedBytes = 0;
    try {
      binaryUsedBytes = await getBinaryStore().usage();
    } catch (e) {
      logger.warn({ err: e }, '[account-storage] binary usage probe failed');
    }

    return c.json({
      plan: { code: quotas.planCode, freeTier: quotas.freeTier },
      total: { bytes: quotas.totalBytes },
      workflowData: {
        quotaBytes: quotas.workflowDataBytes,
        usedBytes: workflowDataUsedBytes,
        usedPercent: quotas.workflowDataBytes === 0 ? 0
          : Math.min(100, Math.round((workflowDataUsedBytes / quotas.workflowDataBytes) * 100)),
      },
      log: {
        quotaBytes: quotas.logRetentionBytes,
        usedBytes: logUsedBytes,
        usedPercent: quotas.logRetentionBytes === 0 ? 0
          : Math.min(100, Math.round((logUsedBytes / quotas.logRetentionBytes) * 100)),
      },
      // Sottoinsieme del workflowData (i blob sono sotto MEDEA_DATA_DIR/blobs):
      // informativo, non una quota separata.
      binary: {
        usedBytes: binaryUsedBytes,
      },
    });
  });
}
