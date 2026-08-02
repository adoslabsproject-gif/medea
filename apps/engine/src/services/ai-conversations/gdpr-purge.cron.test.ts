/**
 * Test 2026-grade — AI Conversations GDPR purge cron (30gg retention).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';

const hardPurgeMock = vi.fn();
vi.mock('./conversation.service.js', () => ({
  conversationService: { hardPurgeExpired: hardPurgeMock },
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

// BYOK-14: il cron legge/scrive un marker file persistente (last_run). Mockiamo
// node:fs/promises così il test controlla lo stato del marker in modo deterministico
// (no I/O reale, niente dipendenza dal filesystem del runner).
const fsMock = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('node:fs/promises', () => fsMock);

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z') });
  hardPurgeMock.mockReturnValue(0);
  // default: nessun marker (mai eseguito) → catch-up immediato (+60s)
  fsMock.readFile.mockReset().mockRejectedValue(new Error('ENOENT'));
  fsMock.writeFile.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  return import('./gdpr-purge.cron.js');
}

describe('🚨 startGdprPurgeCron + stop', () => {
  it('🚨 start log info', async () => {
    const m = await load();
    m.startGdprPurgeCron();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        retentionDays: 30,
        intervalHours: 24,
        markerFile: expect.any(String),
      }),
      '[ai-conv.gdpr] cron started (BYOK-14 fix: persistent last_run marker)',
    );
    m.stopGdprPurgeCron();
  });

  it('🚨 start idempotent', async () => {
    const m = await load();
    m.startGdprPurgeCron();
    loggerMock.info.mockClear();
    m.startGdprPurgeCron();
    expect(loggerMock.info).not.toHaveBeenCalled();
    m.stopGdprPurgeCron();
  });

  it('🚨 stop senza start → no-op', async () => {
    const m = await load();
    expect(() => m.stopGdprPurgeCron()).not.toThrow();
  });
});

describe('🚨 runPurgeOnce', () => {
  it('🚨 cutoff = now - 30gg', async () => {
    const m = await load();
    const r = await m.runPurgeOnce();
    expect(r.cutoff).toMatch(/^2026-05-08/u); // 30gg prima di 2026-06-07
    expect(r.purged).toBe(0);
  });

  it('🚨 purged > 0 → log warn', async () => {
    hardPurgeMock.mockReturnValueOnce(15);
    const m = await load();
    await m.runPurgeOnce();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ purged: 15 }),
      '[ai-conv.gdpr] hard purge complete',
    );
  });

  it('🚨 purged = 0 → NO log warn', async () => {
    const m = await load();
    await m.runPurgeOnce();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('🚨 hardPurge throw → log error + rethrow', async () => {
    hardPurgeMock.mockImplementationOnce(() => {
      throw new Error('SQLite busy');
    });
    const m = await load();
    await expect(m.runPurgeOnce()).rejects.toThrow('SQLite busy');
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'SQLite busy' }),
      '[ai-conv.gdpr] purge failed',
    );
  });
});

describe('🚨 daily tick', () => {
  // NB: il catch-up (setTimeout 60s) è schedulato DENTRO loadLastRunMs().then(),
  // quindi è async → si usa advanceTimersByTimeAsync (flusha i microtask tra gli
  // step, così il timer schedulato dalla promise viene registrato e poi sparato).
  it('🚨 nessun marker → catch-up a 60s (post-restart)', async () => {
    const m = await load();
    m.startGdprPurgeCron();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(hardPurgeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); // > 60s → catch-up parte
    expect(hardPurgeMock).toHaveBeenCalled();
    m.stopGdprPurgeCron();
  });

  it('🚨 BYOK-14: marker recente (<24h) → NIENTE catch-up a 60s, schedula al gap', async () => {
    // last run 1h fa → elapsed < 24h → NON deve fare il catch-up immediato.
    fsMock.readFile.mockResolvedValueOnce(String(Date.parse('2026-06-07T09:00:00Z')));
    const m = await load();
    m.startGdprPurgeCron();
    await vi.advanceTimersByTimeAsync(61_000); // oltre la finestra di catch-up
    expect(hardPurgeMock).not.toHaveBeenCalled();
    // parte solo al completamento del gap (24h - 1h già trascorsa = 23h dopo)
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    expect(hardPurgeMock).toHaveBeenCalled();
    m.stopGdprPurgeCron();
  });

  it('🚨 ricorrenza daily (24h) via setInterval', async () => {
    const m = await load();
    m.startGdprPurgeCron();
    await vi.advanceTimersByTimeAsync(60_000); // catch-up startup
    expect(hardPurgeMock).toHaveBeenCalled();
    hardPurgeMock.mockClear();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(hardPurgeMock).toHaveBeenCalled();
    m.stopGdprPurgeCron();
  });

  it('🚨 catch-up scrive il marker last_run (persistenza BYOK-14)', async () => {
    const m = await load();
    m.startGdprPurgeCron();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fsMock.writeFile).toHaveBeenCalled();
    m.stopGdprPurgeCron();
  });
});
