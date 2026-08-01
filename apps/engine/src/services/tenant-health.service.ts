/**
 * Tenant Health — stato runtime-side REALE del container del tenant.
 *
 * Sostituisce la vecchia tab "Multi-tenant" (documentazione nginx X-Tenant-Id,
 * legacy del modello istanza-condivisa). Nel modello attuale (container Docker
 * isolato per tenant) ha senso mostrare la SALUTE del proprio container.
 *
 * Espone SOLO ciò che il runtime conosce con certezza (niente dato inventato,
 * niente proxy al portal): piano (env), uptime, conteggi (SQLite locale),
 * storage usato vs quota. La logica di aggregazione è pura/iniettata →
 * testabile senza toccare disco/DB.
 */

export interface TenantHealth {
  tenantId: string | null;
  plan: {
    code: string;
    diskGb: number;
    vectorMaxVectors: number | null;
    vectorMaxDiskMb: number | null;
  };
  uptimeSeconds: number;
  counts: { workflows: number; runs: number };
  storage: { usedBytes: number; totalBytes: number };
}

/** Dipendenze iniettate — la route fornisce gli adapter reali, i test fake. */
export interface TenantHealthDeps {
  tenantId: string | null;
  plan: TenantHealth['plan'];
  /** process.uptime() in secondi (può arrivare frazionario). */
  uptimeSeconds: number;
  countWorkflows: () => number;
  countRuns: () => number;
  storageUsedBytes: () => Promise<number>;
  storageTotalBytes: number;
}

export async function collectTenantHealth(deps: TenantHealthDeps): Promise<TenantHealth> {
  // storage fail-soft: una probe rotta non deve far fallire l'intero pannello.
  let usedBytes = 0;
  try {
    usedBytes = Math.max(0, await deps.storageUsedBytes());
  } catch {
    usedBytes = 0;
  }
  return {
    tenantId: deps.tenantId,
    plan: deps.plan,
    // uptime sempre intero non-negativo (process.uptime è frazionario).
    uptimeSeconds: Math.max(0, Math.floor(deps.uptimeSeconds)),
    counts: {
      workflows: Math.max(0, deps.countWorkflows()),
      runs: Math.max(0, deps.countRuns()),
    },
    storage: { usedBytes, totalBytes: Math.max(0, deps.storageTotalBytes) },
  };
}
