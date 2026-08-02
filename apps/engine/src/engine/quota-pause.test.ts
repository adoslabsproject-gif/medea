import { describe, it, expect } from 'vitest';
import {
  QUOTA_RESUME_SIGNAL_PREFIX,
  quotaResumeSignal,
  isQuotaResumeSignal,
  asQuotaPauseError,
  secondsUntilQuotaReset,
} from './quota-pause.js';

describe('quotaResumeSignal / isQuotaResumeSignal', () => {
  it('compone il signal per tenant', () => {
    expect(quotaResumeSignal('ws-1')).toBe('quota:renewed:ws-1');
    expect(quotaResumeSignal('ws-1').startsWith(QUOTA_RESUME_SIGNAL_PREFIX)).toBe(true);
  });
  it('riconosce un signal di quota vs wait_signal utente', () => {
    expect(isQuotaResumeSignal('quota:renewed:ws-1')).toBe(true);
    expect(isQuotaResumeSignal('order-approved')).toBe(false);
    expect(isQuotaResumeSignal('')).toBe(false);
  });
  it('difensiva: null/undefined → false (no crash su righe legacy)', () => {
    expect(isQuotaResumeSignal(null)).toBe(false);
    expect(isQuotaResumeSignal(undefined)).toBe(false);
  });
});

describe('asQuotaPauseError — type-guard strutturale (no import da services)', () => {
  it('riconosce LlmQuotaExceededError per forma + estrae periodEndIso', () => {
    const err = Object.assign(new Error('quota'), {
      name: 'LlmQuotaExceededError',
      periodEndIso: '2026-07-15',
      kind: 'token',
    });
    expect(asQuotaPauseError(err)).toEqual({
      name: 'LlmQuotaExceededError',
      periodEndIso: '2026-07-15',
    });
  });
  it('periodEndIso assente/non-stringa → null', () => {
    const err = Object.assign(new Error('quota'), { name: 'LlmQuotaExceededError' });
    expect(asQuotaPauseError(err)?.periodEndIso).toBeNull();
  });
  it('WRAPPATO: NodeError(INTERNAL_ERROR) con .cause = LlmQuotaExceededError → riconosciuto', () => {
    // withErrorMapping della stdlib avvolge ogni throw → NodeError preservando cause.
    const original = Object.assign(new Error('quota'), {
      name: 'LlmQuotaExceededError',
      periodEndIso: '2026-07-15',
    });
    const wrapped = Object.assign(new Error('Internal'), {
      name: 'NodeError',
      code: 'INTERNAL_ERROR',
      cause: original,
    });
    expect(asQuotaPauseError(wrapped)).toEqual({
      name: 'LlmQuotaExceededError',
      periodEndIso: '2026-07-15',
    });
  });
  it('altro errore (name diverso, cause non-quota) → null', () => {
    expect(asQuotaPauseError(new Error('boom'))).toBeNull();
    expect(
      asQuotaPauseError(Object.assign(new Error(), { name: 'NodeError', cause: new Error('db') })),
    ).toBeNull();
  });
  it('input non-oggetto → null (no crash)', () => {
    expect(asQuotaPauseError(null)).toBeNull();
    expect(asQuotaPauseError(undefined)).toBeNull();
    expect(asQuotaPauseError('string')).toBeNull();
    expect(asQuotaPauseError(42)).toBeNull();
  });
});

describe('secondsUntilQuotaReset', () => {
  const now = new Date('2026-06-20T12:00:00Z');
  it('periodEnd futuro → secondi fino alla mezzanotte UTC di quel giorno', () => {
    // 2026-07-15T00:00Z - 2026-06-20T12:00Z = 24g12h = 2_116_800s
    expect(secondsUntilQuotaReset('2026-07-15', now)).toBe(2_116_800);
  });
  it('periodEnd null → fallback 24h', () => {
    expect(secondsUntilQuotaReset(null, now)).toBe(24 * 60 * 60);
  });
  it('periodEnd malformato → fallback 24h', () => {
    expect(secondsUntilQuotaReset('non-data', now)).toBe(24 * 60 * 60);
  });
  it('periodEnd OGGI/passato → clamp a 60s (anti-loop resume immediato)', () => {
    expect(secondsUntilQuotaReset('2026-06-20', now)).toBe(60); // mezzanotte già passata
    expect(secondsUntilQuotaReset('2026-06-10', now)).toBe(60); // passato
  });
  it('periodEnd domani → ~12h+, comunque ≥60', () => {
    const s = secondsUntilQuotaReset('2026-06-21', now);
    expect(s).toBe(12 * 60 * 60); // 2026-06-21T00:00Z - 2026-06-20T12:00Z = 12h
  });
});
