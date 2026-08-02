/**
 * sandbox-crypto-guard — bug-bounty della guardia anti-OOM su randomBytes.
 *
 * Anti-regressione: il finding era `randomBytes(size)` con size vendor-controlled
 * SENZA cap → OOM host. Ogni caso qui FALLISCE sul codice pre-fix (che non
 * validava size) → mutation-verify.
 */
import { describe, it, expect } from 'vitest';
import { guardedRandomBytes, MAX_SANDBOX_RANDOM_BYTES } from './sandbox-crypto-guard.js';

describe('guardedRandomBytes — uso legittimo', () => {
  it('size piccolo (nonce/chiave) → Buffer della lunghezza esatta', () => {
    for (const n of [0, 1, 12, 16, 32, 64, 256]) {
      const buf = guardedRandomBytes(n);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(n);
    }
  });

  it('al boundary MAX è ancora ammesso', () => {
    const buf = guardedRandomBytes(MAX_SANDBOX_RANDOM_BYTES);
    expect(buf.length).toBe(MAX_SANDBOX_RANDOM_BYTES);
  });
});

describe('guardedRandomBytes — 🚨 guardia anti-OOM (il finding)', () => {
  it('🚨 size gigante (attacco OOM host) → THROW, nessuna allocazione', () => {
    expect(() => guardedRandomBytes(2_000_000_000)).toThrow(/anti-OOM|non valida/i);
    expect(() => guardedRandomBytes(MAX_SANDBOX_RANDOM_BYTES + 1)).toThrow();
  });

  it('🚨 negativo, NaN, Infinity, non-intero, non-numero → THROW', () => {
    expect(() => guardedRandomBytes(-1)).toThrow();
    expect(() => guardedRandomBytes(Number.NaN)).toThrow();
    expect(() => guardedRandomBytes(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => guardedRandomBytes(3.5)).toThrow();
    expect(() => guardedRandomBytes('64' as unknown as number)).toThrow();
    expect(() => guardedRandomBytes(undefined as unknown as number)).toThrow();
  });

  it("il messaggio d'errore è chiaro e cita il limite (il vendor lo vede nel run)", () => {
    try {
      guardedRandomBytes(1e9);
      throw new Error('doveva lanciare');
    } catch (err) {
      expect((err as Error).message).toContain(String(MAX_SANDBOX_RANDOM_BYTES));
    }
  });
});
