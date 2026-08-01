/**
 * External Secrets backend — HashiCorp Vault KV v2.
 *
 * When env FLOWFORGE_VAULT_ADDR is set, credentials whose name has prefix
 * "vault:" are resolved at read time from Vault instead of the local
 * AES-GCM-encrypted store. The local store stays as the default; Vault is
 * additive, not a replacement (some users want Vault for shared secrets +
 * local for short-lived per-workflow tokens).
 *
 * Path convention: a credential named "vault:secret/data/myapp/db#password"
 *   - mount        : "secret"
 *   - secret path  : "myapp/db"
 *   - key in JSON  : "password"
 *
 * The "data/" between mount and path is the KV v2 wire format — we accept
 * names with OR without it for human convenience.
 */

import { logger } from '@/lib/logger.js';
import { readJsonCapped } from '@/lib/capped-response.js';

interface VaultKvV2Response {
  data?: { data?: Record<string, string> };
}

interface ParsedVaultPath {
  mount: string;
  path: string;
  key: string;
}

function parseVaultName(name: string): ParsedVaultPath | null {
  if (!name.startsWith('vault:')) return null;
  const rest = name.slice('vault:'.length);
  const hashIdx = rest.lastIndexOf('#');
  if (hashIdx < 0) return null;
  const fullPath = rest.slice(0, hashIdx).replace(/^\/+/u, '');
  const key = rest.slice(hashIdx + 1);
  const parts = fullPath.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const mount = parts[0]!;
  let pathParts = parts.slice(1);
  if (pathParts[0] === 'data') pathParts = pathParts.slice(1);
  if (pathParts.length === 0) return null;
  return { mount, path: pathParts.join('/'), key };
}

export class VaultSecretsService {
  private readonly addr: string;
  private readonly token: string;
  private readonly namespace: string | undefined;
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly cacheTtlMs: number;

  constructor() {
    this.addr = process.env.FLOWFORGE_VAULT_ADDR ?? '';
    this.token = process.env.FLOWFORGE_VAULT_TOKEN ?? '';
    this.namespace = process.env.FLOWFORGE_VAULT_NAMESPACE;
    this.cacheTtlMs = Number(process.env.FLOWFORGE_VAULT_CACHE_TTL_MS ?? '30000');
  }

  isConfigured(): boolean {
    return Boolean(this.addr && this.token);
  }

  /**
   * Returns `undefined` if the credential name is not a vault reference.
   * Returns `null` if it IS a vault reference but resolution failed (caller
   * should fall back to local store or surface an error).
   */
  async resolve(credentialName: string): Promise<string | undefined | null> {
    const parsed = parseVaultName(credentialName);
    if (!parsed) return undefined;
    if (!this.isConfigured()) {
      logger.warn(
        { credentialName },
        'Credential references Vault but FLOWFORGE_VAULT_ADDR/TOKEN are unset',
      );
      return null;
    }

    const cacheKey = `${parsed.mount}/${parsed.path}#${parsed.key}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;

    const url = `${this.addr.replace(/\/+$/u, '')}/v1/${parsed.mount}/data/${parsed.path}`;
    const headers: Record<string, string> = { 'X-Vault-Token': this.token };
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace;

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        logger.error({ status: res.status, url }, 'Vault KV read failed');
        return null;
      }
      const body = await readJsonCapped<VaultKvV2Response>(res);
      const value = body.data?.data?.[parsed.key];
      if (typeof value !== 'string') {
        logger.warn({ key: parsed.key, url }, 'Vault secret missing requested key');
        return null;
      }
      this.cache.set(cacheKey, { value, expiresAt: now + this.cacheTtlMs });
      return value;
    } catch (err) {
      logger.error({ err, url }, 'Vault fetch threw');
      return null;
    }
  }
}
