/**
 * Unit test edge-first per llm-usage.ts (Fase 1a #12).
 *
 * Caccia ai bug, non happy-path: conteggi API rotti (NaN/negativi/parziali/
 * assenti/campo di tipo sbagliato), stringhe vuote, somma mista API+stima,
 * attach su ogni forma di output (oggetto/array/stringa/null/numero) con
 * l'invariante "i dati non cambiano".
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, buildAgentUsage, sumAgentUsage, attachAgentUsage } from './llm-usage.js';
import type { AgentLlmUsage } from './llm-usage.js';

const base = { provider: 'openai', model: 'gpt-4o-mini', sentSystem: 'S'.repeat(35), sentUser: 'U'.repeat(70), receivedText: 'R'.repeat(7) };

describe('estimateTokens — ~3.5 char/token, ceil', () => {
  it('0 char → 0 token; 1 char → 1 token (ceil, mai frazioni)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x')).toBe(1);
  });
  it('35 char → 10 token esatti', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10);
  });
});

describe('buildAgentUsage — API precisa quando ENTRAMBI i conteggi ci sono', () => {
  it('entrambi i conteggi API → fromApi:true, numeri API (non stime)', () => {
    const u = buildAgentUsage({ ...base, api: { input: 123, output: 45 } });
    expect(u).toEqual({ inputTokens: 123, outputTokens: 45, model: 'gpt-4o-mini', provider: 'openai', fromApi: true });
  });
  it('0 è un conteggio API VALIDO (non falsy-trap)', () => {
    const u = buildAgentUsage({ ...base, api: { input: 0, output: 0 } });
    expect(u.fromApi).toBe(true);
    expect(u.inputTokens).toBe(0);
  });
  it('solo input API (output mancante) → fromApi:false, TUTTO stimato', () => {
    const u = buildAgentUsage({ ...base, api: { input: 123 } });
    expect(u.fromApi).toBe(false);
    expect(u.inputTokens).toBe(10 + 20); // stima system(35)+user(70), NON 123
    expect(u.outputTokens).toBe(2); // ceil(7/3.5)
  });
  it('NaN / negativi / Infinity dalla API → trattati come assenti (stima)', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const u = buildAgentUsage({ ...base, api: { input: bad, output: 45 } });
      expect(u.fromApi).toBe(false);
      expect(u.inputTokens).toBe(30);
    }
  });
  it('api assente del tutto → stima su sent + received', () => {
    const u = buildAgentUsage(base);
    expect(u).toEqual({ inputTokens: 30, outputTokens: 2, model: 'gpt-4o-mini', provider: 'openai', fromApi: false });
  });
});

describe('sumAgentUsage — repair pass', () => {
  const mk = (i: number, o: number, fromApi: boolean): AgentLlmUsage =>
    ({ inputTokens: i, outputTokens: o, model: 'm', provider: 'p', fromApi });
  it('somma i token; fromApi resta true solo se TUTTE le chiamate erano API', () => {
    expect(sumAgentUsage(mk(10, 5, true), mk(20, 7, true))).toEqual(mk(30, 12, true));
    expect(sumAgentUsage(mk(10, 5, true), mk(20, 7, false)).fromApi).toBe(false);
    expect(sumAgentUsage(mk(10, 5, false), mk(20, 7, true)).fromApi).toBe(false);
  });
});

describe('attachAgentUsage — la forma dei DATI non cambia mai', () => {
  const usage: AgentLlmUsage = { inputTokens: 1, outputTokens: 2, model: 'm', provider: 'p', fromApi: true };
  it('oggetto plain → copia con _llm, campi dati byte-identici, originale NON mutato', () => {
    const original = { a: 1, nested: { b: 2 } };
    const out = attachAgentUsage(original, usage) as Record<string, unknown>;
    expect(out._llm).toEqual(usage);
    expect(out.a).toBe(1);
    expect(out.nested).toBe(original.nested);
    expect('_llm' in original).toBe(false);
  });
  it('_llm echeggiato dal modello viene sovrascritto dal NOSTRO metadata', () => {
    const out = attachAgentUsage({ a: 1, _llm: 'fasullo dal modello' }, usage) as Record<string, unknown>;
    expect(out._llm).toEqual(usage);
  });
  it('stringa (translator) → INVARIATA, stessa identità', () => {
    expect(attachAgentUsage('testo tradotto', usage)).toBe('testo tradotto');
  });
  it('array (extractor con schema-array) → INVARIATO, stessa identità', () => {
    const arr = [{ a: 1 }];
    expect(attachAgentUsage(arr, usage)).toBe(arr);
  });
  it('null / numero → invariati', () => {
    expect(attachAgentUsage(null, usage)).toBeNull();
    expect(attachAgentUsage(42, usage)).toBe(42);
  });
});
