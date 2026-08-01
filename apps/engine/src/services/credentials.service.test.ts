/**
 * Test 2026-grade — CredentialsService (vault envelope encryption).
 *
 * 🚨 SECURITY: plaintext mai persistito; ciphertext + nonce + authTag per AES-GCM.
 * 🚨 SECURITY: vault:* reference risolto contro Vault server (precedenza su decrypt locale).
 * 🚨 AUDIT: ogni create/delete emette audit log immutable.
 * 🚨 RBAC: tenantId isola le credenziali (no cross-tenant read/delete).
 */
import type * as FsNS from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';
import { at, first } from '@/__testkit__/assert.js';

const auditAppendMock = vi.fn();
class AuditLogServiceMock { append = auditAppendMock; }
vi.mock('./audit.service.js', () => ({ AuditLogService: AuditLogServiceMock }));

const vaultResolveMock = vi.fn();
class VaultSecretsServiceMock { resolve = vaultResolveMock; }
vi.mock('./vault-secrets.service.js', () => ({ VaultSecretsService: VaultSecretsServiceMock }));

let sqlite: Database.Database;
const getDatabaseMock = vi.fn(() => ({ sqlite }));
vi.mock('@/storage/db.js', () => ({ getDatabase: getDatabaseMock }));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({ FLOWFORGE_DATA_DIR: '/tmp/ff-creds-test-dir' }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

vi.mock('@/lib/master-password.ts', () => ({
  loadMasterPassword: () => ({ password: 'master-password-test-only', source: 'env' }),
}));
vi.mock('@/lib/master-password.js', () => ({
  loadMasterPassword: () => ({ password: 'master-password-test-only', source: 'env' }),
}));

// Mock node:fs operations to avoid writing to /tmp
const fsState = { keyFile: null as Buffer | null };
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof FsNS>('node:fs');
  return {
    ...real,
    existsSync: vi.fn((p: string) => {
      if (p.endsWith('master.key')) return fsState.keyFile !== null;
      return true; // dirs sempre esistenti
    }),
    readFileSync: vi.fn((p: string) => {
      if (p.endsWith('master.key') && fsState.keyFile) return fsState.keyFile;
      return real.readFileSync(p);
    }),
    writeFileSync: vi.fn((p: string, data: Buffer) => {
      if (p.endsWith('master.key')) fsState.keyFile = Buffer.from(data);
    }),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

// Mock @flowforge/secrets — fornisce KEK + encryptSecret/decryptSecret reali
// ma riproducibili (no randomness implicita per testing).
vi.mock('@flowforge/secrets', () => {
  const createVaultSalt = () => Buffer.alloc(32, 0x42);
  const deriveKek = (pwd: string, salt: Buffer) => {
    const k = Buffer.concat([Buffer.from(pwd), salt]).slice(0, 32);
    return k;
  };
  // Fake symmetric encrypt: prefix + b64(plaintext)
  const encryptSecret = (input: any, _master: any) => ({
    ciphertext: Buffer.from(input.plaintext).toString('base64'),
    nonce: 'nonce-fixed',
    authTag: 'authtag-fixed',
    dekCiphertext: 'dek-cipher',
    dekNonce: 'dek-nonce',
    dekAuthTag: 'dek-auth',
    metadata: input.metadata,
    createdAt: '2026-06-07T10:00:00Z',
    updatedAt: '2026-06-07T10:00:00Z',
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    provider: input.provider,
  });
  const decryptSecret = (enc: any, _master: any) => {
    return Buffer.from(enc.ciphertext, 'base64').toString('utf8');
  };
  return { createVaultSalt, deriveKek, encryptSecret, decryptSecret };
});

const { CredentialsService, ensureCredentialsTable, loadMaster } = await import('./credentials.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  fsState.keyFile = null;
  sqlite = new Database(':memory:');
  vaultResolveMock.mockResolvedValue(undefined);
});

describe('🚨 ensureCredentialsTable', () => {
  it('🚨 crea tabella + indici idempotente', () => {
    ensureCredentialsTable();
    ensureCredentialsTable(); // idempotente
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_credentials'").all() as any[];
    expect(tables.length).toBe(1);
    const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='user_credentials_provider_idx'").all();
    expect(idx.length).toBe(1);
  });

  it('🚨 UNIQUE (tenant_id, name) enforced', () => {
    new CredentialsService();
    sqlite.prepare(`INSERT INTO user_credentials (id, tenant_id, name, provider, ciphertext, nonce, auth_tag, dek_ciphertext, dek_nonce, dek_auth_tag, metadata_json, created_at, updated_at) VALUES ('a', 't1', 'cred-1', 'http', 'x', 'x', 'x', 'x', 'x', 'x', null, 'now', 'now')`).run();
    expect(() => sqlite.prepare(`INSERT INTO user_credentials (id, tenant_id, name, provider, ciphertext, nonce, auth_tag, dek_ciphertext, dek_nonce, dek_auth_tag, metadata_json, created_at, updated_at) VALUES ('b', 't1', 'cred-1', 'http', 'x', 'x', 'x', 'x', 'x', 'x', null, 'now', 'now')`).run()).toThrow(/UNIQUE/u);
  });
});

describe('🚨 loadMaster — vault KEK derivation', () => {
  it('🚨 prima chiamata: crea salt + scrive file 0o600', () => {
    new CredentialsService();
    expect(fsState.keyFile).toBeNull(); // before
    const m = loadMaster();
    expect(m.salt).toBeInstanceOf(Buffer);
    expect(fsState.keyFile).not.toBeNull();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('master.key') }),
      'Generated new vault master salt',
    );
  });

  it('🚨 cached: 2x chiamata stesso VaultMaster', () => {
    const a = loadMaster();
    const b = loadMaster();
    expect(a).toBe(b);
  });
});

