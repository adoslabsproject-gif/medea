// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  cartellaScelta,
  comandiNoti,
  dimenticaSessione,
  modelloScelto,
  ricordaComandi,
  ricordaSessione,
  scegliCartella,
  scegliModello,
  sessioneDi,
} from './settings';

beforeEach(() => {
  localStorage.clear();
});

describe('il modello', () => {
  it('senza una scelta decide Claude Code', () => {
    expect(modelloScelto()).toBe('default');
  });

  it('la scelta resta, e un valore sconosciuto vale come nessuna scelta', () => {
    scegliModello('opus');
    expect(modelloScelto()).toBe('opus');
    localStorage.setItem('medea.ai.claudeCode.modello', 'modello-dismesso');
    expect(modelloScelto()).toBe('default');
  });

  it('tornare al predefinito toglie la scelta', () => {
    scegliModello('haiku');
    scegliModello('default');
    expect(localStorage.getItem('medea.ai.claudeCode.modello')).toBeNull();
  });
});

describe('la cartella di lavoro', () => {
  it('senza una scelta non ce n’è una: si usa quella vuota di Medea', () => {
    expect(cartellaScelta()).toBeNull();
  });

  it('si sceglie e si toglie', () => {
    scegliCartella('  /Users/anna/progetto  ');
    expect(cartellaScelta()).toBe('/Users/anna/progetto');
    scegliCartella(null);
    expect(cartellaScelta()).toBeNull();
    scegliCartella('   ');
    expect(cartellaScelta()).toBeNull();
  });
});

describe('la sessione di una conversazione', () => {
  it('una conversazione nuova non ha una sessione da riprendere', () => {
    expect(sessioneDi('conv-1')).toBeNull();
    expect(sessioneDi(null)).toBeNull();
  });

  it('dopo un turno la conversazione riprende la sua sessione', () => {
    ricordaSessione('conv-1', 'sess-a');
    ricordaSessione('conv-2', 'sess-b');
    expect(sessioneDi('conv-1')).toBe('sess-a');
    expect(sessioneDi('conv-2')).toBe('sess-b');
  });

  it('un turno successivo aggiorna la sessione invece di accumularne', () => {
    ricordaSessione('conv-1', 'sess-a');
    ricordaSessione('conv-1', 'sess-nuova');
    expect(sessioneDi('conv-1')).toBe('sess-nuova');
    expect(JSON.parse(localStorage.getItem('medea.ai.claudeCode.sessioni') ?? '[]')).toHaveLength(
      1,
    );
  });

  /**
   * La CLI tiene le sessioni cartella per cartella. Riprendere da un'altra
   * cartella fallirebbe, e sarebbe comunque un altro lavoro.
   */
  it('cambiando cartella la conversazione ricomincia, e tornando indietro riprende', () => {
    scegliCartella('/progetto-a');
    ricordaSessione('conv-1', 'sess-a');
    scegliCartella('/progetto-b');
    expect(sessioneDi('conv-1')).toBeNull();
    scegliCartella('/progetto-a');
    expect(sessioneDi('conv-1')).toBe('sess-a');
  });

  it('una sessione dimenticata non si riprende più', () => {
    ricordaSessione('conv-1', 'sess-a');
    dimenticaSessione('conv-1');
    expect(sessioneDi('conv-1')).toBeNull();
  });

  it('un archivio rovinato vale come vuoto', () => {
    localStorage.setItem('medea.ai.claudeCode.sessioni', '{non json');
    expect(sessioneDi('conv-1')).toBeNull();
    localStorage.setItem('medea.ai.claudeCode.sessioni', '[["solo-uno"], 5, ["a", 7]]');
    expect(sessioneDi('a')).toBeNull();
  });

  it('non cresce senza limite', () => {
    for (let i = 0; i < 230; i++) ricordaSessione(`conv-${String(i)}`, `s-${String(i)}`);
    expect(sessioneDi('conv-0')).toBeNull();
    expect(sessioneDi('conv-229')).toBe('s-229');
  });
});

describe('i comandi con la barra', () => {
  it('si ricordano quelli dichiarati dalla CLI', () => {
    expect(comandiNoti()).toEqual([]);
    ricordaComandi(['compact', 'context']);
    expect(comandiNoti()).toEqual(['compact', 'context']);
  });

  it('un elenco vuoto non cancella quello che si sapeva', () => {
    ricordaComandi(['compact']);
    ricordaComandi([]);
    expect(comandiNoti()).toEqual(['compact']);
  });
});
