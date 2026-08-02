/**
 * Test composizione buildOutboxDispatchers — plumbing verso i servizi reali.
 * Copre: loadOnError mappa onError→webhook/email/nome; 🚨 webhook usa il safeFetch
 * iniettato (SSRF-safe, non internal-aware); fanout resolve per-wf → tenant catch-all.
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

import {
  buildOutboxDispatchers,
  type OutboxWiringDeps,
  type WorkflowOnErrorView,
} from './wiring.js';
import type { ErrorOutboxRecord } from './repository.js';
import type { FanoutStartParams } from './dispatchers/fanout.dispatcher.js';

function rec(
  channel: ErrorOutboxRecord['channel'],
  over: Partial<ErrorOutboxRecord> = {},
): ErrorOutboxRecord {
  return {
    id: 'o',
    runId: 'r1',
    channel,
    workflowId: 'wf-1',
    tenantId: 't-1',
    errorNodeId: 'n',
    errorMessage: 'boom',
    errorHash: 'h',
    durationMs: 1,
    startedAt: 'T0',
    triggerType: 'manual',
    triggerInputJson: null,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 'T0',
    lastError: null,
    createdAt: 'T0',
    updatedAt: 'T0',
    ...over,
  };
}

function deps(over: Partial<OutboxWiringDeps> = {}): OutboxWiringDeps {
  const wf: WorkflowOnErrorView = {
    name: 'Sync',
    onError: { webhookUrl: 'https://hook.example.com/x', emailTo: 'ops@example.com' },
  };
  return {
    getWorkflow: async () => wf,
    getErrorWorkflowId: async () => null,
    getTenantErrorWorkflowId: () => null,
    checkRateLimit: () => true,
    startErrorHandler: vi.fn((_p: FanoutStartParams) => Promise.resolve()),
    safeFetch: vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, body: { cancel: () => Promise.resolve() } }),
    ),
    sendViaPortal: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('buildOutboxDispatchers', () => {
  it('espone i 3 canali', () => {
    const d = buildOutboxDispatchers(deps());
    expect(Object.keys(d).sort()).toEqual(['email', 'fanout', 'webhook']);
  });

  it('🚨 webhook: carica onError.webhookUrl e usa il safeFetch iniettato (SSRF-safe)', async () => {
    const safeFetch = vi.fn(
      (
        _url: string,
        _opts: { method: string; headers: Record<string, string>; body: string; timeoutMs: number },
      ) => Promise.resolve({ ok: true, status: 200, body: { cancel: () => Promise.resolve() } }),
    );
    const d = buildOutboxDispatchers(deps({ safeFetch }));
    await d.webhook(rec('webhook'));
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0]![0]).toBe('https://hook.example.com/x');
  });

  it('email: carica emailTo + workflowName e delega a sendViaPortal', async () => {
    const sendViaPortal = vi.fn((_p: { to: string; workflowName?: string | undefined }) =>
      Promise.resolve(),
    );
    const d = buildOutboxDispatchers(deps({ sendViaPortal }));
    await d.email(rec('email'));
    expect(sendViaPortal).toHaveBeenCalledTimes(1);
    expect(sendViaPortal.mock.calls[0]![0]).toMatchObject({
      to: 'ops@example.com',
      workflowName: 'Sync',
    });
  });

  it('workflow sparito (getWorkflow→null) → webhook/email no-op', async () => {
    const safeFetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, body: { cancel: () => Promise.resolve() } }),
    );
    const sendViaPortal = vi.fn(() => Promise.resolve());
    const d = buildOutboxDispatchers(
      deps({ getWorkflow: async () => null, safeFetch, sendViaPortal }),
    );
    await d.webhook(rec('webhook'));
    await d.email(rec('email'));
    expect(safeFetch).not.toHaveBeenCalled();
    expect(sendViaPortal).not.toHaveBeenCalled();
  });

  it('🚨 fanout: per-wf null → fallback al tenant catch-all, poi avvia', async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const d = buildOutboxDispatchers(
      deps({
        getErrorWorkflowId: async () => null,
        getTenantErrorWorkflowId: () => 'tenant-catch-all',
        startErrorHandler,
      }),
    );
    await d.fanout(rec('fanout'));
    expect(startErrorHandler).toHaveBeenCalledTimes(1);
    expect(startErrorHandler.mock.calls[0]![0]).toMatchObject({
      errorWorkflowId: 'tenant-catch-all',
      sourceWorkflowId: 'wf-1',
    });
  });

  it('fanout: per-wf presente ha priorità sul catch-all', async () => {
    const startErrorHandler = vi.fn((_p: FanoutStartParams) => Promise.resolve());
    const d = buildOutboxDispatchers(
      deps({
        getErrorWorkflowId: async () => 'per-wf-handler',
        getTenantErrorWorkflowId: () => 'tenant-catch-all',
        startErrorHandler,
      }),
    );
    await d.fanout(rec('fanout'));
    expect(startErrorHandler.mock.calls[0]![0]).toMatchObject({
      errorWorkflowId: 'per-wf-handler',
    });
  });
});
