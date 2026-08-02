/**
 * StorageQuotaService — tier-aware disk allocation (F2 Cappella batch).
 *
 * Why
 * ───
 * Il disco del container tenant (`disk_gb` del piano) è una risorsa unica:
 * deve coprire SIA i dati di workflow attivi (config, allegati, SQLite
 * stesso) SIA la cronologia runs archiviata. Senza una split esplicita,
 * un workflow con `runVerbosity='full'` ad alta frequenza può saturare
 * il disco e bloccare anche il workspace operativo.
 *
 * Split decisa (2026-06-07 sera, conferma utente):
 *   - 70% → workflow data quota (SQLite, allegati, user-databases, ecc.)
 *   - 30% → runs log retention quota (steps_json, archivi compressi)
 *
 * Eccezione tier Free:
 *   - 100% workflow data, 0% log → tenant Free non può abilitare
 *     persistenza runs. Forzato a `runVerbosity='silent'`. La dashboard
 *     live SSE continua a funzionare in tempo reale.
 *
 * Pure: il service espone solo helper deterministici. L'usage corrente
 * va misurato dal chiamante via fs.statSync (passato come parametro).
 *
 * @module services/storage-quota
 */

import { loadConfig } from '@/config.js';

export interface PlanQuotas {
  /** Codice piano (es. 'free', 'starter', 'pro'). */
  planCode: string;
  /** Totale disco assegnato al tenant, in bytes. */
  totalBytes: number;
  /** Quota dedicata a workflow data (config + allegati + DB ops correnti). */
  workflowDataBytes: number;
  /** Quota dedicata a runs log retention (steps_json + archivi). */
  logRetentionBytes: number;
  /** True quando il piano è Free → niente persistenza runs. */
  freeTier: boolean;
}

/** Ratio applicato a tutti i piani paid (Free è eccezione 100/0). */
const PAID_TIER_RATIO_LOG = 0.3;
const PAID_TIER_RATIO_DATA = 1 - PAID_TIER_RATIO_LOG;

const GIB_TO_BYTES = 1024 * 1024 * 1024;

/**
 * Calcola le quote split per un dato piano. Pure function — nessun side
 * effect, deterministico, testabile in isolamento.
 */
export function computeQuotas(planCode: string, diskGb: number): PlanQuotas {
  const totalBytes = Math.max(0, diskGb) * GIB_TO_BYTES;
  const isFree = planCode === 'free';
  if (isFree) {
    return {
      planCode,
      totalBytes,
      workflowDataBytes: totalBytes,
      logRetentionBytes: 0,
      freeTier: true,
    };
  }
  return {
    planCode,
    totalBytes,
    workflowDataBytes: Math.floor(totalBytes * PAID_TIER_RATIO_DATA),
    logRetentionBytes: Math.floor(totalBytes * PAID_TIER_RATIO_LOG),
    freeTier: false,
  };
}

/**
 * Legge planCode + diskGb dal config corrente e ritorna le quote effettive.
 * Wrapper sopra `computeQuotas` per i consumer runtime che non vogliono
 * conoscere i dettagli di config.
 */
export function getCurrentQuotas(): PlanQuotas {
  const cfg = loadConfig();
  return computeQuotas(cfg.MEDEA_PLAN_CODE, cfg.MEDEA_PLAN_DISK_GB);
}

/**
 * Workflow tier-gating: determina se il tenant può persistere runs
 * (qualunque verbosity != silent). Free → false; altri → true.
 *
 * Wire point: `workflow.service.create/update` controlla questo prima di
 * accettare `runVerbosity='summary'` o `'full'`. Se Free e l'utente
 * tenta di settare summary/full, la modifica viene rifiutata con 403.
 */
export function canPersistRunTrace(planCode: string): boolean {
  return planCode !== 'free';
}

/** Costante shared per uso da quality gate, tests, UI tooltips. */
export const STORAGE_QUOTA_RATIOS = {
  paidTierData: PAID_TIER_RATIO_DATA,
  paidTierLog: PAID_TIER_RATIO_LOG,
  freeData: 1,
  freeLog: 0,
} as const;
