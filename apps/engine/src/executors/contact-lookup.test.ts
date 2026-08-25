/**
 * L'estrazione dell'indirizzo dal mittente.
 *
 * Un trigger email consegna `from` come lo ha scritto chi manda — «Mario Rossi
 * <m.rossi@acme.it>» — e cercare quella stringa intera in rubrica non trova mai
 * niente. È la differenza fra un nodo che funziona e uno che risponde sempre
 * «non lo conosco», e non darebbe nessun errore: solo un `found: false` che
 * sembra una risposta.
 */

import { describe, expect, it } from 'vitest';

import { indirizzoDa } from './contact-lookup.js';

describe('indirizzoDa', () => {
  it('estrae l’indirizzo da un mittente per esteso', () => {
    expect(indirizzoDa('Mario Rossi <m.rossi@acme.it>')).toBe('m.rossi@acme.it');
  });

  it('estrae anche quando il nome ha virgolette o virgole', () => {
    expect(indirizzoDa('"Rossi, Mario" <m.rossi@acme.it>')).toBe('m.rossi@acme.it');
  });

  it('lascia passare un indirizzo già nudo', () => {
    expect(indirizzoDa('m.rossi@acme.it')).toBe('m.rossi@acme.it');
  });

  /** Il confronto in rubrica è insensibile al caso: si normalizza qui. */
  it('normalizza maiuscole e spazi', () => {
    expect(indirizzoDa('  M.Rossi@ACME.it  ')).toBe('m.rossi@acme.it');
  });
});
