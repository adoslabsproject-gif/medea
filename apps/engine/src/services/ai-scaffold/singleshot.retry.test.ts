/**
 * I tentativi previsti si usano tutti, e il motivo che si racconta è quello
 * utile.
 *
 * Il 2026-08-06, con l'obiettivo «ogni primo del mese cancella dalla tabella
 * log le righe più vecchie di novanta giorni»:
 *
 *   tentativo 1 → il quality gate rifiuta: la tabella «log» non esiste
 *   tentativo 2 → il modello risponde qualcosa che non è JSON
 *   → «exhausted retries» con attempts: 2, max: 3
 *
 * Due difetti in tre righe di log. Il terzo tentativo, previsto e pagato, non
 * è stato usato: un output illeggibile non era fra i casi da riprovare, ed è
 * il più transitorio che ci sia. E all'utente è arrivato «output senza un
 * oggetto JSON valido» — vero, ma di un tentativo intermedio: il motivo vero
 * stava nel primo e si era perso.
 *
 * @module services/ai-scaffold/singleshot.retry.test
 */

import { describe, expect, it } from 'vitest';

import { AiScaffoldError } from '@/services/ai-scaffold/types.js';
import { motivoPiuUtile } from '@/services/ai-scaffold/singleshot.service.js';

const gate = new AiScaffoldError(
  'Workflow rejected — quality gate: la tabella «log» non esiste',
  502,
);
const illeggibile = new AiScaffoldError(
  'Output del modello non conforme allo schema: output senza un oggetto JSON valido',
  502,
);
const validazione = new AiScaffoldError('Workflow generato con 1 errori di validazione', 502);
const rete = new AiScaffoldError('fetch failed', 502);

describe('quale motivo si racconta all’utente', () => {
  /** Il caso vero: gate al primo giro, JSON rotto al secondo. */
  it('preferisce il rifiuto del gate a un output illeggibile arrivato dopo', () => {
    expect(motivoPiuUtile(gate, illeggibile)).toBe(gate);
  });

  it('preferisce un errore di validazione a un output illeggibile', () => {
    expect(motivoPiuUtile(validazione, illeggibile)).toBe(validazione);
  });

  /** Se l'ultimo è già quello utile, resta l'ultimo: è il più aggiornato. */
  it('tiene l’ultimo quando è già sostanziale', () => {
    expect(motivoPiuUtile(illeggibile, gate)).toBe(gate);
  });

  it('senza un precedente utile tiene l’ultimo', () => {
    expect(motivoPiuUtile(null, illeggibile)).toBe(illeggibile);
    expect(motivoPiuUtile(rete, illeggibile)).toBe(illeggibile);
  });

  /**
   * Un guasto d'ambiente NON va mascherato da un vecchio rifiuto del gate.
   *
   * «fetch failed» manda a guardare la rete, ed è lì che bisogna guardare:
   * mostrare al suo posto «la tabella log non esiste» manderebbe a sistemare
   * una tabella mentre il problema è che non si parla con nessuno. La
   * sostituzione vale solo per un inciampo del modello, non per un guasto.
   */
  it('non nasconde un guasto d’ambiente dietro un vecchio rifiuto', () => {
    expect(motivoPiuUtile(gate, rete)).toBe(rete);
  });
});
