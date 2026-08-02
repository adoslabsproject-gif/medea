/**
 * superadmin-safety — test bug-bounty + anti-regressione (finding #6).
 *
 * Matrice: {role,enabled} × {self,other} × {last,not-last} × {removing,adding}.
 * Ogni "block" è un test che DEVE fallire se la policy viene rimossa/allentata.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateSuperadminSafety,
  assertSuperadminSafe,
  SuperadminSafetyError,
  countEnabledSuperadmins,
  type SuperadminSafetyInput,
} from './superadmin-safety.js';

const target = (over: Partial<SuperadminSafetyInput['target']> = {}) => ({
  id: 'u-target',
  role: 'superadmin',
  enabled: true,
  ...over,
});

describe('evaluateSuperadminSafety — ROLE change', () => {
  it('promozione a superadmin è sempre sicura', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'admin',
      target: target({ role: 'viewer' }),
      newRole: 'superadmin',
      activeSuperadminCount: 1,
    });
    expect(r.allowed).toBe(true);
  });

  it('🚨 self-demote → block self_target', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'u-target',
      target: target(),
      newRole: 'viewer',
      activeSuperadminCount: 3,
    });
    expect(r).toEqual({ allowed: false, reason: 'self_target' });
  });

  it('🚨 demote ULTIMO superadmin attivo (altro attore) → block last_superadmin', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'admin',
      target: target(),
      newRole: 'owner',
      activeSuperadminCount: 1,
    });
    expect(r).toEqual({ allowed: false, reason: 'last_superadmin' });
  });

  it('demote superadmin quando ne restano altri → consentito', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'admin',
      target: target(),
      newRole: 'owner',
      activeSuperadminCount: 2,
    });
    expect(r.allowed).toBe(true);
  });

  it('self ha precedenza su last (self-demote ultimo → self_target)', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'u-target',
      target: target(),
      newRole: 'owner',
      activeSuperadminCount: 1,
    });
    expect(r.reason).toBe('self_target');
  });

  it('cambio ruolo su NON-superadmin → non rimuovente → sicuro', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'admin',
      target: target({ role: 'viewer' }),
      newRole: 'owner',
      activeSuperadminCount: 1,
    });
    expect(r.allowed).toBe(true);
  });

  it('ruolo invariato (superadmin→superadmin) → non rimuovente', () => {
    const r = evaluateSuperadminSafety({
      kind: 'role',
      actorUserId: 'admin',
      target: target(),
      newRole: 'superadmin',
      activeSuperadminCount: 1,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('evaluateSuperadminSafety — ENABLED toggle', () => {
  it('abilitare è sempre sicuro', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'admin',
      target: target({ enabled: false }),
      newEnabled: true,
      activeSuperadminCount: 0,
    });
    expect(r.allowed).toBe(true);
  });

  it('🚨 self-disable → block self_target', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'u-target',
      target: target(),
      newEnabled: false,
      activeSuperadminCount: 5,
    });
    expect(r).toEqual({ allowed: false, reason: 'self_target' });
  });

  it('🚨 disable ULTIMO superadmin attivo → block last_superadmin', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'admin',
      target: target(),
      newEnabled: false,
      activeSuperadminCount: 1,
    });
    expect(r).toEqual({ allowed: false, reason: 'last_superadmin' });
  });

  it('disable superadmin già disabilitato → non rimuovente (non contribuisce)', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'admin',
      target: target({ enabled: false }),
      newEnabled: false,
      activeSuperadminCount: 1,
    });
    expect(r.allowed).toBe(true);
  });

  it('disable NON-superadmin → sicuro anche se count=0', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'admin',
      target: target({ role: 'owner' }),
      newEnabled: false,
      activeSuperadminCount: 0,
    });
    expect(r.allowed).toBe(true);
  });

  it('disable superadmin con altri attivi → consentito', () => {
    const r = evaluateSuperadminSafety({
      kind: 'enabled',
      actorUserId: 'admin',
      target: target(),
      newEnabled: false,
      activeSuperadminCount: 4,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('assertSuperadminSafe', () => {
  it('non lancia se consentito', () => {
    expect(() =>
      assertSuperadminSafe({
        kind: 'role',
        actorUserId: 'admin',
        target: target({ role: 'viewer' }),
        newRole: 'owner',
        activeSuperadminCount: 1,
      }),
    ).not.toThrow();
  });
  it('🚨 lancia SuperadminSafetyError con reason su self-demote', () => {
    try {
      assertSuperadminSafe({
        kind: 'role',
        actorUserId: 'u-target',
        target: target(),
        newRole: 'viewer',
        activeSuperadminCount: 3,
      });
      expect.unreachable('doveva lanciare');
    } catch (e) {
      expect(e).toBeInstanceOf(SuperadminSafetyError);
      expect((e as SuperadminSafetyError).reason).toBe('self_target');
      expect((e as SuperadminSafetyError).status).toBe(403);
    }
  });
});

describe('countEnabledSuperadmins', () => {
  it('legge COUNT(*) filtrato role+enabled', () => {
    let capturedSql = '';
    const fakeSqlite = {
      prepare: (sql: string) => {
        capturedSql = sql;
        return { get: () => ({ n: 3 }) };
      },
    };
    expect(countEnabledSuperadmins(fakeSqlite)).toBe(3);
    expect(capturedSql).toMatch(/role\s*=\s*'superadmin'/i);
    expect(capturedSql).toMatch(/enabled\s*=\s*1/i);
  });
  it('nessuna riga → 0', () => {
    const fakeSqlite = { prepare: () => ({ get: () => undefined }) };
    expect(countEnabledSuperadmins(fakeSqlite)).toBe(0);
  });
});
