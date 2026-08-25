/**
 * `pluck` — da una lista di oggetti alla lista dei loro campi.
 *
 * È il pezzo che mancava per scrivere un elenco in una email. `join` da solo,
 * su una lista di oggetti, produce `[object Object]`. Senza un modo per
 * estrarre un campo, chi genera i workflow ripiega su `.map()` dentro le
 * graffe — che l'interprete non esegue e che finisce nel testo così com'è
 * scritta.
 *
 * È successo il 2026-08-05 («{$node.cerca.json.rows.map(row => …)}») e di
 * nuovo il 2026-08-06 («{$node.filtra.json.kept.map(x => `<li>${x.nome}…`»).
 * Due obiettivi diversi, stesso errore: la causa non era il modello.
 *
 * @module engine/pluck.test
 */

import { describe, expect, it } from 'vitest';

import { interpolateString } from '@/engine/interpreter.js';

const scope = {
  vars: {
    filtro: {
      kept: [
        { nome: 'Viti M6', qta: 3 },
        { nome: 'Dadi M8', qta: 0 },
        { qta: 7 },
      ],
    },
    vuoto: { kept: [] },
  },
} as never;

describe('scrivere un elenco leggibile', () => {
  it('estrae un campo e lo unisce', () => {
    expect(
      interpolateString("{{$node.filtro.json.kept | pluck:'nome' | join:', '}}", scope),
    ).toBe('Viti M6, Dadi M8, ');
  });

  /**
   * Un campo assente diventa stringa vuota, non «undefined»: in una email è
   * la differenza fra una riga vuota e una riga sbagliata.
   */
  it('un campo assente non stampa «undefined»', () => {
    const out = interpolateString("{{$node.filtro.json.kept | pluck:'inesistente'}}", scope);
    expect(out).not.toContain('undefined');
  });

  it('su una lista vuota non produce niente di strano', () => {
    expect(interpolateString("{{$node.vuoto.json.kept | pluck:'nome' | join:', '}}", scope)).toBe(
      '',
    );
  });

  /** Non deve rompersi su ciò che non è una lista. */
  it('su un valore che non è una lista resta innocuo', () => {
    expect(interpolateString("{{$node.filtro.json.kept.length | pluck:'nome'}}", scope)).toBe('');
  });
});

describe('quello che pluck NON è', () => {
  /**
   * Il motivo per cui esiste: `join` da solo su oggetti dava una riga
   * illeggibile, ed è esattamente ciò che spingeva a scrivere codice.
   */
  it('senza pluck, unire oggetti dà una riga illeggibile', () => {
    expect(interpolateString("{{$node.filtro.json.kept | join:', '}}", scope)).toContain(
      '[object Object]',
    );
  });
});
