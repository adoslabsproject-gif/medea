/**
 * Test 2026-grade — LicenseService (Ed25519 offline license verify + tiers).
 *
 * 🚨 SECURITY: validateLicense Ed25519 → no install token NON-firmato.
 * 🚨 SECURITY: hasFeature gate features array → no by-pass plan tier.
 * 🚨 DEV MODE: NODE_ENV != production → valid=true sempre (no blocking dev).
 * 🚨 PROD MODE: senza license + senza public key → unlicensed/locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

const validateLicenseMock = vi.fn();
vi.mock('@flowforge/license', () => ({
  validateLicense: validateLicenseMock,
}));

let sqlite: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  sqlite = new Database(':memory:');
  delete process.env.FLOWFORGE_LICENSE_PUBLIC_KEY;
  delete process.env.FLOWFORGE_LICENSE_PUBLIC_KEY_PATH;
  delete process.env.NODE_ENV;
});

async function loadFresh() {
  return import('./license.service.js');
}

describe('🚨 ensureLicenseTable + constructor', () => {
  it('🚨 tabella creata idempotentemente', async () => {
    const { LicenseService } = await loadFresh();
    new LicenseService();
    new LicenseService(); // 2x → no throw
    const t = sqlite.prepare("SELECT name FROM sqlite_master WHERE name='flowforge_license'").all();
    expect(t.length).toBe(1);
  });
});

describe('🚨 getStatus — no license installed', () => {
  it('🚨 dev mode senza license → unlicensed MA valid=true', async () => {
    process.env.NODE_ENV = 'development';
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    const status = await svc.getStatus();
    expect(status.hasLicense).toBe(false);
    expect(status.tier).toBe('unlicensed');
    expect(status.valid).toBe(true); // dev passthrough
    expect(status.inDevMode).toBe(true);
    expect(status.reason).toMatch(/Dev mode/u);
  });

  it('🚨 production senza license → unlicensed + valid=false (block)', async () => {
    process.env.NODE_ENV = 'production';
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    const status = await svc.getStatus();
    expect(status.hasLicense).toBe(false);
    expect(status.valid).toBe(false);
    expect(status.inDevMode).toBe(false);
    expect(status.reason).toMatch(/No license installed/u);
  });

  it('🚨 configured riflette presenza public key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'ed25519-pubkey';
    const { LicenseService } = await loadFresh();
    const status = await new LicenseService().getStatus();
    expect(status.configured).toBe(true);
    expect(status.publicKeyConfigured).toBe(true);
  });
});

describe('🚨 getStatus — license installato', () => {
  it('🚨 production + license valid + tier business', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'pubkey';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'business', features: ['sso', 'audit'], seats: 50 },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'token-xyz', '2026-06-07')`);
    const status = await svc.getStatus();
    expect(status.valid).toBe(true);
    expect(status.tier).toBe('business');
    expect(status.payload?.features).toEqual(['sso', 'audit']);
  });

  it('🚨 production + license EXPIRED → valid=false + reason', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'pubkey';
    validateLicenseMock.mockResolvedValue({
      valid: false,
      reason: 'License expired 30 days ago',
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'token-expired', '2026-01-01')`);
    const status = await svc.getStatus();
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('License expired 30 days ago');
  });

  it('🚨 license invalido MA dev mode → valid=true (override)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'pubkey';
    validateLicenseMock.mockResolvedValue({ valid: false, reason: 'bad signature' });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'bad-token', '2026-01-01')`);
    const status = await svc.getStatus();
    expect(status.valid).toBe(true); // dev override
  });

  it('🚨 license installato MA no pubkey → unlicensed + reason', async () => {
    process.env.NODE_ENV = 'production';
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'token', 'now')`);
    const status = await svc.getStatus();
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/No public key configured/u);
  });

  it('🚨 multi-tenant: getStatus(A) vs getStatus(B) → row separati', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockImplementation(async (t: string) => ({
      valid: true,
      payload: { tier: t.includes('biz') ? 'business' : 'starter', features: [] },
    }));
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('tenA', 'biz-token', 'n')`);
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('tenB', 'starter-token', 'n')`);
    expect((await svc.getStatus('tenA')).tier).toBe('business');
    expect((await svc.getStatus('tenB')).tier).toBe('starter');
  });
});

describe('🚨 install — verify + upsert', () => {
  it('🚨 senza pubkey → throw esplicito (no silent install)', async () => {
    process.env.NODE_ENV = 'production';
    const { LicenseService } = await loadFresh();
    await expect(new LicenseService().install('default', 'token')).rejects.toThrow(/PUBLIC_KEY non configurato/u);
  });

  it('🚨 token verification failed → throw con reason', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValueOnce({ valid: false, reason: 'tampered signature' });
    const { LicenseService } = await loadFresh();
    await expect(new LicenseService().install('default', 'fake-token')).rejects.toThrow(/Licenza non valida.*tampered/u);
  });

  it('🚨 happy: insert + ritorna getStatus', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'starter', features: ['basic'], seats: 5 },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    const status = await svc.install('default', 'valid-token');
    expect(status.tier).toBe('starter');
    expect(status.valid).toBe(true);
    const row = sqlite.prepare('SELECT * FROM flowforge_license WHERE tenant_id=?').get('default') as any;
    expect(row.token).toBe('valid-token');
  });

  it('🚨 ON CONFLICT → overwrite token (rinnovo)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'business', features: [] },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    await svc.install('default', 'token-v1');
    await svc.install('default', 'token-v2');
    const rows = sqlite.prepare('SELECT * FROM flowforge_license WHERE tenant_id=?').all('default') as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].token).toBe('token-v2');
  });

  it('🚨 log info su successo', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'enterprise', features: [] },
    });
    const { LicenseService } = await loadFresh();
    await new LicenseService().install('t1', 'tok');
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', tier: 'enterprise' }),
      'License installed',
    );
  });
});

describe('🚨 remove', () => {
  it('🚨 row presente → true', async () => {
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('t1', 'tok', 'now')`);
    expect(svc.remove('t1')).toBe(true);
    expect(sqlite.prepare('SELECT * FROM flowforge_license WHERE tenant_id=?').get('t1')).toBeUndefined();
  });

  it('🚨 row assente → false', async () => {
    const { LicenseService } = await loadFresh();
    expect(new LicenseService().remove('missing')).toBe(false);
  });
});

describe('🚨 hasFeature — gating', () => {
  it('🚨 dev mode SEMPRE true (no blocking)', async () => {
    process.env.NODE_ENV = 'development';
    const { LicenseService } = await loadFresh();
    expect(await new LicenseService().hasFeature('default', 'any-feature')).toBe(true);
  });

  it('🚨 prod + no license → false', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    const { LicenseService } = await loadFresh();
    expect(await new LicenseService().hasFeature('default', 'sso')).toBe(false);
  });

  it('🚨 prod + license + feature presente → true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'business', features: ['sso', 'audit'] },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'tok', 'n')`);
    expect(await svc.hasFeature('default', 'sso')).toBe(true);
    expect(await svc.hasFeature('default', 'audit')).toBe(true);
  });

  it('🚨 prod + license MA feature mancante → false (no by-pass tier)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: true,
      payload: { tier: 'starter', features: ['basic'] },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'tok', 'n')`);
    expect(await svc.hasFeature('default', 'sso')).toBe(false);
  });

  it('🚨 prod + license EXPIRED → false anche se feature dichiarata', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'k';
    validateLicenseMock.mockResolvedValue({
      valid: false,
      reason: 'expired',
      payload: { tier: 'enterprise', features: ['sso'] },
    });
    const { LicenseService } = await loadFresh();
    const svc = new LicenseService();
    sqlite.exec(`INSERT INTO flowforge_license VALUES ('default', 'tok', 'n')`);
    expect(await svc.hasFeature('default', 'sso')).toBe(false);
  });
});

describe('🚨 loadPublicKey — precedence env > path > bundled', () => {
  it('🚨 env var precedence', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY = 'env-priority-key';
    const { LicenseService } = await loadFresh();
    const status = await new LicenseService().getStatus();
    expect(status.publicKeyConfigured).toBe(true);
  });

  it('🚨 path fallback se env mancante e file esiste', async () => {
    process.env.NODE_ENV = 'production';
    // Crea un file temp
    const tmpPath = '/tmp/ff-license-key-test.txt';
    writeFileSync(tmpPath, 'file-pubkey-content');
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY_PATH = tmpPath;
    const { LicenseService } = await loadFresh();
    const status = await new LicenseService().getStatus();
    expect(status.publicKeyConfigured).toBe(true);
  });

  it('🚨 path non esistente → null fallback', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOWFORGE_LICENSE_PUBLIC_KEY_PATH = '/nonexistent/path/key.pem';
    const { LicenseService } = await loadFresh();
    const status = await new LicenseService().getStatus();
    expect(status.publicKeyConfigured).toBe(false);
  });
});
