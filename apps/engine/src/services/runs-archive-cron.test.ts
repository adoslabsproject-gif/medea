/**
 * Test 2026-grade — runs-archive-cron (weekly archive + jitter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';

const archiveAllMock = vi.fn();
vi.mock('./runs-archive.service.js', () => ({
  archiveAllWorkflows: archiveAllMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
  delete process.env.FLOWFORGE_RUNS_ARCHIVE_DAYS;
  archiveAllMock.mockResolvedValue({ workflowsScanned: 0, workflowsArchived: 0, totalRows: 0, totalBytes: 0 });
});

afterEach(() => { vi.useRealTimers(); });

async function load() { return import('./runs-archive-cron.js'); }

describe('🚨 lifecycle', () => {
  it('🚨 start: log info "started"', async () => {
    const m = await load();
    m.startRunsArchiveCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30 }),
      'runs-archive-cron started',
    );
    m.stopRunsArchiveCron();
  });

  it('🚨 idempotent start (2x → no duplicate)', async () => {
    const m = await load();
    m.startRunsArchiveCron();
    loggerMock.info.mockClear();
    m.startRunsArchiveCron();
    expect(loggerMock.info).not.toHaveBeenCalled();
    m.stopRunsArchiveCron();
  });

  it('🚨 stop senza start → no-op', async () => {
    const m = await load();
    expect(() => m.stopRunsArchiveCron()).not.toThrow();
  });
});

describe('🚨 retentionDays env override', () => {
  it('🚨 env "60" → 60gg', async () => {
    process.env.FLOWFORGE_RUNS_ARCHIVE_DAYS = '60';
    const m = await load();
    m.startRunsArchiveCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 60 }),
      expect.any(String),
    );
    m.stopRunsArchiveCron();
  });

  it('🚨 env invalido → default 30', async () => {
    process.env.FLOWFORGE_RUNS_ARCHIVE_DAYS = 'not-number';
    const m = await load();
    m.startRunsArchiveCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30 }),
      expect.any(String),
    );
    m.stopRunsArchiveCron();
  });

  it('🚨 env negativo → default 30', async () => {
    process.env.FLOWFORGE_RUNS_ARCHIVE_DAYS = '-7';
    const m = await load();
    m.startRunsArchiveCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30 }),
      expect.any(String),
    );
    m.stopRunsArchiveCron();
  });
});

describe('🚨 tick execution', () => {
  it('🚨 prima firing ~10min ± jitter 5min', async () => {
    const m = await load();
    m.startRunsArchiveCron();
    // jitter casuale: firstFire tra 5 min e 15 min — verifico che PRIMA di 4min non spara
    vi.advanceTimersByTime(4 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    expect(archiveAllMock).not.toHaveBeenCalled();
    // dopo 16 min sicuramente sparato
    vi.advanceTimersByTime(12 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    expect(archiveAllMock).toHaveBeenCalled();
    m.stopRunsArchiveCron();
  });

  it('🚨 archive non-zero → log info batch completed', async () => {
    archiveAllMock.mockResolvedValueOnce({
      workflowsScanned: 5, workflowsArchived: 3, totalRows: 1000, totalBytes: 5000,
    });
    const m = await load();
    m.startRunsArchiveCron();
    vi.advanceTimersByTime(20 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ workflowsArchived: 3, retentionDays: 30 }),
      '[runs-archive-cron] batch completed',
    );
    m.stopRunsArchiveCron();
  });

  it('🚨 archive zero → NO log info "completed"', async () => {
    const m = await load();
    m.startRunsArchiveCron();
    vi.advanceTimersByTime(20 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    const completedCalls = loggerMock.info.mock.calls.filter((c) => c[1] === '[runs-archive-cron] batch completed');
    expect(completedCalls.length).toBe(0);
    m.stopRunsArchiveCron();
  });

  it('🚨 archive throw → warn log + continua', async () => {
    archiveAllMock.mockRejectedValueOnce(new Error('disk full'));
    const m = await load();
    m.startRunsArchiveCron();
    vi.advanceTimersByTime(20 * 60_000);
    await Promise.resolve(); await Promise.resolve();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[runs-archive-cron] cycle failed',
    );
    m.stopRunsArchiveCron();
  });
});
