/**
 * La password che l'utente incolla, e l'errore che riceve se non va.
 *
 * Google mostra la «password per le app» in quattro gruppi di quattro lettere.
 * Chi la copia dalla pagina si porta dietro gli spazi — a volte spazi normali,
 * a volte spazi non separabili che a occhio sono identici. Con quelli dentro,
 * il server risponde «credenziali non valide» a una password giusta.
 */

import { describe, expect, it } from 'vitest';

import { passwordDaUsare, spiegaAccessoFallito } from './password';

describe('passwordDaUsare', () => {
  it('toglie gli spazi a una password per le app copiata a gruppi', () => {
    expect(passwordDaUsare('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
  });

  it('toglie anche gli spazi non separabili, che a occhio non si vedono', () => {
    expect(passwordDaUsare('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
    expect(passwordDaUsare(' abcd efgh ijkl mnop\n')).toBe('abcdefghijklmnop');
  });

  it('lascia stare una password per le app già senza spazi', () => {
    expect(passwordDaUsare('abcdefghijklmnop')).toBe('abcdefghijklmnop');
  });

  /**
   * Una password vera può contenere spazi, e sono suoi: toglierli vorrebbe
   * dire mandarne un'altra.
   */
  it('non tocca una password normale che contiene spazi', () => {
    expect(passwordDaUsare('la mia frase segreta')).toBe('la mia frase segreta');
    expect(passwordDaUsare('Abcd Efgh Ijkl Mnop')).toBe('Abcd Efgh Ijkl Mnop');
    expect(passwordDaUsare('abcd efgh ijkl mno1')).toBe('abcd efgh ijkl mno1');
    expect(passwordDaUsare(' spazio davanti')).toBe(' spazio davanti');
  });
});

describe('spiegaAccessoFallito', () => {
  const RIFIUTO =
    'LOGIN IMAP fallito (a@gmail.com@imap.gmail.com): no response: code: None, info: Some("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")';

  it('con Gmail dice che serve la password per le app, non quella dell’account', () => {
    const testo = spiegaAccessoFallito('gmail', RIFIUTO);
    expect(testo).toContain('password per le app');
    expect(testo).toContain('16 lettere');
    // L'errore del server resta leggibile: serve a chi deve capire di più.
    expect(testo).toContain('AUTHENTICATIONFAILED');
  });

  it('con gli altri provider che la richiedono dice la stessa cosa in generale', () => {
    expect(spiegaAccessoFallito('yahoo', RIFIUTO)).toContain('password per le app');
    expect(spiegaAccessoFallito('icloud', RIFIUTO)).toContain('password per le app');
  });

  it('con un server qualunque non inventa consigli', () => {
    expect(spiegaAccessoFallito('custom', RIFIUTO)).toBe(RIFIUTO);
  });

  it('un errore che non è un rifiuto delle credenziali resta com’è', () => {
    const rete = 'TCP timeout collegandomi a imap.gmail.com:993';
    expect(spiegaAccessoFallito('gmail', rete)).toBe(rete);
  });
});
