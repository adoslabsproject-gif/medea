/**
 * Fermarsi o provare le altre strade.
 *
 * Il 2026-08-06 il wizard è morto con due strade intatte in tasca. Il modello
 * si era rifiutato di completare la risposta — una sua protezione interna, non
 * un giudizio sul workflow — e il motore riportava «errore». Ogni errore del
 * motore veniva trattato come un VERDETTO, e i verdetti fermano la cascata.
 *
 * La distinzione è tutta qui: un motore che ha giudicato merita rispetto,
 * un motore che non è riuscito ad avere una risposta no.
 *
 * @module features/workflows/scaffold/verdetto.test
 */

import { describe, expect, it } from 'vitest';

import { eUnVerdetto } from './motore';

describe('cosa ferma la cascata', () => {
  it('un rifiuto del quality gate è un verdetto: non si ripiega', () => {
    expect(
      eUnVerdetto('Workflow rejected — quality gate ha trovato 2 bug critici: • [DB_TABLE…]'),
    ).toBe(true);
  });

  it('un errore di validazione è un verdetto', () => {
    expect(eUnVerdetto('Workflow generato con 1 errori di validazione: nodo orfano')).toBe(true);
  });
});

describe('cosa invece lascia libere le altre strade', () => {
  /** Il caso vero: il modello si interrompe e dice che non può condividere. */
  it('il modello che si rifiuta non ha giudicato niente', () => {
    expect(
      eUnVerdetto(
        'Il modello si è rifiutato di completare la risposta: ha cominciato a produrre il workflow…',
      ),
    ).toBe(false);
  });

  it('un output illeggibile non è un giudizio', () => {
    expect(
      eUnVerdetto('Output del modello non conforme allo schema: output senza un oggetto JSON valido'),
    ).toBe(false);
  });

  it('un provider irraggiungibile nemmeno', () => {
    expect(eUnVerdetto('fetch failed')).toBe(false);
    expect(eUnVerdetto('Il motore ha rifiutato il lavoro.')).toBe(false);
  });
});
