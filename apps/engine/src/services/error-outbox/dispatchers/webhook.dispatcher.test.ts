/**
 * Test webhook dispatcher — SSRF-safe, anti-OOM, durabilità.
 * 🚨 BUG-BOUNTY: usa il fetch SSRF-SAFE iniettato (mai raw fetch) + cancella il body.
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { makeWebhookDispatcher, type WebhookDispatcherDeps } from './webhook.dispatcher.js';
import type { ErrorOutboxRecord } from '../repository.js';

function rec(over: Partial<ErrorOutboxRecord> = {}): ErrorOutboxRecord {
  return {
    id: 'o1',
    runId: 'r1',
    channel: 'webhook',
    workflowId: 'wf-1',
    tenantId: 't-1',
    errorNodeId: 'n',
    errorMessage: 'boom',
    errorHash: 'h',
    durationMs: 5,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: null,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: '2026-06-19T10:00:00.000Z',
    lastError: null,
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T10:00:00.000Z',
    ...over,
  };
}

function deps(over: Partial<WebhookDispatcherDeps> = {}): WebhookDispatcherDeps {
  return {
    loadOnError: async () => ({ webhookUrl: 'https://hook.example.com/x' }),
    safeFetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { cancel: async () => undefined },
    })),
    ...over,
  };
}

describe('webhook dispatcher', () => {
  it('🚨 usa il fetch SSRF-safe iniettato + cancella il body (no OOM) su 2xx', async () => {
    const cancel = vi.fn(async () => undefined);
    const safeFetch = vi.fn(
      (
        _url: string,
        _opts: { method: string; headers: Record<string, string>; body: string; timeoutMs: number },
      ) => Promise.resolve({ ok: true, status: 200, body: { cancel } }),
    );
    const d = makeWebhookDispatcher(deps({ safeFetch }));
    await expect(d(rec())).resolves.toBeUndefined();
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0]![0]).toBe('https://hook.example.com/x');
    const opts = safeFetch.mock.calls[0]![1];
    expect(opts.method).toBe('POST');
    expect(opts.timeoutMs).toBeGreaterThan(0); // timeout SEMPRE (no hang)
    expect(JSON.parse(opts.body)).toMatchObject({ type: 'workflow.failed', runId: 'r1' });
    expect(cancel).toHaveBeenCalledTimes(1); // body cancellato, non letto
  });

  it('non-2xx (5xx) → throwa (→ retry/dead nel worker)', async () => {
    const d = makeWebhookDispatcher(
      deps({
        safeFetch: vi.fn(async () => ({
          ok: false,
          status: 503,
          body: { cancel: async () => undefined },
        })),
      }),
    );
    await expect(d(rec())).rejects.toThrow(/HTTP 503/);
  });

  it('🚨 webhook re-risolto via (workflow sparito / url rimosso) → no-op, NESSUN fetch', async () => {
    const safeFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const d = makeWebhookDispatcher(deps({ loadOnError: async () => null, safeFetch }));
    await expect(d(rec())).resolves.toBeUndefined();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('onError senza webhookUrl → no-op', async () => {
    const safeFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const d = makeWebhookDispatcher(
      deps({ loadOnError: async () => ({ webhookUrl: undefined }), safeFetch }),
    );
    await d(rec());
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('body senza .cancel (es. 204) → non throwa per il drain', async () => {
    const d = makeWebhookDispatcher(
      deps({ safeFetch: vi.fn(async () => ({ ok: true, status: 204, body: null })) }),
    );
    await expect(d(rec())).resolves.toBeUndefined();
  });
});