describe('🚨 CredentialsService.create — envelope encryption + audit', () => {
  it('🚨 happy: plaintext encrypted + insert + audit append', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({
      name: 'gmail-account',
      provider: 'oauth',
      plaintext: 'super-secret-token-123',
      actorId: 'u-1',
    });
    expect(id).toBeTruthy();

    const row = sqlite.prepare('SELECT * FROM user_credentials WHERE id=?').get(id) as any;
    expect(row.tenant_id).toBe('default');
    expect(row.name).toBe('gmail-account');
    expect(row.provider).toBe('oauth');
    // 🚨 plaintext MAI persistito
    expect(row.ciphertext).not.toContain('super-secret-token-123');
    expect(row.ciphertext).toBe(Buffer.from('super-secret-token-123').toString('base64'));

    expect(auditAppendMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'default',
      action: 'credential.create',
      resourceType: 'credential',
      resourceId: id,
      actorId: 'u-1',
      metadata: { name: 'gmail-account', provider: 'oauth' },
    }));
  });

  it('🚨 metadata salvato come JSON serializzato', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({
      name: 'creds-meta', provider: 'api',
      plaintext: 'x', metadata: { scope: 'read', expires: '2027' },
    });
    const row = sqlite.prepare('SELECT metadata_json FROM user_credentials WHERE id=?').get(id) as any;
    expect(JSON.parse(row.metadata_json)).toEqual({ scope: 'read', expires: '2027' });
  });

  it('🚨 metadata undefined → metadata_json null (no "{}"" empty string)', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'no-meta', provider: 'http', plaintext: 'p' });
    const row = sqlite.prepare('SELECT metadata_json FROM user_credentials WHERE id=?').get(id) as any;
    expect(row.metadata_json).toBeNull();
  });

  it('🚨 tenantId esplicito segregato', async () => {
    const svc = new CredentialsService();
    await svc.create({ name: 'shared', provider: 'http', plaintext: 'a', tenantId: 'tenant-A' });
    await svc.create({ name: 'shared', provider: 'http', plaintext: 'b', tenantId: 'tenant-B' });
    // Stesso name, tenantId diversi → entrambi accettati
    const rows = sqlite.prepare('SELECT tenant_id FROM user_credentials WHERE name=?').all('shared') as any[];
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set(['tenant-A', 'tenant-B']));
  });

  it('🚨 actorId undefined → audit non include actorId', async () => {
    const svc = new CredentialsService();
    await svc.create({ name: 'no-actor', provider: 'http', plaintext: 'p' });
    const call = at(auditAppendMock.mock.calls, 0, 'audit-calls')[0];
    expect(call).not.toHaveProperty('actorId');
  });
});

