/**
 * Test 2026-grade — TestAccountService (E2E auto-provision).
 *
 * GATE: solo se MEDEA_E2E_AUTO_PROVISION='1'.
 * IDEMPOTENT: re-boot non duplica user.
 * SECRET: password file 0o600 OR env override.
 */
import type * as FsNS from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: sqliteInst }) }));

const hashPasswordMock = vi.fn(async (p: string) => `hashed:${p}`);
vi.mock('@medea/engine-auth-local', () => ({ hashPassword: hashPasswordMock }));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const fsState = { passwordFile: null as string | null };
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof FsNS>('node:fs');
  return {
    ...real,
    existsSync: vi.fn((p: string) => p.endsWith('.e2e-password') && fsState.passwordFile !== null),
    readFileSync: vi.fn((p: string) => {
      if (p.endsWith('.e2e-password')) return fsState.passwordFile;
      return real.readFileSync(p);
    }),
    writeFileSync: vi.fn((p: string, content: string) => {
      if (p.endsWith('.e2e-password')) fsState.passwordFile = String(content);
    }),
    mkdirSync: vi.fn(),
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
      display_name TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL,
      enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0
    );
  `);
  fsState.passwordFile = null;
  delete process.env.MEDEA_E2E_AUTO_PROVISION;
  delete process.env.MEDEA_E2E_EMAIL;
  delete process.env.MEDEA_E2E_PASSWORD;
  delete process.env.MEDEA_E2E_TENANT;
  delete process.env.MEDEA_E2E_PASSWORD_FILE;
});

async function load() { return import('./test-account.service.js'); }

describe('🚨 gate MEDEA_E2E_AUTO_PROVISION', () => {
  it('🚨 env != "1" → return early no insert', async () => {
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM users').get()).toEqual({ n: 0 });
  });

  it('🚨 env "0" → no provision', async () => {
    process.env.MEDEA_E2E_AUTO_PROVISION = '0';
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM users').get()).toEqual({ n: 0 });
  });
});

describe('🚨 provision happy', () => {
  beforeEach(() => {
    process.env.MEDEA_E2E_AUTO_PROVISION = '1';
    process.env.MEDEA_E2E_PASSWORD = 'fixed-password-for-test';
  });

  it('🚨 insert user con email default + is_system=1', async () => {
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    const row = sqliteInst.prepare('SELECT * FROM users').get() as any;
    expect(row.email).toBe('e2e@flowforge.local');
    expect(row.tenant_id).toBe('default');
    expect(row.is_system).toBe(1);
    expect(row.role).toBe('editor');
    expect(row.enabled).toBe(1);
    expect(row.password_hash).toBe('hashed:fixed-password-for-test');
  });

  it('🚨 email env override', async () => {
    process.env.MEDEA_E2E_EMAIL = 'custom@x.it';
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    const row = sqliteInst.prepare('SELECT email FROM users').get() as any;
    expect(row.email).toBe('custom@x.it');
  });

  it('🚨 tenantId env override', async () => {
    process.env.MEDEA_E2E_TENANT = 'custom-tenant';
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    const row = sqliteInst.prepare('SELECT tenant_id FROM users').get() as any;
    expect(row.tenant_id).toBe('custom-tenant');
  });

  it('🚨 hashPassword chiamato con plaintext', async () => {
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    expect(hashPasswordMock).toHaveBeenCalledWith('fixed-password-for-test');
  });
});

describe('🚨 idempotent', () => {
  beforeEach(() => {
    process.env.MEDEA_E2E_AUTO_PROVISION = '1';
    process.env.MEDEA_E2E_PASSWORD = 'pw';
  });

  it('🚨 user esistente → log info + skip insert', async () => {
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    await provisionTestAccount();
    const count = sqliteInst.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number };
    expect(count.n).toBe(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'e2e@flowforge.local' }),
      'E2E test account already exists',
    );
  });
});

describe('🚨 password file handling', () => {
  it('🚨 password file exists → reuse', async () => {
    process.env.MEDEA_E2E_AUTO_PROVISION = '1';
    fsState.passwordFile = 'existing-password-from-file';
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    expect(hashPasswordMock).toHaveBeenCalledWith('existing-password-from-file');
  });

  it('🚨 no env + no file → genera + scrive 0o600', async () => {
    process.env.MEDEA_E2E_AUTO_PROVISION = '1';
    const { provisionTestAccount } = await load();
    await provisionTestAccount();
    expect(fsState.passwordFile).toBeTruthy();
    expect(fsState.passwordFile!.length).toBeGreaterThanOrEqual(20);
    expect(hashPasswordMock).toHaveBeenCalledWith(fsState.passwordFile);
  });
});
