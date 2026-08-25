/**
 * Liara è un Mistral, non un Qwen.
 *
 * Il codice le mandava `/no_think` in testa a ogni prompt di sistema e
 * `enable_thinking` fra i parametri del template: sono convenzioni **di
 * Qwen3**. Il 2026-08-07 il modello ha risposto emettendo
 * `[TOOL_CALLS]fs_read{…}` — il token nativo con cui i Mistral chiedono uno
 * strumento — e ha confermato quello che il proprietario diceva da giorni.
 *
 * @module services/ai-scaffold/famiglia-modello.test
 */

import { describe, expect, it } from 'vitest';

import {
  contieneChiamataAStrumento,
  contieneRifiuto,
  messaggioChiamataAStrumento,
} from '@/services/ai-scaffold/rifiuto-del-modello.js';

describe('una chiamata a strumento dove strumenti non ce ne sono', () => {
  /** La risposta vera, incollata dal wizard. */
  it('riconosce il token nativo di Mistral', () => {
    expect(
      contieneChiamataAStrumento(
        '[TOOL_CALLS]fs_read{"path": "/Users/tu/Documenti/magazzino.txt"}',
      ),
    ).toBe(true);
  });

  it('riconosce anche la forma con i delimitatori', () => {
    expect(contieneChiamataAStrumento('<|tool_calls|>ricerca{}')).toBe(true);
  });

  /** Non è un rifiuto: sono due diagnosi diverse con due rimedi diversi. */
  it('non lo confonde con un rifiuto', () => {
    expect(contieneRifiuto('[TOOL_CALLS]fs_read{}')).toBe(false);
  });

  it('un workflow normale non lo fa scattare', () => {
    expect(contieneChiamataAStrumento('{"name":"Pulizia log","nodes":[]}')).toBe(false);
  });

  /**
   * Il messaggio deve togliere la colpa a chi ha scritto l'obiettivo: è la
   * differenza fra riscrivere dieci volte la stessa frase e cambiare modello.
   */
  it('dice che non dipende da come è scritto l’obiettivo', () => {
    expect(messaggioChiamataAStrumento()).toContain('Non dipende da come hai scritto');
  });
});
