/**
 * Vector quota engine — limiti per piano sullo storage vettoriale del tenant.
 *
 * ⚠️ VINCOLO CHIAVE (reviewer): l'accounting è AGGREGATO PER-TENANT su TUTTI i suoi
 * vector DB, NON per-database. Col namespace per-databaseId un tenant aggirerebbe
 * il limite creando N database piccoli; aggregare somma i conteggi di tutti.
 *
 * Pure, deterministico, no I/O — l'accounting reale (enumerare i vector DB del
 * tenant e sommarne i conteggi) è iniettato dal chiamante.
 *
 * LIMITI NOTI ACCETTATI (quota = soft-limit di business, non confine di sicurezza):
 *  • TOCTOU: check-then-write senza lock → ingest concorrenti dello stesso tenant
 *    possono sforare di poco. Accettabile (container per-tenant, quota soft).
 *  • Fail-open: se un vector DB del tenant è irraggiungibile, l'accounting lo salta
 *    (sotto-stima) invece di bloccare → un ingest non viene negato per un'avaria DB.
 *  • Perf: l'accounting riconta tutti i vettori a ogni ingest (O(DB×collection)). OK
 *    alla scala per-tenant attuale; a scala servirebbe un contatore incrementale.
 */

export interface VectorPlanLimits {
  /** Max vettori TOTALI del tenant (somma di tutti i suoi vector DB). null = illimitato. */
  maxVectors: number | null;
  /** Max disco (MB) per lo storage vettoriale del tenant. null = illimitato. */
  maxDiskMb: number | null;
}

export interface TenantVectorUsage {
  /** Vettori totali del tenant AGGREGATI su tutti i suoi vector DB. */
  totalVectors: number;
  /** Disco stimato (MB) aggregato. */
  diskMb: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
  code?: 'VECTOR_COUNT_EXCEEDED' | 'VECTOR_DISK_EXCEEDED';
}

/** Somma i conteggi di vettori di TUTTI i vector DB del tenant (anti-bypass via N database). */
export function aggregateTenantVectors(perDatabaseCounts: readonly number[]): number {
  return perDatabaseCounts.reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
}

/** Stima MB occupati da N vettori a `dimensions` (float32 = 4 byte) + overhead ~30% (payload/index). */
export function estimateVectorDiskMb(vectorCount: number, dimensions: number): number {
  if (vectorCount <= 0 || dimensions <= 0) return 0;
  const rawBytes = vectorCount * dimensions * 4;
  return Math.ceil((rawBytes * 1.3) / (1024 * 1024));
}

/**
 * Decide se il tenant può aggiungere `addVectors` vettori (che occupano ~`addDiskMb`),
 * dato l'uso AGGREGATO corrente e i limiti del piano. NULL = illimitato (Enterprise/BYOK).
 *
 * Entrambi i check sono PROIETTIVI (uso attuale + delta richiesto > limite): così un
 * singolo batch grosso che sforerebbe count O disco viene bloccato PRIMA di scrivere.
 */
export function checkVectorQuota(
  usage: TenantVectorUsage,
  addVectors: number,
  addDiskMb: number,
  limits: VectorPlanLimits,
): QuotaDecision {
  const add = Math.max(0, addVectors);
  const addMb = Math.max(0, addDiskMb);

  if (limits.maxVectors !== null && usage.totalVectors + add > limits.maxVectors) {
    return {
      allowed: false,
      code: 'VECTOR_COUNT_EXCEEDED',
      reason:
        `Quota vettori del piano superata: ${usage.totalVectors} attuali + ${add} richiesti > ${limits.maxVectors} ` +
        `(limite AGGREGATO su tutti i tuoi vector DB). Fai upgrade del piano o libera spazio.`,
    };
  }

  if (limits.maxDiskMb !== null && usage.diskMb + addMb > limits.maxDiskMb) {
    return {
      allowed: false,
      code: 'VECTOR_DISK_EXCEEDED',
      reason:
        `Quota disco vettoriale del piano superata: ${usage.diskMb}MB attuali + ${addMb}MB richiesti > ` +
        `${limits.maxDiskMb}MB. Fai upgrade o libera spazio.`,
    };
  }

  return { allowed: true };
}
