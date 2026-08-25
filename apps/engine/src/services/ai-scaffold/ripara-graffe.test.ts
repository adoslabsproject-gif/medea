/**
 * Espressioni con una graffa sola.
 *
 * Il modello legge la forma giusta nel prompt, la usa, e perde una graffa. È
 * successo il 2026-08-05, il 2026-08-06 e ancora il 2026-08-07 — dopo aver
 * messo l'esempio corretto nel prompt. A un certo punto ripetere l'istruzione
 * smette di essere una soluzione.
 *
 * @module services/ai-scaffold/ripara-graffe.test
 */

import { describe, expect, it } from 'vitest';

import { riparaGraffe, riparaGraffeInConfig } from '@/services/ai-scaffold/ripara-graffe.js';

describe('il caso vero', () => {
  it('raddoppia le graffe attorno a un riferimento a un nodo', () => {
    const esito = riparaGraffe("{$node.filtra.json.kept | pluck:'nome' | join:', '}");
    expect(esito.testo).toBe("{{$node.filtra.json.kept | pluck:'nome' | join:', '}}");
    expect(esito.corrette).toBe(1);
  });

  it('corregge anche in mezzo a un testo', () => {
    const esito = riparaGraffe('Articoli sotto scorta: {$node.f.json.kept} — controlla.');
    expect(esito.testo).toBe('Articoli sotto scorta: {{$node.f.json.kept}} — controlla.');
  });

  it('ne corregge più d’una nello stesso testo', () => {
    const esito = riparaGraffe('{$node.a.json.x} e {$node.b.json.y}');
    expect(esito.corrette).toBe(2);
    expect(esito.testo).toBe('{{$node.a.json.x}} e {{$node.b.json.y}}');
  });
});

/**
 * Il difetto peggiore che questa riparazione abbia prodotto.
 *
 * Il 2026-08-10 il modello aveva scritto un `conditionRules` CORRETTO —
 * `[{"left":"{{$node.a}}","op":"lt","right":"{{$node.b}}"}]` — e la
 * riparazione ha preso la graffa dell'OGGETTO JSON, l'ha raddoppiata, e ha
 * prodotto graffe scompagnate dove non ce n'erano. Il workflow risultava
 * rotto, e la colpa sembrava del modello.
 *
 * Il criterio era «contiene `$node.`». Ora è «COMINCIA con `$node.`»: un
 * oggetto JSON comincia con una virgoletta, un'espressione no.
 */
describe('non deve rompere ciò che era sano', () => {
  it('lascia intatto un conditionRules già corretto', () => {
    const regole =
      '[{"left":"{{$node.scarica.json.prezzo}}","op":"lt",' +
      '"right":"{{$node.precedente.json.prezzo}}"}]';
    expect(riparaGraffe(regole)).toEqual({ testo: regole, corrette: 0 });
  });

  it('non raddoppia la graffa di un oggetto JSON', () => {
    const json = '{"campo":"valore","altro":"{{$node.a.json.b}}"}';
    expect(riparaGraffe(json).corrette).toBe(0);
  });

  /** Dentro un JSON, un'espressione scritta male si corregge lo stesso. */
  it('ma dentro un JSON corregge l’espressione scompagnata', () => {
    const rotto = '[{"left":"{$node.scarica.json.prezzo}","op":"lt"}]';
    const esito = riparaGraffe(rotto);
    expect(esito.corrette).toBe(1);
    expect(esito.testo).toContain('"{{$node.scarica.json.prezzo}}"');
    // E la struttura JSON resta quella.
    expect(esito.testo.startsWith('[{"left"')).toBe(true);
  });
});

describe('quello che non deve toccare', () => {
  it('lascia stare quelle già giuste', () => {
    const gia = "{{$node.filtra.json.kept | pluck:'nome'}}";
    expect(riparaGraffe(gia)).toEqual({ testo: gia, corrette: 0 });
  });

  /**
   * Una graffa sola senza `$node.` può essere il template di qualcun altro:
   * riscriverla sarebbe peggio del difetto.
   */
  it('non tocca una graffa che non riguarda un nodo', () => {
    const altro = 'Ciao {nome}, il totale è {totale}.';
    expect(riparaGraffe(altro)).toEqual({ testo: altro, corrette: 0 });
  });

  it('non tocca un testo senza graffe', () => {
    expect(riparaGraffe('nessuna espressione qui')).toEqual({
      testo: 'nessuna espressione qui',
      corrette: 0,
    });
  });

  /** Un misto: si corregge solo quella scompagnata. */
  it('in un misto corregge solo quella rotta', () => {
    const esito = riparaGraffe('{{$node.a.json.x}} e {$node.b.json.y}');
    expect(esito.corrette).toBe(1);
    expect(esito.testo).toBe('{{$node.a.json.x}} e {{$node.b.json.y}}');
  });
});

describe('dentro una configurazione', () => {
  it('corregge anche i valori annidati', () => {
    const { config, corrette } = riparaGraffeInConfig({
      body: '{$node.f.json.kept}',
      blocks: [{ testo: '{$node.g.json.x}' }],
      port: 465,
    });
    expect(corrette).toBe(2);
    expect(config.body).toBe('{{$node.f.json.kept}}');
    expect((config.blocks as { testo: string }[])[0]?.testo).toBe('{{$node.g.json.x}}');
    // I valori che non sono testo restano quelli.
    expect(config.port).toBe(465);
  });
});
