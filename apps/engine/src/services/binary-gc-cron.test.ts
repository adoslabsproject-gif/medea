/**
 * Test 2026-grade — binary-gc-cron (GC orario blob orfani + jitter).
 */
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';

const gcOnceMock = vi.fn();
vi.mock('./binary-gc.service.js', () => ({
  runBinaryGcOnce: gcOnceMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const NOTHING = {
  liveRefs: 0, deleted: 0, freedBytes: 0, skippedYoung: 0, tempDeleted: 0, tempFreedBytes: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
  gcOnceMock.mockResolvedValue(NOTHING);
});

afterEach(() => { vi.useRealTimers(); });

async function load() { return import('./binary-gc-cron.js'); }

describe('🚨 lifecycle', () => {
  it('🚨 start: log info "started"', async () => {
    const m = await load();
    m.startBinaryGcCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ firstFireMs: expect.any(Number) }),
      'binary-gc-cron started',
    );
    m.stopBinaryGcCron();
  });

  it('🚨 idempotent start (2x → niente timer duplicato)', async () => {
    const m = await load();
    m.startBinaryGcCron();
    loggerMock.info.mockClear();
    m.startBinaryGcCron();
    expect(loggerMock.info).not.toHaveBeenCalled();
    // dopo first-fire + 1h deve esserci AL PIÙ il numero di run di UN solo timer
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 60 * 60 * 1000);
    expect(gcOnceMock.mock.calls.length).toBeLessThanOrEqual(2);
    m.stopBinaryGcCron();
  });

  it('🚨 primo fire dentro la finestra jitter [10, 20) min — non prima, non dopo', async () => {
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1000);
    expect(gcOnceMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    expect(gcOnceMock).toHaveBeenCalledTimes(1);
    m.stopBinaryGcCron();
  });

  it('🚨 cadenza oraria dopo il primo fire', async () => {
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000); // first fire consumato
    const after = gcOnceMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(gcOnceMock.mock.calls.length).toBe(after + 1);
    m.stopBinaryGcCron();
  });

  it('🚨 stop PRIMA del first-fire cancella ANCHE il setTimeout (start→stop→start = 1 solo first-fire)', async () => {
    const m = await load();
    m.startBinaryGcCron();
    m.stopBinaryGcCron();
    // Il first-fire del PRIMO start non deve sopravvivere allo stop.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(gcOnceMock).not.toHaveBeenCalled();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(gcOnceMock).toHaveBeenCalledTimes(1);
    m.stopBinaryGcCron();
  });

  it('🚨 stop ferma il ciclo orario', async () => {
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    m.stopBinaryGcCron();
    const after = gcOnceMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(gcOnceMock.mock.calls.length).toBe(after);
  });
});

describe('🚨 wiring — il cron è davvero AVVIATO al boot (anti "esiste ma nessuno lo chiama")', () => {
  // Il residuo GAP 2 A#1 era ESATTAMENTE questo: gc()/sweepStaleTemp() esistevano
  // ma nessun cron li chiamava. Questo test impedisce che un merge perda il wiring.
  it('🚨 main.ts importa binary-gc-cron e chiama startBinaryGcCron()', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const mainSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'),
      'utf8',
    );
    expect(mainSrc).toContain("import('./services/binary-gc-cron.js')");
    expect(mainSrc).toContain('startBinaryGcCron()');
  });
});

describe('🚨 logging del ciclo', () => {
  it('deleted>0 → info con i contatori', async () => {
    gcOnceMock.mockResolvedValue({ ...NOTHING, deleted: 3, freedBytes: 999 });
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 3, freedBytes: 999 }),
      '[binary-gc-cron] blob orfani rimossi',
    );
    m.stopBinaryGcCron();
  });

  it('niente da rimuovere → solo debug', async () => {
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 0 }),
      '[binary-gc-cron] niente da rimuovere',
    );
    m.stopBinaryGcCron();
  });

  it('🚨 ciclo che fallisce → warn, il cron NON muore (riprova all\'ora dopo)', async () => {
    gcOnceMock.mockRejectedValueOnce(new Error('disk io'));
    const m = await load();
    m.startBinaryGcCron();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[binary-gc-cron] cycle failed',
    );
    gcOnceMock.mockResolvedValue(NOTHING);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(gcOnceMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    m.stopBinaryGcCron();
  });
});
