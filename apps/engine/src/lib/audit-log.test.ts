/**
 * audit-log — traccia accessi cross-tenant superadmin (fix 2026-06-15).
 * Bug-bounty: instradamento sul canale `audit` (prefisso), payload completo
 * (event + userId + action + scope + ip), messaggio leggibile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { warnSpy, loggerForSpy } = vi.hoisted(() => {
  const warnSpy = vi.fn();
  const loggerForSpy = vi.fn(() => ({ warn: warnSpy }));
  return { warnSpy, loggerForSpy };
});
vi.mock('./logger.js', () => ({ loggerFor: loggerForSpy }));

import { auditCrossTenantAccess } from './audit-log.js';

beforeEach(() => {
  warnSpy.mockReset();
});

describe('auditCrossTenantAccess', () => {
  it('instrada sul canale audit (loggerFor con prefisso "audit.")', () => {
    expect(loggerForSpy).toHaveBeenCalledWith(expect.stringMatching(/^audit\./));
  });

  it('emette payload completo + messaggio leggibile', () => {
    auditCrossTenantAccess({
      userId: 'u-1',
      email: 'admin@x.it',
      action: 'dashboard.stream',
      scope: 'all-tenants',
      ip: '1.2.3.4',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, msg] = warnSpy.mock.calls[0]!;
    expect(payload).toMatchObject({
      event: 'cross_tenant_access',
      userId: 'u-1',
      email: 'admin@x.it',
      action: 'dashboard.stream',
      scope: 'all-tenants',
      ip: '1.2.3.4',
    });
    expect(String(msg)).toContain('dashboard.stream');
    expect(String(msg)).toContain('all-tenants');
  });

  it('campi opzionali assenti → payload senza email/ip (no undefined spurio)', () => {
    auditCrossTenantAccess({ userId: 'u-2', action: 'dashboard.workflows', scope: 'all-tenants' });
    const [payload] = warnSpy.mock.calls[0]!;
    expect(payload).toMatchObject({
      event: 'cross_tenant_access',
      userId: 'u-2',
      action: 'dashboard.workflows',
    });
  });
});
