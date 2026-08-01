import { describe, it, expect } from 'vitest';
import { evaluateLockAcquire, isLockAlive, LOCK_TTL_MS, type LockState } from './workflow-lock.logic.js';

const now = 1_000_000;
const marco: LockState = { userId: 'u-marco', userName: 'Marco', heartbeatAt: now };

describe('evaluateLockAcquire', () => {
  it('nessun lock → ok (free)', () => {
    expect(evaluateLockAcquire(null, 'u-ada', now)).toEqual({ ok: true, reason: 'free' });
  });

  it('lock dello stesso utente → ok (reacquired)', () => {
    expect(evaluateLockAcquire(marco, 'u-marco', now)).toEqual({ ok: true, reason: 'reacquired' });
  });

  it('lock di altro utente ancora vivo → rifiutato (held) con chi lo detiene', () => {
    const d = evaluateLockAcquire(marco, 'u-ada', now + 1000);
    expect(d.ok).toBe(false);
    expect(d).toMatchObject({ reason: 'held', by: { userId: 'u-marco', userName: 'Marco' } });
  });

  it('lock di altro utente SCADUTO (no heartbeat oltre TTL) → takeover', () => {
    const d = evaluateLockAcquire(marco, 'u-ada', now + LOCK_TTL_MS + 1);
    expect(d).toEqual({ ok: true, reason: 'takeover_expired' });
  });

  it('al limite esatto del TTL il lock è ancora vivo (held)', () => {
    const d = evaluateLockAcquire(marco, 'u-ada', now + LOCK_TTL_MS);
    expect(d.ok).toBe(false);
  });
});

describe('isLockAlive', () => {
  it('null → non vivo', () => { expect(isLockAlive(null, now)).toBe(false); });
  it('heartbeat recente → vivo', () => { expect(isLockAlive(marco, now + 1000)).toBe(true); });
  it('heartbeat vecchio → non vivo', () => { expect(isLockAlive(marco, now + LOCK_TTL_MS + 1)).toBe(false); });
});
