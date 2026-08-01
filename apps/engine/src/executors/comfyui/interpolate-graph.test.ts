import { describe, it, expect } from 'vitest';
import { substituteGraphVariables } from './interpolate-graph.js';
import { ComfyError } from './client.js';

const wrap = (inputs: Record<string, unknown>): string =>
  JSON.stringify({ '1': { class_type: 'KSampler', inputs } });

describe('substituteGraphVariables', () => {
  it('whole-token NUMERICO → iniettato come numero, non stringa', () => {
    const g = substituteGraphVariables(wrap({ seed: '{{seed}}' }), { seed: '42' });
    expect(g['1']?.inputs.seed).toBe(42);
    expect(typeof g['1']?.inputs.seed).toBe('number');
  });

  it('whole-token BOOLEANO → booleano', () => {
    const g = substituteGraphVariables(wrap({ zsnr: '{{z}}' }), { z: 'true' });
    expect(g['1']?.inputs.zsnr).toBe(true);
  });

  it('whole-token STRINGA resta stringa', () => {
    const g = substituteGraphVariables(wrap({ ckpt: '{{c}}' }), { c: 'pony.safetensors' });
    expect(g['1']?.inputs.ckpt).toBe('pony.safetensors');
  });

  it('token INLINE in stringa più grande → interpolazione testuale', () => {
    const g = substituteGraphVariables(wrap({ text: 'a photo of {{soggetto}}, hd' }), { soggetto: 'gatto' });
    expect(g['1']?.inputs.text).toBe('a photo of gatto, hd');
  });

  it('token SCONOSCIUTO → lasciato invariato (no crash)', () => {
    const g = substituteGraphVariables(wrap({ text: '{{mancante}}' }), {});
    expect(g['1']?.inputs.text).toBe('{{mancante}}');
  });

  it('sostituisce dentro array e oggetti annidati', () => {
    const g = substituteGraphVariables(
      JSON.stringify({ '1': { class_type: 'X', inputs: { arr: ['{{a}}', { deep: '{{b}}' }] } } }),
      { a: '5', b: 'x' },
    );
    expect(g['1']?.inputs.arr).toEqual([5, { deep: 'x' }]);
  });

  it('rigetta JSON invalido con ComfyError', () => {
    expect(() => substituteGraphVariables('{ not json', {})).toThrow(ComfyError);
  });

  it('rigetta grafo vuoto', () => {
    expect(() => substituteGraphVariables('   ', {})).toThrow(/vuoto/i);
  });

  it('rigetta array top-level (non è un oggetto-grafo)', () => {
    expect(() => substituteGraphVariables('[]', {})).toThrow(/Grafo non valido/);
  });

  it('rigetta nodo senza class_type', () => {
    expect(() => substituteGraphVariables(JSON.stringify({ '1': { inputs: {} } }), {})).toThrow(/class_type/);
  });

  it('numero con spazi NON è trattato come numerico (resta stringa)', () => {
    const g = substituteGraphVariables(wrap({ v: '{{x}}' }), { x: ' 4 2 ' });
    expect(g['1']?.inputs.v).toBe(' 4 2 ');
  });
});
