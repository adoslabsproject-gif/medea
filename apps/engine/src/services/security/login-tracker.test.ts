/**
 * Test 2026-grade — Login tracker (sliding window burst detection).
 *
 * THRESHOLD: 5 fail in 5min window → reportSecurityEvent.
 * SUPPRESSION: 30min window post-report (no spam alerts).
 * KEY: tenantId|email|ip (multi-dimension burst detection).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';

const reportSecurityEventMock = vi.fn();
vi.mock('./sentinel-reporter.js', () => ({
  reportSecurityEvent: reportSecurityEventMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z') });
  reportSecurityEventMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadFresh() {
  return import('./login-tracker.js');
}

describe('🚨 trackFailedLogin — burst threshold', () => {
  it('🚨 < 5 fail → no report', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '1.1.1.1' });
    }
    expect(reportSecurityEventMock).not.toHaveBeenCalled();
  });

  it('🚨 5 fail in 5min → report failed_login_burst', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '1.1.1.1' });
    }
    expect(reportSecurityEventMock).toHaveBeenCalledWith({
      eventType: 'failed_login_burst',
      severity: 'high',
      details: expect.objectContaining({
        email: 'a@b.com',
        attemptsInWindow: 5,
        windowMinutes: 5,
      }),
    });
  });

  it('🚨 6° fail entro 30min suppression → NO doppio report', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '1.1.1.1' });
    }
    reportSecurityEventMock.mockClear();
    trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '1.1.1.1' });
    expect(reportSecurityEventMock).not.toHaveBeenCalled();
  });

  it('🚨 dopo suppression 30min, burst di nuovo riportato', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't' });
    }
    reportSecurityEventMock.mockClear();
    vi.advanceTimersByTime(31 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't' });
    }
    expect(reportSecurityEventMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 fail oltre 5min window → sliding (counter reset implicit)', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't' });
    }
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 min — fuori window
    trackFailedLogin({ email: 'a@b.com', tenantId: 't' });
    expect(reportSecurityEventMock).not.toHaveBeenCalled();
  });
});

describe('🚨 key isolation (tenant|email|ip)', () => {
  it('🚨 same email diversi IP → counter separati', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '1.1.1.1' });
    }
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't', ipAddress: '2.2.2.2' });
    }
    expect(reportSecurityEventMock).not.toHaveBeenCalled(); // entrambi sotto soglia
  });

  it('🚨 ipAddress undefined → key "unknown"', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 't' });
    }
    expect(reportSecurityEventMock).toHaveBeenCalled();
  });

  it('🚨 different tenants → counter separati', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 'tenant-A' });
    }
    for (let i = 0; i < 4; i++) {
      trackFailedLogin({ email: 'a@b.com', tenantId: 'tenant-B' });
    }
    expect(reportSecurityEventMock).not.toHaveBeenCalled();
  });
});

describe('🚨 log warn su burst', () => {
  it('🚨 burst detect → log warn con key + count', async () => {
    const { trackFailedLogin } = await loadFresh();
    for (let i = 0; i < 5; i++) {
      trackFailedLogin({ email: 'b@x.com', tenantId: 't' });
    }
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 5 }),
      '[SECURITY] failed login burst detected',
    );
  });
});
