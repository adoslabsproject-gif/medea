/**
 * License management service.
 *
 * Stores license tokens in the DB (one active per tenant). Verifies them
 * offline with the bundled Ed25519 public key from `FLOWFORGE_LICENSE_PUBLIC_KEY`
 * or `FLOWFORGE_LICENSE_PUBLIC_KEY_PATH`. If no key is configured, the runtime
 * is unlocked in *dev* mode and locked-to-trial in production.
 *
 * Public API:
 *   - get(tenantId)   → current license + status (valid/expired/none)
 *   - install(token)  → verify + persist
 *   - remove(tenantId) → drop
 *
 * Enforcement points (caller's responsibility for now):
 *   - seat count   → check user count vs license.seats on register
 *   - feature gate → check license.features.includes(...) before exposing
 */

import { readFileSync, existsSync } from 'node:fs';
import { validateLicense, type LicensePayload } from '@flowforge/license';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

export interface LicenseStatus {
  configured: boolean;
  hasLicense: boolean;
  valid: boolean;
  tier: 'free' | 'starter' | 'business' | 'enterprise' | 'unlicensed';
  reason?: string;
  payload?: LicensePayload;
  publicKeyConfigured: boolean;
  inDevMode: boolean;
}

interface LicenseRow {
  tenant_id: string;
  token: string;
  installed_at: string;
}

function ensureLicenseTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS flowforge_license (
      tenant_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      installed_at TEXT NOT NULL
    );
  `);
}

// esbuild --define replaces this at build time with the bundled public key.
// At source time (typechecking), it's a regular global the runtime resolves
// to undefined → falls back to env vars (dev mode).
declare const __FLOWFORGE_BUNDLED_LICENSE_PUBKEY__: string | undefined;

function loadPublicKey(): string | null {
  if (process.env.FLOWFORGE_LICENSE_PUBLIC_KEY) {
    return process.env.FLOWFORGE_LICENSE_PUBLIC_KEY;
  }
  const path = process.env.FLOWFORGE_LICENSE_PUBLIC_KEY_PATH;
  if (path && existsSync(path)) {
    return readFileSync(path, 'utf8');
  }
  // Build-time embedded public key (set by esbuild --define).
  try {
    const bundled = typeof __FLOWFORGE_BUNDLED_LICENSE_PUBKEY__ !== 'undefined' ? __FLOWFORGE_BUNDLED_LICENSE_PUBKEY__ : '';
    if (bundled && bundled.length > 0) return bundled;
  } catch {
    /* not defined */
  }
  return null;
}

const cachedPublicKey = loadPublicKey();

export class LicenseService {
  constructor() {
    ensureLicenseTable();
  }

  async getStatus(tenantId = 'default'): Promise<LicenseStatus> {
    const publicKey = cachedPublicKey;
    const inDevMode = (process.env.NODE_ENV ?? 'development') !== 'production';

    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM flowforge_license WHERE tenant_id = ?')
      .get(tenantId) as LicenseRow | undefined;

    if (!row) {
      return {
        configured: Boolean(publicKey),
        hasLicense: false,
        valid: inDevMode, // dev mode is implicitly valid
        tier: 'unlicensed',
        publicKeyConfigured: Boolean(publicKey),
        inDevMode,
        reason: inDevMode ? 'Dev mode (no production gating)' : 'No license installed',
      };
    }

    if (!publicKey) {
      return {
        configured: false,
        hasLicense: true,
        valid: inDevMode,
        tier: 'unlicensed',
        publicKeyConfigured: false,
        inDevMode,
        reason: 'No public key configured — cannot verify',
      };
    }

    const result = await validateLicense(row.token, publicKey);
    const base: LicenseStatus = {
      configured: true,
      hasLicense: true,
      valid: result.valid || inDevMode,
      tier: result.payload?.tier ?? 'unlicensed',
      publicKeyConfigured: true,
      inDevMode,
    };
    if (result.reason !== undefined) base.reason = result.reason;
    if (result.payload !== undefined) base.payload = result.payload;
    return base;
  }

  async install(tenantId: string, token: string): Promise<LicenseStatus> {
    const publicKey = cachedPublicKey;
    if (!publicKey) {
      throw new Error('FLOWFORGE_LICENSE_PUBLIC_KEY non configurato sul runtime — impossibile verificare la licenza.');
    }
    const verification = await validateLicense(token, publicKey);
    if (!verification.valid) {
      throw new Error(`Licenza non valida: ${verification.reason ?? 'unknown'}`);
    }
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'INSERT INTO flowforge_license (tenant_id, token, installed_at) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET token = excluded.token, installed_at = excluded.installed_at',
      )
      .run(tenantId, token, now);
    logger.info({ tenantId, tier: verification.payload?.tier }, 'License installed');
    return this.getStatus(tenantId);
  }

  remove(tenantId: string): boolean {
    const { sqlite } = getDatabase();
    const info = sqlite.prepare('DELETE FROM flowforge_license WHERE tenant_id = ?').run(tenantId);
    return info.changes > 0;
  }

  /**
   * Convenience for callers that need to gate features at runtime.
   * Returns true if the tenant has a license with the given feature OR
   * we're in dev mode.
   */
  async hasFeature(tenantId: string, feature: string): Promise<boolean> {
    const status = await this.getStatus(tenantId);
    if (status.inDevMode) return true;
    if (!status.valid) return false;
    return status.payload?.features.includes(feature) ?? false;
  }
}
