/**
 * Config della coda di ammissione — SINGLE SOURCE per tutti i front-door
 * (i gateway davanti al modello). Tutti devono usare gli STESSI parametri
 * perché condividono la stessa coda Redis: due blocchi config separati
 * divergerebbero → coda incoerente. Da qui, una sola fonte (env-driven).
 *
 * @module admission/config
 */
export interface AdmissionConfig {
  enabled: boolean;
  /** Slot concorrenti per pool. vLLM = GPU-bound (scarso); external = provider-bound. */
  maxConcurrent: Record<string, number>;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  maxQueueDepth: number;
  maxPerTenantQueue: number;
  maxWaitMs: number;
}

type Env = Record<string, string | undefined>;

/** Intero da env con default; valori non-finiti o ≤0 → default (no NaN/0 silenziosi). */
function intEnv(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Carica la config dall'environment (variabili `MEDEA_ADMISSION_*`).
 */
export function loadAdmissionConfig(env: Env = process.env): AdmissionConfig {
  return {
    enabled: env.MEDEA_ADMISSION_QUEUE !== 'false',
    maxConcurrent: {
      vllm: intEnv(env, 'MEDEA_ADMISSION_MAX_VLLM', 4),
      external: intEnv(env, 'MEDEA_ADMISSION_MAX_EXTERNAL', 24),
    },
    leaseMs: intEnv(env, 'MEDEA_ADMISSION_LEASE_MS', 90_000),
    heartbeatMs: intEnv(env, 'MEDEA_ADMISSION_HEARTBEAT_MS', 20_000),
    pollMs: intEnv(env, 'MEDEA_ADMISSION_POLL_MS', 750),
    maxQueueDepth: intEnv(env, 'MEDEA_ADMISSION_MAX_QUEUE', 50),
    maxPerTenantQueue: intEnv(env, 'MEDEA_ADMISSION_MAX_PER_TENANT', 5),
    maxWaitMs: intEnv(env, 'MEDEA_ADMISSION_MAX_WAIT_MS', 120_000),
  };
}
