/**
 * Test edge-first llm-exchange-log (Fase 3 #15): chunking sotto il cap fields,
 * PRIORITÀ del system prompt (mai troncarlo a favore dello user), marker di
 * troncamento onesto, no-op senza collector, mai throw (logging best-effort).
 */
import { describe, it, expect, vi } from 'vitest';
import { logLlmExchange, llmLogSinkFrom } from './llm-exchange-log.js';

function makeSink() {
  const calls: { msg: string; fields?: Record<string, unknown>; source?: string }[] = [];
  return {
    calls,
    info: (msg: string, fields?: Record<string, unknown>, source?: string) => {
      calls.push({ msg, fields, source });
    },
  };
}
const ctxWith = (sink: unknown) => ({ __logCollector: sink });

describe('llmLogSinkFrom', () => {
  it('context senza collector → undefined (no-op a valle)', () => {
    expect(llmLogSinkFrom({})).toBeUndefined();
    expect(llmLogSinkFrom({ __logCollector: null })).toBeUndefined();
    expect(llmLogSinkFrom({ __logCollector: { info: 'non-funzione' } })).toBeUndefined();
  });
  it('collector con info() → sink', () => {
    const s = makeSink();
    expect(llmLogSinkFrom(ctxWith(s))).toBe(s);
  });
});

describe('logLlmExchange — struttura entry', () => {
  it('emette header + prompt·system + prompt·user + risposta, TUTTI source llm', () => {
    const s = makeSink();
    logLlmExchange(ctxWith(s), {
      provider: 'liara',
      model: 'liara',
      system: 'SYS',
      user: 'USER',
      response: 'RESP',
    });
    expect(s.calls.every((c) => c.source === 'llm')).toBe(true);
    const kinds = s.calls.map((c) => c.fields?.kind);
    expect(kinds).toEqual(['llm_exchange', 'llm_prompt', 'llm_prompt', 'llm_response']);
    expect(s.calls[0]?.fields).toMatchObject({
      provider: 'liara',
      model: 'liara',
      systemChars: 3,
      userChars: 4,
      responseChars: 4,
    });
    expect(s.calls[1]?.fields?.text).toBe('SYS');
    expect(s.calls[2]?.fields?.text).toBe('USER');
    expect(s.calls[3]?.fields?.text).toBe('RESP');
  });

  it('phase finisce nel header e nelle label', () => {
    const s = makeSink();
    logLlmExchange(ctxWith(s), {
      provider: 'p',
      model: 'm',
      system: 's',
      user: 'u',
      response: 'r',
      phase: 'repair',
    });
    expect(s.calls[0]?.msg).toContain('[repair]');
    expect(s.calls[0]?.fields?.phase).toBe('repair');
  });

  it('testo lungo → CHUNK ordinati part/of, ricomponibili byte-identici', () => {
    const s = makeSink();
    const user = 'x'.repeat(7000); // > 2 chunk da 3200
    logLlmExchange(ctxWith(s), { provider: 'p', model: 'm', system: '', user, response: '' });
    const chunks = s.calls.filter((c) => c.fields?.kind === 'llm_prompt' && c.msg.includes('user'));
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.fields?.part)).toEqual([1, 2, 3]);
    expect(chunks.every((c) => c.fields?.of === 3)).toBe(true);
    const recomposed = chunks.map((c) => c.fields?.text as string).join('');
    expect(recomposed).toBe(user);
  });

  it("🚨 troncamento ONESTO: user oltre il budget → truncatedChars dichiarato sull'ultimo chunk", () => {
    const s = makeSink();
    const user = 'u'.repeat(20_000); // > cap 12k
    logLlmExchange(ctxWith(s), { provider: 'p', model: 'm', system: '', user, response: '' });
    const chunks = s.calls.filter((c) => c.fields?.kind === 'llm_prompt' && c.msg.includes('user'));
    const last = chunks[chunks.length - 1];
    expect(last?.fields?.truncatedChars).toBe(8_000);
    const total = chunks.reduce((acc, c) => acc + (c.fields?.text as string).length, 0);
    expect(total).toBe(12_000);
  });

  it('🚨 PRIORITÀ system: system grande → è lo USER a essere compresso, mai il system (entro il suo cap)', () => {
    const s = makeSink();
    const system = 'S'.repeat(11_000); // sotto il cap 12k → INTEGRO
    const user = 'U'.repeat(5_000);
    logLlmExchange(ctxWith(s), { provider: 'p', model: 'm', system, user, response: '' });
    const sys = s.calls.filter((c) => c.msg.includes('system'));
    const usr = s.calls.filter((c) => c.fields?.kind === 'llm_prompt' && c.msg.includes('user'));
    const sysTotal = sys.reduce((acc, c) => acc + (c.fields?.text as string).length, 0);
    const usrTotal = usr.reduce((acc, c) => acc + (c.fields?.text as string).length, 0);
    expect(sysTotal).toBe(11_000); // integro
    expect(usrTotal).toBe(1_000); // budget residuo (min garantito 1000)
    expect(usr[usr.length - 1]?.fields?.truncatedChars).toBe(4_000);
  });

  it('context senza collector → NESSUNA chiamata, nessun throw', () => {
    expect(() => {
      logLlmExchange({}, { provider: 'p', model: 'm', system: 's', user: 'u', response: 'r' });
    }).not.toThrow();
  });

  it('🚨 sink che LANCIA → il logging non propaga (best-effort, mai rompere il nodo)', () => {
    const bomb = {
      info: vi.fn(() => {
        throw new Error('collector rotto');
      }),
    };
    expect(() => {
      logLlmExchange(ctxWith(bomb), {
        provider: 'p',
        model: 'm',
        system: 's',
        user: 'u',
        response: 'r',
      });
    }).not.toThrow();
  });
});
