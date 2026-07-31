/**
 * Il parser deve estrarre JSON da qualunque forma di risposta un provider
 * possa produrre — e fallire parlando quando non c'è niente da estrarre.
 * Ogni caso qui è un modo in cui un modello reale ha sbagliato.
 */

import { describe, expect, it } from 'vitest';

import { firstBalancedJsonObject, parseScaffoldJson, stripCodeFences } from './parse';

describe('stripCodeFences', () => {
  it('lascia intatto il testo senza recinti', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it('toglie un recinto con linguaggio dichiarato', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('toglie un recinto senza linguaggio', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('sopravvive a un recinto mai chiuso', () => {
    expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
  });
});

describe('firstBalancedJsonObject', () => {
  it('trova il primo oggetto bilanciato', () => {
    expect(firstBalancedJsonObject('testo {"a":{"b":2}} coda')).toBe('{"a":{"b":2}}');
  });

  it('ignora le graffe dentro le stringhe', () => {
    const text = '{"tpl":"usa {{$node.x.json.y}} qui","n":1}';
    expect(firstBalancedJsonObject(text)).toBe(text);
  });

  it('ignora le graffe dietro escape di virgolette', () => {
    const text = '{"a":"virgolette \\" e graffa { dentro"}';
    expect(firstBalancedJsonObject(text)).toBe(text);
  });

  it('restituisce null senza graffe', () => {
    expect(firstBalancedJsonObject('nessun oggetto qui')).toBeNull();
  });

  it('restituisce null su un oggetto mai chiuso (risposta troncata)', () => {
    expect(firstBalancedJsonObject('{"a":{"b":1}')).toBeNull();
  });
});

describe('parseScaffoldJson', () => {
  it('accetta JSON puro', () => {
    expect(parseScaffoldJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('accetta JSON dentro un blocco markdown', () => {
    expect(parseScaffoldJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('accetta JSON preceduto e seguito da prosa', () => {
    expect(parseScaffoldJson('Ecco il workflow:\n{"a":1}\nSpero vada bene')).toEqual({ a: 1 });
  });

  it('non si fa ingannare da una graffa dentro una stringa', () => {
    expect(parseScaffoldJson('{"t":"usa {{$node.x}} qui"}')).toEqual({ t: 'usa {{$node.x}} qui' });
  });

  it('gestisce escape annidati e unicode', () => {
    expect(parseScaffoldJson('{"s":"riga\\nnuova \\"citata\\" \\u00e8"}')).toEqual({
      s: 'riga\nnuova "citata" è',
    });
  });

  it('restituisce anche JSON non-oggetto: il rifiuto spetta al validatore', () => {
    // JSON.parse accetta un array in radice; è isScaffoldOutput a respingerlo.
    expect(parseScaffoldJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('fallisce dicendo cosa è arrivato, con anteprima', () => {
    expect(() => parseScaffoldJson('Non posso aiutarti con questo.')).toThrow(
      /non contiene un oggetto JSON.*Non posso aiutarti/s,
    );
  });

  it('fallisce su una risposta vuota', () => {
    expect(() => parseScaffoldJson('')).toThrow(/non contiene un oggetto JSON/);
  });

  it('fallisce su JSON troncato a metà (output tagliato dal provider)', () => {
    expect(() => parseScaffoldJson('{"name":"x","nodes":[{"id":"a"')).toThrow(
      /non contiene un oggetto JSON/,
    );
  });

  it('segnala il malformato quando il candidato bilanciato non è JSON', () => {
    expect(() => parseScaffoldJson('usa {placeholder} nel testo')).toThrow(/malformato/);
  });
});
