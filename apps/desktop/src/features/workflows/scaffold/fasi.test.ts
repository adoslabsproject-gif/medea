import { describe, expect, it } from 'vitest';

import { avanzamento, ETICHETTA_FASE, FASI, faseCorrente } from './fasi';

describe('a che punto è la costruzione', () => {
  it('senza aver fatto niente, sta ancora leggendo la richiesta', () => {
    expect(faseCorrente([])).toBe('capire');
  });

  it('segue il lavoro mentre avanza', () => {
    expect(faseCorrente(['search_nodes'])).toBe('scegliere');
    expect(faseCorrente(['search_nodes', 'add_node'])).toBe('montare');
    expect(faseCorrente(['search_nodes', 'add_node', 'connect'])).toBe('collegare');
    expect(faseCorrente(['add_node', 'connect', 'validate_workflow'])).toBe('verificare');
  });

  it('🚨 tornare indietro a sistemare un campo non riporta indietro la fase', () => {
    // Dopo aver validato, l'agente corregge un campo: sta rifinendo, non
    // ricominciando. Mostrare «compilo i campi» dopo «controllo che funzioni»
    // darebbe l'impressione di un lavoro che non arriva da nessuna parte.
    const fase = faseCorrente(['add_node', 'connect', 'validate_workflow', 'set_config']);
    expect(fase).toBe('verificare');
  });

  it('gli strumenti che non conosce non spostano la fase', () => {
    expect(faseCorrente(['add_node', 'strumento_inventato'])).toBe('montare');
  });

  it("l'avanzamento cresce lungo le fasi e arriva a uno", () => {
    expect(avanzamento([])).toBeLessThan(avanzamento(['add_node']));
    expect(avanzamento(['add_node'])).toBeLessThan(avanzamento(['validate_workflow']));
    expect(avanzamento(['finish'])).toBe(1);
  });

  it('ogni fase ha una frase che si legge', () => {
    for (const fase of FASI) {
      expect(ETICHETTA_FASE[fase], `manca l’etichetta di «${fase}»`).toBeTruthy();
    }
  });
});
