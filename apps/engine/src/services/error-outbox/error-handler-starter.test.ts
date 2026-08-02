/**
 * Test makeErrorHandlerStarter — triage opt-in fail-soft + startAsync contestualizzato.
 * Copre: triage OFF di default, triage ON solo se trigger_error.aiTriage==='true',
 * 🚨 triage fail-soft (explain throwa → handler parte comunque), nome sorgente
 * best-effort, parse triggerInput safe, 🚨 startAsync throwa → propaga (→ retry).
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

import { makeErrorHandlerStarter, type ErrorHandlerStarterDeps } from './error-handler-starter.js';
import type { FanoutStartParams } from './dispatchers/fanout.dispatcher.js';

type StartInput = Parameters<ErrorHandlerStarterDeps['startAsync']>[0];
const startSpy = (): ReturnType<typeof vi.fn<(i: StartInput) => Promise<void>>> =>
  vi.fn((_i: StartInput) => Promise.resolve());

function params(over: Partial<FanoutStartParams> = {}): FanoutStartParams {
  return {
    errorWorkflowId: 'wf-handler',
    sourceWorkflowId: 'wf-src',
    tenantId: 't-1',
    runId: 'r1',
    failedNodeId: 'n3',
    error: 'boom',
    triggerInputJson: '{"k":1}',
    ...over,
  };
}

function deps(over: Partial<ErrorHandlerStarterDeps> = {}): ErrorHandlerStarterDeps {
  return {
    getWorkflow: async (id) => ({ name: id === 'wf-src' ? 'Sorgente' : 'Handler', nodes: [] }),
    explainRun: async () => ({
      explanation: 'e',
      fix: 'f',
      root_cause: 'rc',
      risk: 'low',
      confidence: 0.9,
    }),
    startAsync: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('makeErrorHandlerStarter', () => {
  it('triage OFF di default → startAsync senza aiTriage, payload contestualizzato', async () => {
    const startAsync = startSpy();
    const explainRun = vi.fn(async () => ({ explanation: 'e', fix: 'f' }));
    await makeErrorHandlerStarter(deps({ startAsync, explainRun }))(params());
    expect(explainRun).not.toHaveBeenCalled();
    const input = startAsync.mock.calls[0]![0] as {
      workflowId: string;
      triggerType: string;
      triggerInput: Record<string, unknown>;
    };
    expect(input).toMatchObject({ workflowId: 'wf-handler', triggerType: 'error-handler' });
    expect(input.triggerInput).toMatchObject({
      failedNodeId: 'n3',
      error: 'boom',
      runId: 'r1',
      workflowId: 'wf-src',
      workflowName: 'Sorgente',
      attempt: 1,
      triggerInput: { k: 1 },
    });
    expect(input.triggerInput.aiTriage).toBeUndefined();
  });

  it("triage ON (trigger_error.aiTriage==='true') → arricchisce con aiTriage", async () => {
    const startAsync = startSpy();
    const handlerWithTriage = {
      name: 'H',
      nodes: [{ defId: 'trigger_error', config: { aiTriage: 'true' } }],
    };
    await makeErrorHandlerStarter(
      deps({
        getWorkflow: async (id) =>
          id === 'wf-handler' ? handlerWithTriage : { name: 'Sorgente', nodes: [] },
        startAsync,
      }),
    )(params());
    const ti = (startAsync.mock.calls[0]![0] as { triggerInput: Record<string, unknown> })
      .triggerInput;
    expect(ti.aiTriage).toMatchObject({
      explanation: 'e',
      fix: 'f',
      rootCause: 'rc',
      risk: 'low',
      confidence: 0.9,
    });
  });

  it("🚨 triage fail-soft: explainRun throwa → l'handler parte comunque senza aiTriage", async () => {
    const startAsync = startSpy();
    const handlerWithTriage = {
      name: 'H',
      nodes: [{ defId: 'trigger_error', config: { aiTriage: 'true' } }],
    };
    await makeErrorHandlerStarter(
      deps({
        getWorkflow: async (id) =>
          id === 'wf-handler' ? handlerWithTriage : { name: 'S', nodes: [] },
        explainRun: vi.fn(() => Promise.reject(new Error('LLM down'))),
        startAsync,
      }),
    )(params());
    expect(startAsync).toHaveBeenCalledTimes(1);
    expect(
      (startAsync.mock.calls[0]![0] as { triggerInput: Record<string, unknown> }).triggerInput
        .aiTriage,
    ).toBeUndefined();
  });

  it("nome sorgente best-effort: getWorkflow(source) throwa → fallback all'id, handler parte", async () => {
    const startAsync = startSpy();
    await makeErrorHandlerStarter(
      deps({
        getWorkflow: async (id) => {
          if (id === 'wf-src') throw new Error('gone');
          return { name: 'H', nodes: [] };
        },
        startAsync,
      }),
    )(params());
    expect(
      (startAsync.mock.calls[0]![0] as { triggerInput: Record<string, unknown> }).triggerInput
        .workflowName,
    ).toBe('wf-src');
  });

  it('triggerInputJson malformato → triggerInput null (no throw)', async () => {
    const startAsync = startSpy();
    await makeErrorHandlerStarter(deps({ startAsync }))(params({ triggerInputJson: '{bad json' }));
    expect(
      (startAsync.mock.calls[0]![0] as { triggerInput: Record<string, unknown> }).triggerInput
        .triggerInput,
    ).toBeNull();
  });

  it('🚨 startAsync throwa → propaga (→ retry/dead nel worker)', async () => {
    const starter = makeErrorHandlerStarter(
      deps({ startAsync: vi.fn(() => Promise.reject(new Error('start boom'))) }),
    );
    await expect(starter(params())).rejects.toThrow(/start boom/);
  });
});
