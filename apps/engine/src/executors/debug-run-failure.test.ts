/**
 * Test debug-run-failure executor.
 *
 * Fase 2 (#14): il transport è `llmResolver` + `dispatchLLMChat` (gateway
 * metered) — il vecchio `LIARA_URL/v1/complete` diretto non esisteva più
 * (401 sempre → SEMPRE fallback euristico). I mock sono sul SERVICE.
 * Le asserzioni di dominio (failed-step detection, classifyError, maxFixes,
 * replayCommand, fallback euristico) sono INVARIATE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (_n: number) => mockSelect(),
          }),
        }),
      }),
    },
  }),
}));

vi.mock('@/storage/schema.js', () => ({
  runs: { id: 'id' },
}));

const m = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: (...a: unknown[]) => m.dispatch(...a),
}));
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: (...a: unknown[]) => m.resolve(...a) },
}));

import { debugRunFailureExecutor } from './debug-run-failure.js';

const ctx = { tenantId: 'tenant-test', runId: 'r1', nodeId: 'n1' } as never;

/** Il service ritorna direttamente il TESTO della risposta del modello. */
const llmText = (body: unknown): string => JSON.stringify(body);

beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockReturnValue({ provider: 'liara', apiKey: '', model: '' });
});

describe('debugRunFailureExecutor — validation', () => {
  it('rejecta runId vuoto', async () => {
    await expect(debugRunFailureExecutor({ runId: '' }, null, ctx)).rejects.toThrow(
      /runId obbligatorio/i,
    );
  });

  it('rejecta run inesistente', async () => {
    mockSelect.mockResolvedValue([]);
    await expect(debugRunFailureExecutor({ runId: 'run_404' }, null, ctx)).rejects.toThrow(
      /non trovato/i,
    );
  });
});

