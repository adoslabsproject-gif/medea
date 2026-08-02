/**
 * Test 2026-grade — Sentinel reporter (HMAC + fail-open).
 *
 * SECURITY: HMAC SHA-256 signature pre-flight (X-FF-Signature header).
 * RESILIENCE: fail-open su portal unreachable (no block container operations).
 * SKIP DEV: senza tenant/secret → return silenzioso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { createHmac } from 'node:crypto';
import { at } from '@/__testkit__/assert.js';

const configMock = {
  MEDEA_TENANT_ID: 't-1',
  MEDEA_PORTAL_URL: 'https://portal.example.com',
  MEDEA_WEBHOOK_SECRET: 'webhook-secret-key',
};
vi.mock('@/config.js', () => ({
  loadConfig: () => configMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

const { reportSecurityEvent } = await import('./sentinel-reporter.js');

beforeEach(() => {
  vi.clearAllMocks();
  configMock.MEDEA_TENANT_ID = 't-1';
  configMock.MEDEA_PORTAL_URL = 'https://portal.example.com';
  configMock.MEDEA_WEBHOOK_SECRET = 'webhook-secret-key';
});

describe('🚨 skip dev mode (no tenant/secret)', () => {
  it('🚨 no tenantId → return + debug log', async () => {
    configMock.MEDEA_TENANT_ID = '';
    await reportSecurityEvent({ eventType: 'failed_login_burst', severity: 'medium' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalled();
  });

  it('🚨 no secret → skip', async () => {
    configMock.MEDEA_WEBHOOK_SECRET = '';
    await reportSecurityEvent({ eventType: 'workflow_anomaly', severity: 'high' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('🚨 happy path — POST con HMAC', () => {
  it('🚨 body include eventType + workspaceId + occurredAt + severity + details', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await reportSecurityEvent({
      eventType: 'rate_limit_breach',
      severity: 'critical',
      details: { ip: '1.2.3.4', count: 100 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = at(fetchMock.mock.calls, 0, 'fetch-calls');
    expect(url).toBe('https://portal.example.com/api/v1/webhooks/flowforge');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.eventType).toBe('rate_limit_breach');
    expect(body.workspaceId).toBe('t-1');
    expect(body.severity).toBe('critical');
    expect(body.details).toEqual({ ip: '1.2.3.4', count: 100 });
    expect(body.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 HMAC SHA-256 corretto in header X-FF-Signature', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await reportSecurityEvent({ eventType: 'failed_login_burst', severity: 'low' });
    const opts = at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit;
    const sentBody = opts.body as string;
    const expected = createHmac('sha256', 'webhook-secret-key').update(sentBody, 'utf8').digest('hex');
    expect((opts.headers as Record<string, string>)['X-FF-Signature']).toBe(expected);
  });

  it('🚨 X-FF-Tenant header propagato', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: 'workflow_anomaly', severity: 'low' });
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-FF-Tenant']).toBe('t-1');
  });

  it('🚨 details default {} se non passato', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: 'unauthorized_access', severity: 'high' });
    const body = JSON.parse((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string);
    expect(body.details).toEqual({});
  });

  it('🚨 trailing slash URL portal normalizzato', async () => {
    configMock.MEDEA_PORTAL_URL = 'https://portal.example.com/';
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: 'failed_login_burst', severity: 'low' });
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toBe('https://portal.example.com/api/v1/webhooks/flowforge');
  });

  it('🚨 log info on success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: 'credentials_decrypt_fail', severity: 'high' });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'credentials_decrypt_fail' }),
      '[SENTINEL] event reported',
    );
  });
});

describe('🚨 fail-open behavior', () => {
  it('🚨 portal 500 → warn log MA NO throw', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(reportSecurityEvent({
      eventType: 'failed_login_burst', severity: 'critical',
    })).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      '[SENTINEL] portal returned non-2xx',
    );
  });

  it('🚨 fetch throw (network down) → warn + no rethrow', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(reportSecurityEvent({
      eventType: 'workflow_anomaly', severity: 'medium',
    })).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      '[SENTINEL] report failed (fail-open)',
    );
  });

  it('🚨 AbortController timeout 3000ms', async () => {
    // Simula long-running fetch
    fetchMock.mockImplementationOnce((_url, opts) => {
      return new Promise((_, reject) => {
        const signal = (opts as RequestInit).signal!;
        signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    });
    vi.useFakeTimers();
    const p = reportSecurityEvent({ eventType: 'rate_limit_breach', severity: 'high' });
    vi.advanceTimersByTime(3001);
    await p;
    expect(loggerMock.warn).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('🚨 SecurityEvent types coverage', () => {
  it.each([
    'failed_login_burst', 'workflow_anomaly', 'credentials_decrypt_fail',
    'rate_limit_breach', 'unauthorized_access',
  ])('🚨 eventType "%s" supportato', async (eventType) => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: eventType as any, severity: 'low' });
    const body = JSON.parse((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string);
    expect(body.eventType).toBe(eventType);
  });

  it.each(['low', 'medium', 'high', 'critical'])('🚨 severity "%s"', async (sev) => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await reportSecurityEvent({ eventType: 'failed_login_burst', severity: sev as any });
    const body = JSON.parse((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string);
    expect(body.severity).toBe(sev);
  });
});
