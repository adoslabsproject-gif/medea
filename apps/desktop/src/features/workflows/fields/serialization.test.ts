/**
 * I formati sono il contratto con il motore: quello che si scrive qui deve
 * essere letto là. Questi test guardano l'andata e ritorno — un valore
 * salvato e riletto deve tornare identico — e il caso che rompe tutto: un
 * valore illeggibile non deve mai far esplodere il pannello.
 */

import { describe, expect, it } from 'vitest';

import {
  moveRow,
  parseFilters,
  parseKeyValue,
  parseSort,
  parseSwitchCases,
  serializeFilters,
  serializeKeyValue,
  serializeSort,
  serializeSwitchCases,
  toFieldKey,
} from './serialization';

describe('chiave → valore', () => {
  it('conserva le stringhe e riporta al tipo numeri, booleani e strutture', () => {
    const json = serializeKeyValue([
      { k: 'Authorization', v: 'Bearer abc' },
      { k: 'retry', v: '3' },
      { k: 'attivo', v: 'true' },
      { k: 'extra', v: '{"a":1}' },
    ]);
    expect(JSON.parse(json)).toEqual({
      Authorization: 'Bearer abc',
      retry: 3,
      attivo: true,
      extra: { a: 1 },
    });
  });

  it('lascia in pace le espressioni del motore', () => {
    const json = serializeKeyValue([{ k: 'X-Key', v: '{{secrets.API_KEY}}' }]);
    expect(JSON.parse(json)).toEqual({ 'X-Key': '{{secrets.API_KEY}}' });
  });

  it('scarta le righe senza chiave invece di scrivere una chiave vuota', () => {
    expect(JSON.parse(serializeKeyValue([{ k: '  ', v: 'x' }]))).toEqual({});
  });

  it('un valore illeggibile non fa esplodere niente', () => {
    expect(parseKeyValue('non sono json')).toEqual([]);
    expect(parseKeyValue('[1,2,3]')).toEqual([]);
    expect(parseKeyValue('')).toEqual([]);
  });

  it('andata e ritorno', () => {
    const pairs = [{ k: 'a', v: 'uno' }];
    expect(parseKeyValue(serializeKeyValue(pairs))).toEqual(pairs);
  });
});

describe('casi dello switch', () => {
  it('usa una coppia per riga, come il motore', () => {
    expect(serializeSwitchCases([{ value: 'fattura', branch: 'contabilita' }])).toBe(
      'fattura=contabilita',
    );
  });

  it('regge un valore che contiene un uguale', () => {
    const parsed = parseSwitchCases('a=b=c');
    expect(parsed).toEqual([{ value: 'a', branch: 'b=c' }]);
  });

  it('una riga senza uguale è un valore senza ramo', () => {
    expect(parseSwitchCases('solo')).toEqual([{ value: 'solo', branch: '' }]);
  });

  it('andata e ritorno', () => {
    const cases = [
      { value: 'a', branch: 'uno' },
      { value: 'b', branch: 'due' },
    ];
    expect(parseSwitchCases(serializeSwitchCases(cases))).toEqual(cases);
  });
});

describe('filtri di query', () => {
  it('toglie il valore agli operatori che non lo usano', () => {
    const json = serializeFilters([{ column: 'chiuso_il', op: 'isNull', value: 'ignorato' }]);
    expect(JSON.parse(json)).toEqual([{ column: 'chiuso_il', op: 'isNull' }]);
  });

  it('scarta le righe senza colonna', () => {
    expect(JSON.parse(serializeFilters([{ column: '', op: 'eq', value: 'x' }]))).toEqual([]);
  });

  it('un valore illeggibile non fa esplodere niente', () => {
    expect(parseFilters('{}')).toEqual([]);
    expect(parseFilters('rotto')).toEqual([]);
  });
});

describe('ordinamento', () => {
  it('conserva l’ordine: la prima riga è il criterio principale', () => {
    const rows = [
      { column: 'data', direction: 'desc' as const },
      { column: 'nome', direction: 'asc' as const },
    ];
    expect(parseSort(serializeSort(rows))).toEqual(rows);
  });

  it('un verso sconosciuto diventa crescente', () => {
    expect(parseSort('[{"column":"x","direction":"boh"}]')).toEqual([
      { column: 'x', direction: 'asc' },
    ]);
  });
});

describe('spostare una riga', () => {
  it('scambia con la precedente e con la successiva', () => {
    expect(moveRow(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('non esce dai bordi', () => {
    expect(moveRow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveRow(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('nome tecnico da etichetta', () => {
  it('toglie accenti, spazi e punteggiatura', () => {
    expect(toFieldKey('Nome del cliente')).toBe('nome_del_cliente');
    expect(toFieldKey('Città / Provincia')).toBe('citta_provincia');
    expect(toFieldKey('  E-mail!  ')).toBe('e_mail');
  });

  it('un’etichetta senza lettere dà una chiave vuota, non spazzatura', () => {
    expect(toFieldKey('!!!')).toBe('');
  });
});
