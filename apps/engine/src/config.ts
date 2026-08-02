import { z } from 'zod';

/**
 * Coerce common truthy strings ("1", "true", "yes", "on") to boolean true.
 * Used by env-var booleans so admins can write any of those without surprises.
 */
const truthyString = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return false;
    const norm = v.toLowerCase().trim();
    return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
  });

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MEDEA_DB_PATH: z.string().default('./data/medea.sqlite'),
  MEDEA_DATA_DIR: z.string().default('./data'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * Disable the Liara (zeliai-hosted free-tier LLM) integration entirely.
   * Set to `true` for on-prem deployments without LLM gateway access.
   *
   * Default: false (Liara available as the primary LLM via portal gateway).
   */
  MEDEA_DISABLE_LIARA: truthyString,

  /**
   * Base URL of the Liara LLM gateway. In the zeliai cloud-hosted model,
   * every FlowForge container talks to the portal gateway, NOT directly to
   * Liara. The portal validates the license, applies tier rate-limit, and
   * forwards the request to the in-process Liara service on the same host.
   *
   *   container ─→ portal /api/v1/llm/chat/completions ─→ Liara :3003
   *
   * Default points at the Docker bridge gateway (172.17.0.1) which is the
   * host from inside any container. In dev, set to http://127.0.0.1:3006.
   */
  MEDEA_LIARA_BASE_URL: z.string().url().default('http://172.17.0.1:3006/api/v1/llm'),

  /**
   * URL portal zeliai (per webhook sender + heartbeat license).
   * Da dentro al container: http://172.17.0.1:3006 (Docker bridge gateway).
   * In dev locale: http://127.0.0.1:3006.
   */
  MEDEA_PORTAL_URL: z.string().url().default('http://172.17.0.1:3006'),

  /**
   * Workspace UUID — iniettato dal portal a provision-time.
   * Identifica univocamente questo container come tenant del portal.
   */
  MEDEA_TENANT_ID: z.string().uuid().optional(),

  /**
   * License key emessa dal portal (formato ZFL-XXXX-XXXX-XXXX-XXXX).
   * Usata per heartbeat + LLM gateway auth.
   */
  MEDEA_LICENSE_KEY: z.string().optional(),

  /**
   * Shared secret HS256 con portal per SSO bridge.
   * Stesso valore di config.MEDEA_SSO_SECRET nel portal.
   * Min 32 char. Setting obbligatorio in produzione.
   */
  MEDEA_SSO_SECRET: z.string().min(32).optional(),

  /**
   * Shared secret HMAC SHA-256 con portal per webhook events.
   * Stesso valore di SENTINEL_INTERNAL_SECRET nel portal.
   */
  MEDEA_WEBHOOK_SECRET: z.string().min(32).optional(),

  /**
   * GRACE WINDOW rotazione secret (vedi lib/webhook-token.ts): secret
   * PRECEDENTI (comma-separated, ognuno ≥32 char) i cui token webhook
   * derivati restano accettati durante una rotazione di MEDEA_SSO_SECRET.
   * Ogni accettazione via grace è loggata [SECURITY]. Da RIMUOVERE a
   * migrazione finita — non è un secondo canale permanente.
   */
  MEDEA_WEBHOOK_GRACE_SECRETS: z.string().optional(),

  /**
   * Public origin of this runtime, used by nodes that need to inject
   * absolute URLs into outgoing artifacts (emails, PDFs) whose recipients
   * have no way to discover the runtime URL on their own.
   *
   * Set by the portal at provision time to
   * `https://<slug>.app.automazionezeli.com`. May be left empty in
   * dev — nodes that REQUIRE it will fail with a clear message.
   */
  MEDEA_PUBLIC_BASE_URL: z.string().url().optional(),

  /**
   * 2026-06-07 sera (tier-aware logging F2). Plan code del workspace settato
   * da `onboarding.buildEnv` lato portal. Usato per gating:
   *   - 'free' → runVerbosity forzato a 'silent', niente persistenza runs
   *   - tier paid → free choice silent/summary/full
   * Default 'free' come fallback safe per ambiente dev senza portal.
   */
  MEDEA_PLAN_CODE: z.string().default('free'),
  /**
   * Disk quota totale del piano (GB) settato dal portal. Usato dal
   * `storage-quota.service` per calcolare la split 70/30 tra workflow data
   * e log retention.
   */
  MEDEA_PLAN_DISK_GB: z.coerce.number().int().positive().default(1),
  /**
   * Quota RAG vettoriale del piano (Increment 6) settata dal portal via buildEnv.
   * ASSENTE = illimitato (Enterprise/BYOK). Limite AGGREGATO su tutti i vector DB
   * del tenant — enforced al rag_ingest via vector-quota.checkVectorQuota.
   */
  MEDEA_PLAN_VECTOR_MAX_VECTORS: z.coerce.number().int().nonnegative().optional(),
  MEDEA_PLAN_VECTOR_MAX_DISK_MB: z.coerce.number().int().nonnegative().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = null;
}

/**
 * True when Liara is allowed as a fallback LLM provider on this instance.
 *
 * Reads from the cached `loadConfig()` so the env var is parsed ONCE at boot.
 * Tests that need to flip the value mid-run should call `resetConfigForTests()`
 * AFTER mutating `process.env.MEDEA_DISABLE_LIARA`.
 *
 * This is the global gate. Per-tenant override lives in
 * `TenantAiPreferencesService.allowLiara` — combined check via
 * `isLiaraAllowedForTenant(tenantId)`.
 */
export function isLiaraEnabled(): boolean {
  return !loadConfig().MEDEA_DISABLE_LIARA;
}

/**
 * Resolved Liara base URL (without trailing slash) — supports on-prem
 * self-hosted Qwen3+LoRA via `MEDEA_LIARA_BASE_URL` env. Default points
 * to the NHA-hosted service.
 */
export function liaraBaseUrl(): string {
  return loadConfig().MEDEA_LIARA_BASE_URL.replace(/\/$/, '');
}
