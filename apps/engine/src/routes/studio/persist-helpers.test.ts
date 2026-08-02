import { describe, it, expect } from 'vitest';
import { dimsFromParams } from './persist-helpers.js';

describe('dimsFromParams — promozione width/height da params alle colonne dedicate', () => {
  it('estrae width/height numerici (caso immagine)', () => {
    expect(dimsFromParams({ mode: 'sdxl', width: 1024, height: 768 })).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it('estrae width/height numerici (caso video)', () => {
    expect(dimsFromParams({ kind: 'i2v', width: 832, height: 480, length: 45 })).toEqual({
      width: 832,
      height: 480,
    });
  });

  it('🚨 ANTI-REGRESSIONE del bug: params SENZA width/height → niente colonne (non NULL forzato a 0)', () => {
    // Il bug era l'opposto: width/height esistevano in params ma non finivano nelle
    // colonne. Qui verifichiamo il contratto: se non ci sono, non si inventano.
    expect(dimsFromParams({ mode: 'sdxl' })).toEqual({});
    expect(dimsFromParams(undefined)).toEqual({});
  });

  it.each([
    ['stringa', { width: '1024', height: '768' }],
    ['NaN', { width: NaN, height: NaN }],
    ['Infinity', { width: Infinity, height: -Infinity }],
    ['null', { width: null, height: null }],
  ])(
    'bug-bounty: width/height non-numerici (%s) → scartati (no valori sporchi in colonna)',
    (_l, params) => {
      expect(dimsFromParams(params as Record<string, unknown>)).toEqual({});
    },
  );

  it('promuove solo il lato valido se uno dei due manca', () => {
    expect(dimsFromParams({ width: 512 })).toEqual({ width: 512 });
    expect(dimsFromParams({ height: 512 })).toEqual({ height: 512 });
  });
});
