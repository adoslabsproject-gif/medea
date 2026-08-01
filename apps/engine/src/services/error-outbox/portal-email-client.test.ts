/**
 * Test portal-email-client (S2S runtime → portal). 🚨 BUG-BOUNTY #1: l'invio passa
 * SOLO per il portal (mai SMTP nel runtime); il portal manderà via 587. Verifica:
 * URL/token/scope corretti, throw su token mancante / non-2xx / errore rete (→ retry).
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const internalAwareFetch = vi.fn();
const getOutboundPortalToken = vi.fn<() => string | null>();

vi.mock('@/lib/internal-service-fetch.js', () => ({ internalAwareFetch }));
vi.mock('@/lib/internal-token.js', () => ({ getOutboundPortalToken }));

const { sendFailureEmailViaPortal } = await import('./portal-email-client.js');
import type { FailureEmailPayload } from './dispatchers/email.dispatcher.js';

function payload(over: Partial<FailureEmailPayload> = {}): FailureEmailPayload {
  return {
    to: 'ops@example.com', workflowId: 'wf-1', workflowName: 'Sync', runId: 'r1',
    tenantId: 't-1', errorNodeId: 'n3', errorMessage: 'boom', durationMs: 12,
    startedAt: '2026-06-19T10:00:00.000Z', ...over,
  };
}

beforeEach(() => {
  internalAwareFetch.mockReset();
  getOutboundPortalToken.mockReset();
  getOutboundPortalToken.mockReturnValue('secret-token');
});

describe('sendFailureEmailViaPortal', () => {
  it('🚨 POST al portal con token + scope portal; 2xx → resolve, body drenato', async () => {
    const cancel = vi.fn(async () => undefined);
    internalAwareFetch.mockResolvedValue({ ok: true, status: 200, body: { cancel } });
    await expect(sendFailureEmailViaPortal(payload())).resolves.toBeUndefined();
    expect(internalAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts, scope] = internalAwareFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string; timeoutMs: number }, { allow: string }];
    expect(url).toMatch(/\/api\/v1\/internal\/error-email\/send$/);
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-internal-token']).toBe('secret-token');
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(scope).toEqual({ allow: 'portal' });
    expect(JSON.parse(opts.body)).toMatchObject({ to: 'ops@example.com', runId: 'r1', tenantId: 't-1' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('token interno mancante → throw, NESSUN fetch (meglio retry che perdita silente)', async () => {
    getOutboundPortalToken.mockReturnValue(null);
    await expect(sendFailureEmailViaPortal(payload())).rejects.toThrow(/token missing/);
    expect(internalAwareFetch).not.toHaveBeenCalled();
  });

  it('🚨 portal non-2xx (502 = SMTP fallito) → throw (→ retry/dead nel worker)', async () => {
    internalAwareFetch.mockResolvedValue({ ok: false, status: 502, body: { cancel: async () => undefined } });
    await expect(sendFailureEmailViaPortal(payload())).rejects.toThrow(/HTTP 502/);
  });

  it('errore di rete → propaga (→ retry)', async () => {
    internalAwareFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendFailureEmailViaPortal(payload())).rejects.toThrow(/ECONNREFUSED/);
  });
});
