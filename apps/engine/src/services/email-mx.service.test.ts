/**
 * Test 2026-grade — Email MX validator (DNS + disposable + role + cache).
 *
 * 🚨 OUTBOUND: protegge reputation sender bloccando disposable + invalid MX.
 * 🚨 RFC 5321: A/AAAA fallback come implicit MX preference 0.
 * 🚨 PERF: LRU cache 5min × 5000 evita flood DNS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMxMock = vi.fn();
const resolve4Mock = vi.fn();
const resolve6Mock = vi.fn();

vi.mock('node:dns', () => ({
  promises: {
    resolveMx: resolveMxMock,
    resolve4: resolve4Mock,
    resolve6: resolve6Mock,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadFresh() {
  return import('./email-mx.service.js');
}

describe('🚨 syntax validation (RFC 5322 basic)', () => {
  it('🚨 stringa vuota → confidence 0 + syntax invalida', async () => {
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('');
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/syntax invalida/u);
    expect(resolveMxMock).not.toHaveBeenCalled();
  });

  it('🚨 senza @ → syntax invalida', async () => {
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('not-an-email');
    expect(r.confidence).toBe(0);
  });

  it('🚨 dominio TLD singolo (foo@bar) → syntax invalida', async () => {
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('foo@bar');
    expect(r.confidence).toBe(0);
  });

  it('🚨 trim + lowercase normalized', async () => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.example.com' }]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('  MARIO@EXAMPLE.COM  ');
    expect(r.email).toBe('mario@example.com');
    expect(r.domain).toBe('example.com');
  });
});

describe('🚨 MX valid happy paths', () => {
  it('🚨 person email + MX valid → confidence 100', async () => {
    resolveMxMock.mockResolvedValueOnce([
      { priority: 10, exchange: 'mx1.example.com' },
      { priority: 20, exchange: 'mx2.example.com' },
    ]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('mario.rossi@example.com');
    expect(r.confidence).toBe(100);
    expect(r.mx_valid).toBe(true);
    expect(r.mx_records).toHaveLength(2);
    expect(r.reason).toMatch(/fully deliverable/u);
  });

  it('🚨 MX records ordinati per priority ASC', async () => {
    resolveMxMock.mockResolvedValueOnce([
      { priority: 50, exchange: 'low.example.com' },
      { priority: 10, exchange: 'high.example.com' },
      { priority: 30, exchange: 'mid.example.com' },
    ]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('a@example.com');
    expect(r.mx_records.map((m) => m.priority)).toEqual([10, 30, 50]);
  });

  it('🚨 role-based (info@) + MX valid → confidence 85', async () => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.com' }]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('info@company.com');
    expect(r.confidence).toBe(85);
    expect(r.role_based).toBe(true);
  });

  it.each(['sales', 'admin', 'noreply', 'amministrazione', 'commerciale', 'no-reply'])(
    '🚨 role-based "%s@*" rilevato',
    async (role) => {
      resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.com' }]);
      const { validateEmailMx } = await loadFresh();
      const r = await validateEmailMx(`${role}@example.com`);
      expect(r.role_based).toBe(true);
    },
  );
});

describe('🚨 disposable domain protection', () => {
  it.each([
    'mailinator.com',
    'guerrillamail.com',
    '10minutemail.com',
    'yopmail.com',
    'tempmail.net',
    'throwaway.email',
  ])('🚨 dominio "%s" disposable → confidence 5', async (domain) => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.' + domain }]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx(`test@${domain}`);
    expect(r.disposable).toBe(true);
    expect(r.confidence).toBe(5);
    expect(r.reason).toMatch(/disposable/u);
  });

  it('🚨 disposable batte role-based (lowest wins)', async () => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'm' }]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('info@mailinator.com');
    expect(r.confidence).toBe(5); // NOT 85
    expect(r.disposable).toBe(true);
    expect(r.role_based).toBe(true);
  });
});

describe('🚨 RFC 5321 A/AAAA fallback', () => {
  it('🚨 no MX + A record → using_a_fallback=true, confidence 30', async () => {
    resolveMxMock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    resolve4Mock.mockResolvedValueOnce(['1.2.3.4']);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('user@oldserver.com');
    expect(r.mx_valid).toBe(true);
    expect(r.using_a_fallback).toBe(true);
    expect(r.confidence).toBe(30);
    expect(r.reason).toMatch(/RFC 5321 fallback/u);
  });

  it('🚨 no MX + no A + AAAA only → using_a_fallback=true', async () => {
    resolveMxMock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    resolve4Mock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    resolve6Mock.mockResolvedValueOnce(['::1']);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('user@ipv6only.com');
    expect(r.mx_valid).toBe(true);
    expect(r.using_a_fallback).toBe(true);
    expect(r.confidence).toBe(30);
  });

  it('🚨 no MX + no A + no AAAA → confidence 0 (undeliverable)', async () => {
    resolveMxMock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    resolve4Mock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    resolve6Mock.mockRejectedValueOnce(new Error('NXDOMAIN'));
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('user@deaddomain.com');
    expect(r.mx_valid).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/non deliverable/u);
  });
});

describe('🚨 cache behavior (LRU 5min × 5000)', () => {
  it('🚨 stesso domain 2x → 1 sola query DNS', async () => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.cached.com' }]);
    const { validateEmailMx } = await loadFresh();
    await validateEmailMx('a@cached.com');
    await validateEmailMx('b@cached.com');
    expect(resolveMxMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 domain diversi → query indipendenti', async () => {
    resolveMxMock
      .mockResolvedValueOnce([{ priority: 10, exchange: 'm1' }])
      .mockResolvedValueOnce([{ priority: 10, exchange: 'm2' }]);
    const { validateEmailMx } = await loadFresh();
    await validateEmailMx('a@one.com');
    await validateEmailMx('a@two.com');
    expect(resolveMxMock).toHaveBeenCalledTimes(2);
  });

  it('🚨 TTL expired → re-query', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z') });
    resolveMxMock
      .mockResolvedValueOnce([{ priority: 10, exchange: 'm1' }])
      .mockResolvedValueOnce([{ priority: 10, exchange: 'm2' }]);
    const { validateEmailMx } = await loadFresh();
    await validateEmailMx('a@expire-test.com');
    vi.advanceTimersByTime(6 * 60_000); // 6 min > 5 min TTL
    await validateEmailMx('b@expire-test.com');
    expect(resolveMxMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('🚨 DNS timeout', () => {
  it('🚨 resolveMx hang > timeout → cade su A fallback', async () => {
    resolveMxMock.mockReturnValueOnce(new Promise(() => { /* noop */ })); // never resolves
    resolve4Mock.mockResolvedValueOnce(['1.2.3.4']);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('a@slow.com', 50); // 50ms timeout
    // Timeout MX → fallback A → confidence 30
    expect(r.using_a_fallback).toBe(true);
    expect(r.confidence).toBe(30);
  });

  it('🚨 tutti DNS timeout → undeliverable', async () => {
    resolveMxMock.mockReturnValueOnce(new Promise(() => { /* noop */ }));
    resolve4Mock.mockReturnValueOnce(new Promise(() => { /* noop */ }));
    resolve6Mock.mockReturnValueOnce(new Promise(() => { /* noop */ }));
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('a@allslow.com', 30);
    expect(r.mx_valid).toBe(false);
    expect(r.confidence).toBe(0);
  });
});

describe('🚨 result shape consistency', () => {
  it('🚨 ogni field presente in output', async () => {
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: 'mx.com' }]);
    const { validateEmailMx } = await loadFresh();
    const r = await validateEmailMx('test@example.com');
    expect(r).toHaveProperty('email');
    expect(r).toHaveProperty('domain');
    expect(r).toHaveProperty('mx_valid');
    expect(r).toHaveProperty('mx_records');
    expect(r).toHaveProperty('using_a_fallback');
    expect(r).toHaveProperty('disposable');
    expect(r).toHaveProperty('role_based');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('reason');
  });

  it('🚨 confidence è sempre 0-100', async () => {
    const fixtures = [
      'invalid',
      'user@mailinator.com',
      'info@example.com',
      'mario@example.com',
    ];
    resolveMxMock.mockResolvedValue([{ priority: 10, exchange: 'mx' }]);
    const { validateEmailMx } = await loadFresh();
    for (const email of fixtures) {
      const r = await validateEmailMx(email);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
    }
  });
});
