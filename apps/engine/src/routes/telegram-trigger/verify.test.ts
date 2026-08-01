/**
 * verify.ts — secret token webhook Telegram. Bug-bounty: secret vuoto
 * (fail-closed), header vuoto, token quasi-giusto, lunghezze diverse.
 */
import { describe, it, expect } from 'vitest';
import { verifyTelegramSecret } from './verify.js';

describe('verifyTelegramSecret', () => {
  it('token identico → true', () => {
    expect(verifyTelegramSecret('s3cret-Tok_en', 's3cret-Tok_en')).toBe(true);
  });

  it('🚨 fail-closed: secret NON configurato → false anche con header vuoto (mai vuoto==vuoto)', () => {
    expect(verifyTelegramSecret('', '')).toBe(false);
  });

  it('🚨 header assente/vuoto → false', () => {
    expect(verifyTelegramSecret('', 'atteso')).toBe(false);
  });

  it('token sbagliato di UN carattere → false', () => {
    expect(verifyTelegramSecret('s3cret-Tok_eN', 's3cret-Tok_en')).toBe(false);
  });

  it('lunghezza diversa → false senza throw (length-check del timing-safe)', () => {
    expect(verifyTelegramSecret('corto', 'molto-piu-lungo-del-previsto')).toBe(false);
  });
});