describe('debugRunFailureExecutor — diagnosis flow', () => {
  it('run senza step error → ritorna "nessun step fallito"', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'success',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'a', status: 'success', durationMs: 10 },
          { nodeId: 'b', status: 'success', durationMs: 20 },
        ]),
      },
    ]);
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as { diagnosis: { rootCause: string; category: string } };
    expect(out.diagnosis.category).toBe('none');
    expect(out.diagnosis.rootCause).toMatch(/nessun step fallito/i);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('run con error → LLM analyze + estrae fix/tests + _llm usage', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: '{"orderId":42}',
        stepsJson: JSON.stringify([
          {
            nodeId: 'http_call',
            defId: 'action_http',
            status: 'error',
            error: 'HTTP 503 Service Unavailable timeout after 30000ms',
            nodeConfig: { url: 'https://api.example.com' },
            input: '{"a":1}',
          },
        ]),
      },
    ]);
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as
        | ((u: { input: number; output: number; fromApi: boolean }) => void)
        | undefined;
      listener?.({ input: 250, output: 90, fromApi: true });
      return llmText({
        diagnosis: {
          rootCause: 'API esterna in timeout transiente',
          category: 'transient',
          confidence: 0.9,
        },
        suggestedFixes: [
          {
            type: 'retry',
            description: 'Aumenta retryCount=5 + backoff exponential 1s→30s',
            patch: { retryCount: 5 },
            confidence: 0.85,
          },
          {
            type: 'config',
            description: 'Aumenta timeout a 60000ms',
            patch: { timeoutMs: 60000 },
            confidence: 0.6,
          },
        ],
        suggestedTests: [
          {
            scenario: '503 + 200 → success after retry',
            expectation: 'output ok',
            mockData: { responses: [503, 200] },
          },
        ],
      });
    });
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as {
      diagnosis: { category: string; confidence: number };
      suggestedFixes: { type: string }[];
      replayCommand: { path: string };
      errorCategory: string;
      failedNodeId: string;
      _llm: Record<string, unknown>;
    };
    expect(out.diagnosis.category).toBe('transient');
    expect(out.suggestedFixes).toHaveLength(2);
    expect(out.suggestedFixes[0]?.type).toBe('retry');
    expect(out.replayCommand.path).toContain('http_call');
    expect(out.errorCategory).toBe('transient');
    expect(out.failedNodeId).toBe('http_call');
    // Fase 2 (#14): usage standard dalla chiamata AI
    expect(out._llm).toEqual({
      inputTokens: 250,
      outputTokens: 90,
      model: 'liara-default',
      provider: 'liara',
      fromApi: true,
    });
    expect(m.resolve).toHaveBeenCalledWith('tenant-test');
  });

  it('LLM unreachable → fallback heuristic diagnosis, output SENZA _llm (zero token)', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: 'null',
        stepsJson: JSON.stringify([
          {
            nodeId: 'send_email',
            defId: 'action_send_email',
            status: 'error',
            error: 'SMTP 401 Unauthorized — invalid credentials',
          },
        ]),
      },
    ]);
    m.dispatch.mockRejectedValue(new Error('gateway down'));
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as {
      diagnosis: { category: string; confidence: number };
      suggestedFixes: { type: string }[];
    };
    expect(out.diagnosis.category).toBe('auth'); // classifyError heuristic detects 401
    expect(out.diagnosis.confidence).toBeLessThan(0.5); // fallback low confidence
    expect(out.suggestedFixes.length).toBeGreaterThan(0);
    expect('_llm' in (r.output as Record<string, unknown>)).toBe(false);
  });

  it('nessun provider (resolver throw) → fallback euristico, no throw', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'x', defId: 'action_http', status: 'error', error: 'HTTP 503 timeout' },
        ]),
      },
    ]);
    m.resolve.mockImplementation(() => {
      throw new Error('nessun provider configurato');
    });
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as { diagnosis: { category: string }; suggestedFixes: unknown[] };
    expect(out.diagnosis.category).toBe('transient');
    expect(out.suggestedFixes.length).toBeGreaterThan(0);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('maxFixes limita output anche se il modello restituisce di più', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'x', defId: 'action_http', status: 'error', error: 'fail' },
        ]),
      },
    ]);
    m.dispatch.mockResolvedValue(
      llmText({
        diagnosis: { rootCause: 'r', category: 'runtime', confidence: 0.7 },
        suggestedFixes: Array.from({ length: 5 }, (_, i) => ({
          type: 'config',
          description: `fix ${String(i)}`,
          confidence: 0.5,
        })),
        suggestedTests: [],
      }),
    );
    const r = await debugRunFailureExecutor({ runId: 'r1', maxFixes: 2 }, null, ctx);
    const out = r.output as { suggestedFixes: unknown[] };
    expect(out.suggestedFixes).toHaveLength(2);
  });

  it('failedNodeId esplicito → analizza quel nodo specifico', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'partial',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'a', defId: 'logic_if', status: 'success' },
          { nodeId: 'b', defId: 'action_http', status: 'error', error: 'timeout' },
          { nodeId: 'c', defId: 'db_insert', status: 'error', error: 'fk violation' },
        ]),
      },
    ]);
    m.dispatch.mockResolvedValue(
      llmText({
        diagnosis: { rootCause: 'FK violation', category: 'runtime', confidence: 0.8 },
        suggestedFixes: [
          { type: 'guard', description: 'add validation upstream', confidence: 0.7 },
        ],
        suggestedTests: [],
      }),
    );
    const r = await debugRunFailureExecutor({ runId: 'r1', failedNodeId: 'c' }, null, ctx);
    const out = r.output as { failedNodeId: string; replayCommand: { path: string } };
    expect(out.failedNodeId).toBe('c');
    expect(out.replayCommand.path).toContain('fromNodeId=c');
  });

  it('🚨 diagnosi AI fallita DOPO la risposta (JSON invalido) → fallback MA _llm presente: i token sono stati spesi', async () => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'x', defId: 'action_http', status: 'error', error: 'fail' },
        ]),
      },
    ]);
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as
        | ((u: { input: number; output: number; fromApi: boolean }) => void)
        | undefined;
      listener?.({ input: 42, output: 7, fromApi: true });
      return 'non è json';
    });
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as { diagnosis: { confidence: number }; _llm: { inputTokens: number } };
    expect(out.diagnosis.confidence).toBeLessThan(0.5);
    expect(out._llm.inputTokens).toBe(42);
  });
});

describe('debugRunFailureExecutor — classifyError heuristic', () => {
  it.each([
    ['HTTP 503 timeout', 'transient'],
    ['ECONNRESET network failure', 'transient'],
    ['401 Unauthorized', 'auth'],
    ['Invalid token provided', 'auth'],
    ['HTTP 429 Too Many Requests', 'quota'],
    ['Rate limit exceeded', 'quota'],
    ['Validation error: missing required field email', 'payload'],
    ['HTTP 400 Bad Request invalid payload', 'payload'],
    ['Internal Server Error 500', 'runtime'],
    ['undefined is not a function', 'runtime'],
    ['something weird happened', 'unknown'],
  ])('errore "%s" → category %s', async (errMsg, expectedCat) => {
    mockSelect.mockResolvedValue([
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'error',
        input: 'null',
        stepsJson: JSON.stringify([
          { nodeId: 'x', defId: 'action_http', status: 'error', error: errMsg },
        ]),
      },
    ]);
    m.dispatch.mockRejectedValue(new Error('gateway down')); // force fallback path
    const r = await debugRunFailureExecutor({ runId: 'r1' }, null, ctx);
    const out = r.output as { errorCategory: string };
    expect(out.errorCategory).toBe(expectedCat);
  });
});
