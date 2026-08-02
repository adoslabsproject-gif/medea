import { describe, it, expect } from 'vitest';
import { LlmQuotaExceededError, parseQuotaError } from './llm-chat.service.js';

describe('parseQuotaError — riconosce i 429 di quota del gateway', () => {
  it('MONTHLY_TOKEN_QUOTA_EXCEEDED → kind token + campi propagati', () => {
    const body = JSON.stringify({
      error: {
        code: 'MONTHLY_TOKEN_QUOTA_EXCEEDED',
        message: 'Limite token',
        tokensUsed: 510_000,
        monthlyLimit: 500_000,
        planCode: 'starter',
        periodEndIso: '2026-07-15',
      },
    });
    const e = parseQuotaError(body, 'liara');
    expect(e).toBeInstanceOf(LlmQuotaExceededError);
    expect(e?.kind).toBe('token');
    expect(e?.used).toBe(510_000);
    expect(e?.limit).toBe(500_000);
    expect(e?.planCode).toBe('starter');
    expect(e?.periodEndIso).toBe('2026-07-15');
    expect(e?.provider).toBe('liara');
  });

  it('MONTHLY_CALLS_QUOTA_EXCEEDED → kind calls (usa callsUsed)', () => {
    const e = parseQuotaError(
      JSON.stringify({
        error: {
          code: 'MONTHLY_CALLS_QUOTA_EXCEEDED',
          callsUsed: 101,
          monthlyLimit: 100,
          planCode: 'free',
          periodEndIso: '2026-07-01',
        },
      }),
      'liara',
    );
    expect(e?.kind).toBe('calls');
    expect(e?.used).toBe(101);
    expect(e?.limit).toBe(100);
  });

  it('QUOTA_EXCEEDED (daily) → kind daily', () => {
    const e = parseQuotaError(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED' } }), 'liara');
    expect(e?.kind).toBe('daily');
    expect(e?.used).toBeNull();
    expect(e?.limit).toBeNull();
  });

  it('codice NON-quota (es. UPSTREAM_ERROR) → null (ricade su errore generico)', () => {
    expect(
      parseQuotaError(JSON.stringify({ error: { code: 'UPSTREAM_ERROR' } }), 'liara'),
    ).toBeNull();
  });

  it('body non-JSON → null', () => {
    expect(parseQuotaError('rate limited (plain text)', 'liara')).toBeNull();
  });

  it('JSON senza error.code → null', () => {
    expect(parseQuotaError(JSON.stringify({ foo: 'bar' }), 'liara')).toBeNull();
    expect(parseQuotaError(JSON.stringify({ error: {} }), 'liara')).toBeNull();
  });
});

describe('LlmQuotaExceededError — messaggio CHIARO e azionabile', () => {
  it('include uso/limite, data di reset formattata IT e suggerimento BYOK/upgrade', () => {
    const e = new LlmQuotaExceededError({
      provider: 'liara',
      kind: 'token',
      used: 510_000,
      limit: 500_000,
      planCode: 'starter',
      periodEndIso: '2026-07-15',
    });
    expect(e.message).toContain('510000/500000');
    expect(e.message).toContain('15 luglio 2026'); // reset formattato UTC
    expect(e.message).toMatch(/BYOK|piano superiore/);
    expect(e.name).toBe('LlmQuotaExceededError');
  });

  it('senza periodEndIso → nessuna frase di reset, ma resta azionabile', () => {
    const e = new LlmQuotaExceededError({ provider: 'liara', kind: 'calls' });
    expect(e.message).not.toMatch(/Si rinnova/);
    expect(e.message).toMatch(/esaurita/);
  });

  it('data di reset malformata → non crasha (usa ISO grezzo)', () => {
    const e = new LlmQuotaExceededError({
      provider: 'liara',
      kind: 'token',
      periodEndIso: 'not-a-date',
    });
    expect(e.message).toContain('not-a-date');
  });
});
