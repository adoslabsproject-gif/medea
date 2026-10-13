import { describe, expect, it } from 'vitest';

import { comandoInCorso, completa, suggerimenti } from './slash';

const COMANDI = ['compact', 'context', 'code-review', 'cost', 'model', 'init', 'plugin:verifica'];

describe('comandoInCorso', () => {
  it('riconosce un comando solo in testa al messaggio', () => {
    expect(comandoInCorso('/')).toBe('');
    expect(comandoInCorso('/co')).toBe('co');
    expect(comandoInCorso('/plugin:ver')).toBe('plugin:ver');
    expect(comandoInCorso('vedi /tmp/file')).toBeNull();
    expect(comandoInCorso(' /co')).toBeNull();
    expect(comandoInCorso('ciao')).toBeNull();
  });

  it('dopo uno spazio il comando è scritto: non si propone più niente', () => {
    expect(comandoInCorso('/model opus')).toBeNull();
    expect(comandoInCorso('/compact ')).toBeNull();
  });
});

describe('suggerimenti', () => {
  it('con la sola barra propone i comandi, in ordine', () => {
    expect(suggerimenti('/', COMANDI)).toEqual([
      'code-review',
      'compact',
      'context',
      'cost',
      'init',
      'model',
      'plugin:verifica',
    ]);
  });

  it('mette prima quelli che cominciano così, poi quelli che lo contengono', () => {
    expect(suggerimenti('/co', COMANDI)).toEqual(['code-review', 'compact', 'context', 'cost']);
    expect(suggerimenti('/ver', COMANDI)).toEqual(['plugin:verifica']);
    expect(suggerimenti('/e', COMANDI)).toEqual([
      'code-review',
      'context',
      'model',
      'plugin:verifica',
    ]);
  });

  it('non distingue maiuscole e minuscole', () => {
    expect(suggerimenti('/MOD', COMANDI)).toEqual(['model']);
  });

  it('senza barra in testa non propone niente', () => {
    expect(suggerimenti('compact', COMANDI)).toEqual([]);
    expect(suggerimenti('/model opus', COMANDI)).toEqual([]);
  });

  it('non ripete un comando dichiarato due volte e non ne mostra più di otto', () => {
    expect(suggerimenti('/co', ['cost', 'cost'])).toEqual(['cost']);
    const tanti = Array.from({ length: 30 }, (_, i) => `cmd${String(i).padStart(2, '0')}`);
    expect(suggerimenti('/', tanti)).toHaveLength(8);
  });
});

describe('completa', () => {
  it('scrive il comando seguito da uno spazio, pronto per gli argomenti', () => {
    expect(completa('model')).toBe('/model ');
  });
});
