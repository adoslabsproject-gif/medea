/**
 * Config della coda di ammissione — SINGLE SOURCE per tutti i front-door
 * (gateway Liara + gateway portal). Entrambi devono usare gli STESSI parametri
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
 * Carica la config dall'environment. Le variabili usano il prefisso storico
 * `LIARA_ADMISSION_*` (la coda è nata nel gateway Liara) ma valgono per tutti.
 */
export function loadAdmissionConfig(env: Env = process.env): AdmissionConfig {
  return {
    enabled: env.LIARA_ADMISSION_QUEUE !== 'false',
    maxConcurrent: {
      vllm: intEnv(env, 'LIARA_ADMISSION_MAX_VLLM', 4),
      external: intEnv(env, 'LIARA_ADMISSION_MAX_EXTERNAL', 24),
    },
    leaseMs: intEnv(env, 'LIARA_ADMISSION_LEASE_MS', 90_000),
    heartbeatMs: intEnv(env, 'LIARA_ADMISSION_HEARTBEAT_MS', 20_000),
    pollMs: intEnv(env, 'LIARA_ADMISSION_POLL_MS', 750),
    maxQueueDepth: intEnv(env, 'LIARA_ADMISSION_MAX_QUEUE', 50),
    maxPerTenantQueue: intEnv(env, 'LIARA_ADMISSION_MAX_PER_TENANT', 5),
    maxWaitMs: intEnv(env, 'LIARA_ADMISSION_MAX_WAIT_MS', 120_000),
  };
}
