/**
 * vector-quota-flag — override LIVE della quota vettoriale del piano.
 *
 * I limiti quota (max vettori / max disco MB) arrivano di default dall'env del
 * container (`MEDEA_PLAN_VECTOR_MAX_*`, settato a provision/redeploy dal portal).
 * Ma un cambio piano (up/downgrade) deve diventare effettivo SUBITO e in modo
 * resiliente, senza dipendere dal buon esito del recreate del container: il portal
 * SPINGE i nuovi limiti qui (POST /internal/workspace/vector-quota), come fa per il
 * read-only (Layer 2). Stesso identico pattern → coerenza, zero divergenza.
 *
 * Precedenza: override (se presente) > env. Persistito in `system_flags` (sopravvive
 * al restart) + cache in-memory (la lettura è nel hot-path di OGNI ingest → no query
 * per-ingest). Single-tenant per container → un solo valore globale.
 *
 * Fail-OPEN: se il DB non è pronto / valore corrotto → nessun override (si usa l'env);
 * la disponibilità batte l'enforcement, e l'accounting aggregato + ENOSPC restano i
 * backstop. Coerente con readonly-flag.
 */
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { recordFailOpen } from '@/lib/fail-open-metrics.js';

const FLAG_KEY = 'vector_quota_override';

export interface VectorQuotaOverride {
  /** null = illimitato (override esplicito a "nessun limite"). */
  maxVectors: number | null;
  maxDiskMb: number | null;
}

// undefined = cache non popolata; null = nessun override (usa env); object = override attivo.
let cached: VectorQuotaOverride | null | undefined;

function parse(raw: string): VectorQuotaOverride | null {
  const o = JSON.parse(raw) as unknown;
  if (o === null || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  const norm = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  // Distinzione esplicita: chiave assente → null; presente numerica → numero; null → illimitato.
  return {
    maxVectors: 'maxVectors' in rec ? norm(rec.maxVectors) : null,
    maxDiskMb: 'maxDiskMb' in rec ? norm(rec.maxDiskMb) : null,
  };
}

/** Override corrente, o null se non impostato/corrotto (→ il chiamante usa l'env). */
export function getVectorQuotaOverride(): VectorQuotaOverride | null {
  if (cached !== undefined) return cached;
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get(FLAG_KEY) as { value: string } | undefined;
    cached = row?.value ? parse(row.value) : null;
  } catch (err) {
    // Fail-open deliberato: senza override si usa l'env + backstop ENOSPC. Ma un
    // guasto DB persistente lascerebbe la quota non-applicata in silenzio → metrica.
    recordFailOpen('vector_quota', err);
    cached = null;
  }
  return cached;
}

export function setVectorQuotaOverride(override: VectorQuotaOverride): void {
  const value = JSON.stringify({ maxVectors: override.maxVectors, maxDiskMb: override.maxDiskMb });
  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      `INSERT INTO system_flags (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(FLAG_KEY, value);
  cached = { maxVectors: override.maxVectors, maxDiskMb: override.maxDiskMb };
  logger.info({ maxVectors: override.maxVectors, maxDiskMb: override.maxDiskMb }, 'vector quota override updated');
}

/** Per i test: resetta la cache in-memory. */
export function __resetVectorQuotaCacheForTest(): void {
  cached = undefined;
}
