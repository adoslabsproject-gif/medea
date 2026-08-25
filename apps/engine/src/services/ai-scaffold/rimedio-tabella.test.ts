/**
 * Il rimedio deve nominare uno strumento che chi legge POSSIEDE.
 *
 * Il 2026-08-06, con l'obiettivo «ogni primo del mese cancella dalla tabella
 * log le righe più vecchie di novanta giorni», il gate rifiutava così:
 *
 *   «Scegli una tabella esistente OPPURE crea prima la tabella via create_table.»
 *
 * `create_table` è uno strumento del percorso ad AGENTE. Nel percorso a
 * scrittura unica — quello che il wizard usa per primo — non esiste: le tabelle
 * si dichiarano in `tablesToCreate` dentro il JSON. Il modello riceveva
 * un'istruzione ineseguibile, i tre tentativi si consumavano tutti sullo stesso
 * muro, e il wizard falliva senza che nessuno potesse farci niente.
 *
 * @module services/ai-scaffold/rimedio-tabella.test
 */

import { describe, expect, it } from 'vitest';

import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';
import { SINGLESHOT_SYSTEM_PROMPT } from '@/services/ai-scaffold/prompt.js';

const cancellaDaLog = {
  nodes: [
    { id: 'cron', defId: 'trigger_cron', config: { cronExpression: '0 0 1 * *' } },
    {
      id: 'db_delete',
      defId: 'db_delete',
      config: { databaseId: 'db1', table: 'log', whereJson: '{"before":"x"}' },
    },
  ],
  edges: [{ from: 'cron', to: 'db_delete' }],
  databases: [{ id: 'db1', tables: ['inbox', 'ordini'] }],
};

describe('il rimedio che il gate propone', () => {
  it('nomina `tablesToCreate`, che nel percorso a scrittura unica esiste', () => {
    const issue = runQualityGate(cancellaDaLog).issues.find(
      (i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA',
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('tablesToCreate');
  });

  /** Dichiarata, la tabella non è più un problema: è il giro che deve chiudersi. */
  it('dichiarare la tabella fa passare il controllo', () => {
    const conLog = {
      ...cancellaDaLog,
      databases: [{ id: 'db1', tables: ['inbox', 'ordini', 'log'] }],
    };
    expect(
      runQualityGate(conLog).issues.some((i) => i.code === 'DB_TABLE_NOT_IN_SCHEMA'),
    ).toBe(false);
  });
});

describe('il prompt copre anche chi la tabella la legge e la cancella', () => {
  /**
   * La regola diceva «se il goal richiede SALVARE in tabella che non esiste».
   * Un goal che cancella non salva niente, e il modello non si sentiva
   * chiamato in causa.
   */
  it('non parla solo di chi ci scrive', () => {
    expect(SINGLESHOT_SYSTEM_PROMPT).toContain('QUALUNQUE nodo che nomina la tabella');
  });

  it('nomina i nodi che leggono e cancellano', () => {
    for (const nodo of ['db_query', 'db_update', 'db_delete']) {
      expect(SINGLESHOT_SYSTEM_PROMPT).toContain(nodo);
    }
  });
});
