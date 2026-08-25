/**
 * Una conferma umana non è un campo dimenticato.
 *
 * `db_delete.confirmDelete` è una spunta obbligatoria che dice «so che questo
 * cancella dei dati». Il 2026-08-06 l'obiettivo «ogni primo del mese cancella
 * dalla tabella log le righe più vecchie di novanta giorni» ha bruciato tre
 * tentativi e si è arreso proprio lì, con tutto il resto già a posto: al
 * modello si chiedeva un consenso che non ha il diritto di dare, e nessuna
 * riscrittura dell'obiettivo avrebbe potuto cambiarlo.
 *
 * Il workflow ora arriva all'editor, e lì la conferma la si chiede a chi
 * legge — bloccando l'attivazione finché non c'è.
 *
 * @module features/workflows/quality/rules-consenso.test
 */

import { describe, expect, it } from 'vitest';

import { checkCampiObbligatori } from './rules-campi';
import type { QualityGateInput, QualityNodeDef } from './types';

const DEFS = new Map<string, QualityNodeDef>([
  [
    'db_delete',
    {
      type: 'action',
      configFields: [
        { key: 'databaseId', label: 'Database', required: true },
        { key: 'table', label: 'Tabella', required: true },
        { key: 'whereJson', label: 'Righe da eliminare (WHERE)', required: true },
        { key: 'confirmDelete', label: 'Confermo che è distruttiva', required: true },
      ],
    },
  ],
]);

const con = (config: Record<string, unknown>): QualityGateInput => ({
  nodes: [{ id: 'purga', defId: 'db_delete', config }],
  edges: [],
  defs: DEFS,
});

describe('la conferma si chiede a chi legge, non al modello', () => {
  it('la segnala a parte, e blocca l’attivazione', () => {
    const issues = checkCampiObbligatori(
      con({ databaseId: '__USE_PICKER__', table: 'log', whereJson: '{"a":1}' }),
    );
    const consenso = issues.find((i) => i.code === 'CONSENSO_MANCANTE');
    expect(consenso?.severity).toBe('critical');
    expect(consenso?.message).toContain('Nessuno può darla al posto tuo');
  });

  it('spuntata, non protesta più', () => {
    const issues = checkCampiObbligatori(
      con({
        databaseId: '__USE_PICKER__',
        table: 'log',
        whereJson: '{"a":1}',
        confirmDelete: true,
      }),
    );
    expect(issues).toEqual([]);
  });

  /**
   * Non deve mangiarsi le altre mancanze: un `whereJson` vuoto su una
   * cancellazione è un difetto vero, e va detto insieme alla conferma.
   */
  it('non nasconde i campi davvero mancanti', () => {
    const issues = checkCampiObbligatori(con({ databaseId: '__USE_PICKER__', table: 'log' }));
    const codici = issues.map((i) => i.code).sort();
    expect(codici).toEqual(['CAMPO_OBBLIGATORIO_VUOTO', 'CONSENSO_MANCANTE']);
    expect(issues.find((i) => i.code === 'CAMPO_OBBLIGATORIO_VUOTO')?.message).toContain('WHERE');
  });
});
