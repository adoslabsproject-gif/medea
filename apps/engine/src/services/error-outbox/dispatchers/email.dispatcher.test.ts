/**
 * Test email dispatcher — 🚨 BUG-BOUNTY #1: l'invio è DELEGATO al portal (587/STARTTLS),
 * MAI SMTP diretto dal runtime (niente porta 465 bloccata in egress).
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { makeEmailDispatcher, type EmailDispatcherDeps, type FailureEmailPayload } from './email.dispatcher.js';
import type { ErrorOutboxRecord } from '../repository.js';

function rec(over: Partial<ErrorOutboxRecord> = {}): ErrorOutboxRecord {
  return {
    id: 'o1', runId: 'r1', channel: 'email', workflowId: 'wf-1', tenantId: 't-1',
    errorNodeId: 'n', errorMessage: 'boom', errorHash: 'h', durationMs: 5,
    startedAt: '2026-06-19T10:00:00.000Z', triggerType: 'manual', triggerInputJson: null,
    status: 'pending', attempts: 0, nextAttemptAt: '2026-06-19T10:00:00.000Z',
    lastError: null, createdAt: '2026-06-19T10:00:00.000Z', updatedAt: '2026-06-19T10:00:00.000Z',
    ...over,
  };
}

function deps(over: Partial<EmailDispatcherDeps> = {}): EmailDispatcherDeps {
  return {
    loadOnError: async () => ({ emailTo: 'ops@example.com' }),
    sendViaPortal: vi.fn((_p: FailureEmailPayload) => Promise.resolve()),
    ...over,
  };
}

describe('email dispatcher', () => {
  it('🚨 BUG-BOUNTY #1: invio DELEGATO al portal (no SMTP diretto/465 nel runtime)', async () => {
    const sendViaPortal = vi.fn((_p: FailureEmailPayload) => Promise.resolve());
    const d = makeEmailDispatcher(deps({ sendViaPortal }));
    await expect(d(rec())).resolves.toBeUndefined();
    expect(sendViaPortal).toHaveBeenCalledTimes(1);
    expect(sendViaPortal.mock.calls[0]![0]).toMatchObject({ to: 'ops@example.com', runId: 'r1', workflowId: 'wf-1' });
  });

  it('sendViaPortal throwa → il dispatcher throwa (→ retry/dead nel worker)', async () => {
    const d = makeEmailDispatcher(deps({ sendViaPortal: vi.fn(() => Promise.reject(new Error('portal 503'))) }));
    await expect(d(rec())).rejects.toThrow(/portal 503/);
  });

  it('🚨 emailTo re-risolto via (workflow sparito) → no-op, NESSUN invio', async () => {
    const sendViaPortal = vi.fn((_p: FailureEmailPayload) => Promise.resolve());
    const d = makeEmailDispatcher(deps({ loadOnError: async () => null, sendViaPortal }));
    await d(rec());
    expect(sendViaPortal).not.toHaveBeenCalled();
  });

  it('onError senza emailTo → no-op', async () => {
    const sendViaPortal = vi.fn((_p: FailureEmailPayload) => Promise.resolve());
    const d = makeEmailDispatcher(deps({ loadOnError: async () => ({ emailTo: undefined }), sendViaPortal }));
    await d(rec());
    expect(sendViaPortal).not.toHaveBeenCalled();
  });
});
