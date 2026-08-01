/**
 * Master password loader — Docker secrets file FIRST, env var fallback.
 *
 * Storia: pre-2026-05-30 leggevamo `process.env['FLOWFORGE_MASTER_PASSWORD']`
 * dappertutto. Problema: la variabile era visibile via `docker inspect <ctr>`,
 * `/proc/<pid>/environ` (chiunque nello stesso PID namespace), e a rischio
 * di leak in crash dump o logger non filtrati.
 *
 * Standard 2026 (hyperscaler-grade): la chiave master non vive in env. Viene
 * iniettata dal portal come **file bind-mount read-only** su path "Docker secrets
 * convention" (`/run/secrets/<name>`). Compatibile con tutte le orchestration:
 *   - plain Docker bind-mount
 *   - Docker Swarm secrets (compatibile by default)
 *   - Kubernetes Secret mounted as volume (`subPath`)
 *
 * Ordine di precedenza (high → low):
 *   1. File path da `FLOWFORGE_MASTER_PASSWORD_FILE` (override esplicito)
 *   2. File default `/run/secrets/flowforge_master_password`
 *   3. Env var `FLOWFORGE_MASTER_PASSWORD` (backward-compat container creati
 *      pre-migrazione 2026-05-30 — bootstrap zero-downtime).
 *   4. Dev sentinel (NODE_ENV=development o test) — mai in produzione.
 *
 * Cache: il risultato viene cachato a module-level (single read at boot).
 * Per test, usare `_resetMasterPasswordCacheForTest()`.
 */

import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_SECRET_PATH = '/run/secrets/flowforge_master_password';
const DEV_SENTINEL = 'flowforge-default-development-only-change-in-prod';

export type MasterPasswordSource = 'file' | 'env' | 'dev-sentinel';

export interface MasterPasswordResult {
  password: string;
  source: MasterPasswordSource;
  path?: string;
}

let cached: MasterPasswordResult | null = null;

function readSecretFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    // Docker / k8s tend to ship secrets with a trailing newline. Strip both
    // CRLF and LF, then trim spaces. NON tocchiamo whitespace interno: una
    // master password puo\` legittimamente contenere spazi.
    const raw = readFileSync(path, 'utf8');
    const cleaned = raw.replace(/\r?\n$/, '').replace(/^\uFEFF/, ''); // strip BOM if present
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

export function loadMasterPassword(): MasterPasswordResult {
  if (cached) return cached;

  // Priority 1: explicit file path override
  const explicitPath = process.env.FLOWFORGE_MASTER_PASSWORD_FILE;
  if (explicitPath && explicitPath.length > 0) {
    const content = readSecretFile(explicitPath);
    if (content) {
      cached = { password: content, source: 'file', path: explicitPath };
      return cached;
    }
  }

  // Priority 2: default Docker secrets path
  const defaultContent = readSecretFile(DEFAULT_SECRET_PATH);
  if (defaultContent) {
    cached = { password: defaultContent, source: 'file', path: DEFAULT_SECRET_PATH };
    return cached;
  }

  // Priority 3: env var (legacy / backward-compat)
  const envValue = process.env.FLOWFORGE_MASTER_PASSWORD;
  if (envValue && envValue.length > 0) {
    cached = { password: envValue, source: 'env' };
    return cached;
  }

  // Priority 4: dev sentinel (non in produzione)
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FLOWFORGE_MASTER_PASSWORD not found: neither file (/run/secrets/flowforge_master_password) nor env var set. Required in production.',
    );
  }
  cached = { password: DEV_SENTINEL, source: 'dev-sentinel' };
  return cached;
}

export function getMasterPasswordOrThrow(): string {
  return loadMasterPassword().password;
}

/** Returns true if the master password came from the secrets file (not env). */
export function isFromSecretsFile(): boolean {
  return loadMasterPassword().source === 'file';
}

/** TEST-ONLY: reset cache to force re-read on next call. */
export function _resetMasterPasswordCacheForTest(): void {
  cached = null;
}