describe('🚨 list — listing senza ciphertext', () => {
  it('🚨 happy: lista per tenant + escludi ciphertext field', async () => {
    const svc = new CredentialsService();
    await svc.create({ name: 'a', provider: 'http', plaintext: 'pa' });
    await svc.create({ name: 'b', provider: 'oauth', plaintext: 'pb' });
    const list = svc.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(expect.objectContaining({
      name: expect.any(String),
      provider: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    }));
    // 🚨 NON espone ciphertext, plaintext, nonce, authTag
    expect(list[0]).not.toHaveProperty('ciphertext');
    expect(list[0]).not.toHaveProperty('plaintext');
    expect(list[0]).not.toHaveProperty('nonce');
  });

  it('🚨 segregazione tenant: list(tenantA) NON vede tenantB', async () => {
    const svc = new CredentialsService();
    await svc.create({ name: 'a', provider: 'h', plaintext: 'x', tenantId: 'tenA' });
    await svc.create({ name: 'b', provider: 'h', plaintext: 'y', tenantId: 'tenB' });
    expect(svc.list('tenA')).toHaveLength(1);
    expect(svc.list('tenB')).toHaveLength(1);
    expect(first(svc.list('tenA'), 'creds').name).toBe('a');
  });
});

describe('🚨 reveal — decrypt locale', () => {
  it('🚨 happy: ritorna plaintext originale', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'r1', provider: 'http', plaintext: 'mysecret-XYZ' });
    expect(svc.reveal(id)).toBe('mysecret-XYZ');
  });

  it('🚨 wrong id → null (no throw)', () => {
    const svc = new CredentialsService();
    expect(svc.reveal('non-existent')).toBeNull();
  });

  it('🚨 wrong tenant → null (tenant isolation)', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'iso', provider: 'h', plaintext: 'secret', tenantId: 'A' });
    expect(svc.reveal(id, 'A')).toBe('secret');
    expect(svc.reveal(id, 'B')).toBeNull();
  });
});

describe('🚨 revealById — vault: reference precedence', () => {
  it('🚨 name "vault:*" → resolve via VaultSecretsService (NO decrypt locale)', async () => {
    vaultResolveMock.mockResolvedValueOnce('value-from-hashicorp-vault');
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'vault:kv/foo', provider: 'vault', plaintext: 'local-fallback-IGNORED' });
    const revealed = await svc.revealById(id);
    expect(revealed).toBe('value-from-hashicorp-vault');
    expect(vaultResolveMock).toHaveBeenCalledWith('vault:kv/foo');
  });

  it('🚨 vault.resolve returns undefined → fallback a decrypt locale', async () => {
    vaultResolveMock.mockResolvedValueOnce(undefined);
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'gmail-token', provider: 'oauth', plaintext: 'local-plaintext-OK' });
    const revealed = await svc.revealById(id);
    expect(revealed).toBe('local-plaintext-OK');
  });

  it('🚨 revealById not found → null (no vault call)', async () => {
    const svc = new CredentialsService();
    const out = await svc.revealById('nonexistent-id');
    expect(out).toBeNull();
    expect(vaultResolveMock).not.toHaveBeenCalled();
  });
});

describe('🚨 delete — atomic + audit', () => {
  it('🚨 happy: cancella row + audit append', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'del-me', provider: 'h', plaintext: 'x' });
    auditAppendMock.mockClear();
    const ok = await svc.delete(id, 'default', 'u-9');
    expect(ok).toBe(true);
    expect(sqlite.prepare('SELECT * FROM user_credentials WHERE id=?').get(id)).toBeUndefined();
    expect(auditAppendMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'credential.delete',
      resourceId: id,
      actorId: 'u-9',
    }));
  });

  it('🚨 delete id inesistente → false, NO audit', async () => {
    const svc = new CredentialsService();
    auditAppendMock.mockClear();
    const ok = await svc.delete('non-existent');
    expect(ok).toBe(false);
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('🚨 delete wrong tenant → false (no cross-tenant)', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'iso', provider: 'h', plaintext: 'x', tenantId: 'A' });
    const ok = await svc.delete(id, 'B');
    expect(ok).toBe(false);
    // Row ancora presente
    expect(sqlite.prepare('SELECT * FROM user_credentials WHERE id=?').get(id)).toBeTruthy();
  });

  it('🚨 actorId undefined → audit senza actorId', async () => {
    const svc = new CredentialsService();
    const { id } = await svc.create({ name: 'x', provider: 'h', plaintext: 'p' });
    auditAppendMock.mockClear();
    await svc.delete(id);
    const call = at(auditAppendMock.mock.calls, 0, 'audit-calls')[0];
    expect(call).not.toHaveProperty('actorId');
  });
});
