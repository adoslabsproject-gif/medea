/**
 * Test 2026-grade — log-quota-watcher (cron orario + anti-spam + auto-switch).
 *
 * RELIABILITY: anti-spam DAY_MS gap (warn/full email max 1/24h per stato).
 * AUTO-PROTECT: 100% triggers implicit silent on ALL workflows (data-loss prev).
 * FREE TIER: skip se quotas.freeTier o logRetentionBytes=0.
 */
import type * as FsNS from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';
import { at } from '@/__testkit__/assert.js';

const sendMailMock = vi.fn();
// _opts tipizzato: createTransport(opts) → mock.calls riflette l'arg reale.
const createTransportMock = vi.fn((_opts: unknown) => ({ sendMail: sendMailMock }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));

let sqliteInst: Database.Database;
const dbUpdateMock = vi.fn(() => ({
  set: () => ({
    where: () => Promise.resolve(),
  }),
}));
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: sqliteInst,
    db: { update: dbUpdateMock },
  }),
}));
vi.mock('@/storage/schema.js', () => ({
  workflows: { runVerbosity: 'run_verbosity' },
}));

const getCurrentQuotasMock = vi.fn();
vi.mock('@/services/storage-quota.service.js', () => ({
  getCurrentQuotas: getCurrentQuotasMock,
}));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({
    MEDEA_DATA_DIR: '/tmp/ff-watcher-test',
    MEDEA_PUBLIC_BASE_URL: 'https://test.example.com',
  }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

// Mock fs
let mockDirSize = 0;
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof FsNS>('node:fs');
  return {
    ...real,
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: mockDirSize, isDirectory: () => false, isFile: () => true })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z') });
  vi.resetModules();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`CREATE TABLE workflows (id TEXT PRIMARY KEY, run_verbosity TEXT);`);
  delete process.env.MEDEA_SMTP_HOST;
  delete process.env.MEDEA_SMTP_PORT;
  delete process.env.MEDEA_TENANT_OWNER_EMAIL;
  delete process.env.MEDEA_SMTP_FROM;
  mockDirSize = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadFresh() {
  return import('./log-quota-watcher.js');
}

describe('🚨 startLogQuotaWatcher — lifecycle', () => {
  it('🚨 start: log info "started"', async () => {
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    expect(loggerMock.info).toHaveBeenCalledWith('log-quota-watcher started');
    m.stopLogQuotaWatcher();
  });

  it('🚨 start 2x → idempotente (no doppio timer)', async () => {
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    loggerMock.info.mockClear();
    m.startLogQuotaWatcher();
    expect(loggerMock.info).not.toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });

  it('🚨 stop senza start → no-op', async () => {
    const m = await loadFresh();
    expect(() => m.stopLogQuotaWatcher()).not.toThrow();
  });
});

describe('🚨 tick — free tier early return', () => {
  beforeEach(() => {
    process.env.MEDEA_SMTP_HOST = 'smtp.test';
    process.env.MEDEA_SMTP_PORT = '587';
    process.env.MEDEA_TENANT_OWNER_EMAIL = 'owner@example.com';
  });

  it('🚨 freeTier true → skip + no email', async () => {
    getCurrentQuotasMock.mockReturnValueOnce({ freeTier: true, logRetentionBytes: 1024 });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 min → triggers first tick
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).not.toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });

  it('🚨 logRetentionBytes=0 → skip', async () => {
    getCurrentQuotasMock.mockReturnValueOnce({ freeTier: false, logRetentionBytes: 0 });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).not.toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });
});

describe('🚨 anti-spam DAY_MS gap', () => {
  beforeEach(() => {
    process.env.MEDEA_SMTP_HOST = 'smtp.test';
    process.env.MEDEA_SMTP_PORT = '587';
    process.env.MEDEA_TENANT_OWNER_EMAIL = 'owner@example.com';
  });

  it('🚨 warn email NON re-inviata in <24h', async () => {
    // mock 80% usage → email warn invocata
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1_000_000 });
    // mock measureLogUsage → 850k bytes (85%)
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 850_000, isDirectory: () => false, isFile: () => true });
    sendMailMock.mockResolvedValue({});
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000); // first tick
    await Promise.resolve(); await Promise.resolve();
    const firstCount = sendMailMock.mock.calls.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    // advance 1h (HOUR_MS) — anti-spam DAY_MS NON ancora scaduto
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock.mock.calls.length).toBe(firstCount); // no re-send
    m.stopLogQuotaWatcher();
  });
});

