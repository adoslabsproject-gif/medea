/**
 * Test 2026-grade — persistScaffoldCall helper.
 *
 * Coverage:
 *  - record() chiamato con SHAPE corretto (runId synthetic, workflowId,
 *    nodeId con iter index, defId='wizard_scaffold', provider, model, tokens)
 *  - record() chiamato con status='ok' su happy path
 *  - record() chiamato con status='error' + errorMessage su error path
 *  - record() OMETTE model se input.model === undefined (exactOptionalPropertyTypes)
 *  - record() OMETTE errorMessage se non passato
 *  - record() failure SWALLOWED (non-fatal, warn loggato)
 *  - tutti i fields tokens passano integri (input/output/latency)
 *
 * Strategia: vi.mock workflowCallTracker SOLO — niente DB reale. Verifica
 * via spy che la chiamata abbia tutti i campi richiesti dal dashboard
 * AiUsagePanel + dal byModel breakdown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';

// Mock workflowCallTracker PRIMA dell'import del SUT.
const mockRecord = vi.fn();
vi.mock('@/services/ai-budget/workflow-call-tracker.service.js', () => ({
  workflowCallTracker: { record: mockRecord },
}));

// Logger dal manual mock condiviso; il test verifica solo il warn non-fatale.
vi.mock('@/lib/logger.js');
const mockWarn = vi.mocked(logger).warn;

// Import SUT DOPO i vi.mock — Vitest hoist mocks, ma per chiarezza esplicita.
const { persistScaffoldCall } = await import('./persist-call.js');

describe('persistScaffoldCall — happy path success', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockWarn.mockReset();
  });

  it('chiama workflowCallTracker.record() esattamente 1 volta', () => {
    persistScaffoldCall({
      scaffoldRunId: 'scaffold-abc-123',
      iteration: 0,
      provider: 'liara',
      model: 'qwen3-32b-fp8',
      inputTokens: 1500,
      outputTokens: 800,
      latencyMs: 1200,
      status: 'ok',
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('passa runId synthetic intatto (cosi\\` ai_workflow_calls.run_id e\\` lo stesso per tutte le iter)', () => {
    persistScaffoldCall({
      scaffoldRunId: 'scaffold-deadbeef-uuid',
      iteration: 3,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 2000,
      outputTokens: 1100,
      latencyMs: 3400,
      status: 'ok',
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'scaffold-deadbeef-uuid',
      }),
    );
  });

  it('marca workflowId = "ai-wizard-scaffold" e defId = "wizard_scaffold" (filtri dashboard)', () => {
    persistScaffoldCall({
      scaffoldRunId: 'scaffold-xyz',
      iteration: 0,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 500,
      status: 'ok',
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'ai-wizard-scaffold',
        defId: 'wizard_scaffold',
      }),
    );
  });

  it('nodeId codifica iter index (iter-0, iter-1, ... — per drill-down Run Inspector)', () => {
    for (const iter of [0, 1, 5, 27]) {
      mockRecord.mockReset();
      persistScaffoldCall({
        scaffoldRunId: 'scaffold-x',
        iteration: iter,
        provider: 'liara',
        model: 'q',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: 'ok',
      });
      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: `iter-${iter.toString()}`,
        }),
      );
    }
  });

  it('passa provider/model/tokens/latency INTEGRI al tracker', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 7,
      provider: 'gemini',
      model: 'gemini-2.0-pro',
      inputTokens: 4567,
      outputTokens: 2345,
      latencyMs: 8900,
      status: 'ok',
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-2.0-pro',
        inputTokens: 4567,
        outputTokens: 2345,
        latencyMs: 8900,
        status: 'ok',
      }),
    );
  });

  it('happy path: NESSUN errorMessage nella call al tracker', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 0,
      provider: 'liara',
      model: 'q',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      status: 'ok',
    });
    const args = mockRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('errorMessage');
  });
});

describe('persistScaffoldCall — error path', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockWarn.mockReset();
  });

  it('status="error" propaga al tracker (cost dashboard mostra anche error calls)', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 2,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 0,
      latencyMs: 2000,
      status: 'error',
      errorMessage: 'Rate limited 429',
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'Rate limited 429',
      }),
    );
  });

  it('passa anche tokens parziali quando provider ha consumato prima del throw', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 2,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1234,
      outputTokens: 567,
      latencyMs: 8000,
      status: 'error',
      errorMessage: 'Stream timeout',
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 1234,
        outputTokens: 567,
      }),
    );
  });
});

describe('persistScaffoldCall — exactOptionalPropertyTypes safety', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockWarn.mockReset();
  });

  it('OMETTE field "model" se input.model === undefined (no field=undefined in payload)', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 0,
      provider: 'liara',
      model: undefined,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 500,
      status: 'ok',
    });
    const args = mockRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('model');
    expect(args).toHaveProperty('provider', 'liara');
  });

  it('INCLUDE field "model" se input.model è una stringa valida', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 0,
      provider: 'liara',
      model: 'qwen3-32b',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 500,
      status: 'ok',
    });
    const args = mockRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toHaveProperty('model', 'qwen3-32b');
  });

  it('OMETTE field "errorMessage" su status="ok"', () => {
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 0,
      provider: 'liara',
      model: 'q',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      status: 'ok',
    });
    const args = mockRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('errorMessage');
  });
});

describe('persistScaffoldCall — non-fatal failure swallowing', () => {
  beforeEach(() => {
    mockRecord.mockReset();
    mockWarn.mockReset();
  });

  it('NON throw se tracker.record() lancia (DB saturo, lock contention, etc.)', () => {
    mockRecord.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    // L'invocazione NON deve propagare l'errore al chiamante.
    expect(() => {
      persistScaffoldCall({
        scaffoldRunId: 'r',
        iteration: 0,
        provider: 'liara',
        model: 'q',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: 'ok',
      });
    }).not.toThrow();
  });

  it('logga warn quando tracker.record() fallisce (osservabilita\\` del bug silent)', () => {
    mockRecord.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    persistScaffoldCall({
      scaffoldRunId: 'scaffold-xyz',
      iteration: 2,
      provider: 'liara',
      model: 'q',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      status: 'error',
      errorMessage: 'orig error',
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [warnCtx, warnMsg] = mockWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnMsg).toMatch(/persistScaffoldCall failed/);
    expect(warnCtx).toMatchObject({
      err: 'boom',
      scaffoldRunId: 'scaffold-xyz',
      iteration: 2,
      status: 'error',
    });
  });

  it('logga il messaggio di errore raw se non e\\` instance of Error', () => {
    mockRecord.mockImplementationOnce(() => {
      throw 'string-thrown-not-error';
    });
    persistScaffoldCall({
      scaffoldRunId: 'r',
      iteration: 0,
      provider: 'liara',
      model: 'q',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      status: 'ok',
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [warnCtx] = mockWarn.mock.calls[0] as [Record<string, unknown>];
    expect(warnCtx).toMatchObject({ err: 'string-thrown-not-error' });
  });
});
