import { describe, expect, it } from 'vitest';

import type { CanvasNode, Workflow } from '../types';

import { missingTables, planTables } from './table-plan';

function node(defId: string, config: Record<string, unknown>): CanvasNode {
  return { id: `${defId}_1`, defId, x: 0, y: 0, config };
}

function workflow(...nodes: CanvasNode[]): Pick<Workflow, 'nodes'> {
  return { nodes };
}

describe('il piano delle tabelle', () => {
  it('non chiede niente se nessun nodo tocca un database', () => {
    expect(planTables(workflow(node('action_send_email', { to: 'a@b.it' })))).toEqual([]);
  });

  it('ricava le colonne dai valori che il nodo scrive', () => {
    const plan = planTables(
      workflow(
        node('db_insert', { table: 'seguiti', rowJson: { mittente: 'a@b.it', letto: false } }),
      ),
    );
    expect(plan).toEqual([
      {
        name: 'seguiti',
        columns: [
          { name: 'id', type: 'text' },
          { name: 'mittente', type: 'text' },
          { name: 'letto', type: 'boolean' },
        ],
      },
    ]);
  });

  it('mette sempre una chiave: senza, una riga non si aggiorna né si cancella', () => {
    const plan = planTables(
      workflow(node('db_insert', { table: 'note', rowJson: { testo: 'x' } })),
    );
    expect(plan[0]?.columns[0]).toEqual({ name: 'id', type: 'text' });
  });

  it('legge anche una mappa arrivata come testo', () => {
    // I campi chiave-valore si salvano serializzati: se non si leggessero,
    // il piano sarebbe vuoto proprio nei workflow salvati.
    const plan = planTables(
      workflow(node('db_insert', { table: 'note', rowJson: '{"testo":"x","peso":3}' })),
    );
    expect(plan[0]?.columns.map((c) => c.name)).toEqual(['id', 'testo', 'peso']);
    expect(plan[0]?.columns.find((c) => c.name === 'peso')?.type).toBe('integer');
  });

  it('un’espressione diventa testo: il tipo non si può indovinare', () => {
    const plan = planTables(
      workflow(node('db_insert', { table: 'note', rowJson: { quando: '{{ $now }}' } })),
    );
    expect(plan[0]?.columns.find((c) => c.name === 'quando')?.type).toBe('text');
  });

  it('unisce le colonne nominate da nodi diversi sulla stessa tabella', () => {
    const plan = planTables(
      workflow(
        node('db_insert', { table: 'seguiti', rowJson: { mittente: 'a' } }),
        node('db_update', {
          table: 'seguiti',
          whereJson: { id: 'x' },
          patchJson: { chiuso: true },
        }),
      ),
    );
    expect(plan[0]?.columns.map((c) => c.name)).toEqual(['id', 'mittente', 'chiuso']);
  });

  it('il primo che nomina una colonna decide il tipo', () => {
    // Un `where` con un numero non deve trasformare in intero una colonna
    // già dichiarata testo dall'inserimento.
    const plan = planTables(
      workflow(
        node('db_insert', { table: 't', rowJson: { codice: 'AB12' } }),
        node('db_query', { table: 't', filtersJson: { codice: 7 } }),
      ),
    );
    expect(plan[0]?.columns.find((c) => c.name === 'codice')?.type).toBe('text');
  });

  it('scarta i nomi che non sono identificatori sicuri', () => {
    // Quello che finisce in una DDL non passa da nessun altro filtro.
    const plan = planTables(
      workflow(node('db_insert', { table: 'note; DROP TABLE x', rowJson: { a: 1 } })),
    );
    expect(plan).toEqual([]);
  });

  it('scarta le colonne con un nome non utilizzabile', () => {
    const plan = planTables(
      workflow(node('db_insert', { table: 'note', rowJson: { 'a b': 1, valida: 2 } })),
    );
    expect(plan[0]?.columns.map((c) => c.name)).toEqual(['id', 'valida']);
  });

  it('non si ferma su una mappa scritta male', () => {
    const plan = planTables(workflow(node('db_insert', { table: 'note', rowJson: 'non json' })));
    expect(plan[0]?.columns.map((c) => c.name)).toEqual(['id']);
  });
});

describe('quelle che mancano', () => {
  it('esclude le tabelle già esistenti, senza badare alle maiuscole', () => {
    const piano = [
      { name: 'seguiti', columns: [] },
      { name: 'note', columns: [] },
    ];
    expect(missingTables(piano, ['NOTE']).map((t) => t.name)).toEqual(['seguiti']);
  });
});