describe('🚨 SMTP env mancante', () => {
  it('🚨 no SMTP host → warn log NO send', async () => {
    process.env.MEDEA_TENANT_OWNER_EMAIL = 'owner@x.com';
    delete process.env.MEDEA_SMTP_HOST;
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 900, isDirectory: () => false, isFile: () => true });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('SMTP env not configured'),
    );
    m.stopLogQuotaWatcher();
  });

  it('🚨 no OWNER_EMAIL → warn log NO send', async () => {
    process.env.MEDEA_SMTP_HOST = 'smtp.test';
    process.env.MEDEA_SMTP_PORT = '587';
    delete process.env.MEDEA_TENANT_OWNER_EMAIL;
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 900, isDirectory: () => false, isFile: () => true });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('MEDEA_TENANT_OWNER_EMAIL not set'),
    );
    m.stopLogQuotaWatcher();
  });
});

describe('🚨 quota threshold + auto-switch ephemeral', () => {
  beforeEach(() => {
    process.env.MEDEA_SMTP_HOST = 'smtp.test';
    process.env.MEDEA_SMTP_PORT = '587';
    process.env.MEDEA_TENANT_OWNER_EMAIL = 'owner@example.com';
    sendMailMock.mockResolvedValue({});
  });

  it('🚨 100% → email full + forceEphemeralImplicit', async () => {
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 1200, isDirectory: () => false, isFile: () => true });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).toHaveBeenCalled();
    const call = at(sendMailMock.mock.calls, 0, 'sendMail-calls')[0];
    expect(call.subject).toMatch(/piena/u);
    // forceEphemeralImplicit → db.update invocato
    expect(dbUpdateMock).toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });

  it('🚨 80-99% → email warn (NO ephemeral switch)', async () => {
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 850, isDirectory: () => false, isFile: () => true });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).toHaveBeenCalled();
    const call = at(sendMailMock.mock.calls, 0, 'sendMail-calls')[0];
    expect(call.subject).toMatch(/85%|esaurimento|archivia/u);
    // NO ephemeral switch
    expect(dbUpdateMock).not.toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });

  it('🚨 <80% → nessuna email', async () => {
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 500, isDirectory: () => false, isFile: () => true });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendMailMock).not.toHaveBeenCalled();
    m.stopLogQuotaWatcher();
  });
});

describe('🚨 tick error resilience', () => {
  it('🚨 getCurrentQuotas throw → warn log MA NON crash watcher', async () => {
    getCurrentQuotasMock.mockImplementationOnce(() => { throw new Error('DB down'); });
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[log-quota-watcher] tick failed',
    );
    m.stopLogQuotaWatcher();
  });
});

describe('🚨 SMTP secure port handling', () => {
  it('🚨 port 465 → secure=true (SMTPS)', async () => {
    process.env.MEDEA_SMTP_HOST = 'smtp.test';
    process.env.MEDEA_SMTP_PORT = '465';
    process.env.MEDEA_TENANT_OWNER_EMAIL = 'x@y.com';
    getCurrentQuotasMock.mockReturnValue({ freeTier: false, logRetentionBytes: 1000 });
    const fsm = await import('node:fs');
    (fsm.readdirSync as any).mockReturnValue([{ name: 'a.gz', isDirectory: () => false, isFile: () => true }]);
    (fsm.statSync as any).mockReturnValue({ size: 850, isDirectory: () => false, isFile: () => true });
    sendMailMock.mockResolvedValue({});
    const m = await loadFresh();
    m.startLogQuotaWatcher();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    const transportOpts = at(createTransportMock.mock.calls, 0, 'createTransport-calls')[0] as { secure?: boolean };
    expect(transportOpts.secure).toBe(true);
    m.stopLogQuotaWatcher();
  });
});
