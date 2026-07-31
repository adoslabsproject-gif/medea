/**
 * L'import è la porta da cui entra roba scritta da altri: dal server, da un
 * file modificato a mano, da una versione futura del formato. Deve accettare
 * quello che è davvero un workflow e rifiutare il resto con un motivo
 * leggibile — un documento importato a metà è peggio di un rifiuto.
 */

import { describe, expect, it } from 'vitest';

import type { Workflow } from '../types';

import { exportFileName, fromImportJson, toExportJson, WorkflowImportError } from './io';

const wf: Workflow = {
  id: '7',
  name: 'Controllo giornaliero',
  nodes: [
    { id: 'cron', defId: 'trigger_cron', x: 80, y: 80, config: { cronExpression: '0 9 * * *' } },
    { id: 'http', defId: 'action_http', x: 360, y: 80, config: { url: 'https://reale.it' } },
  ],
  edges: [{ from: 'cron', to: 'http' }],
  executionTarget: 'local',
};

describe('esportazione', () => {
  it('non porta fuori l’identificativo locale', () => {
    const parsed = JSON.parse(toExportJson(wf)) as Record<string, unknown>;
    expect(parsed.id).toBeUndefined();
    expect(parsed.name).toBe('Controllo giornaliero');
  });

  it('propone un nome file leggibile', () => {
    expect(exportFileName(wf)).toBe('controllo-giornaliero.json');
    expect(exportFileName({ ...wf, name: '   ' })).toBe('workflow.json');
  });
});

describe('andata e ritorno', () => {
  it('un workflow esportato si reimporta identico', () => {
    const back = fromImportJson(toExportJson(wf));
    expect(back.nodes).toEqual(wf.nodes);
    expect(back.edges).toEqual(wf.edges);
    expect(back.executionTarget).toBe('local');
  });
});

describe('documenti scritti da altri', () => {
  it('accetta i collegamenti nella forma source/target del canvas', () => {
    const imported = fromImportJson(
      JSON.stringify({
        name: 'Dal server',
        nodes: [{ id: 'a', defId: 'trigger_cron' }],
        edges: [{ source: 'a', target: 'b', fromPort: 'true' }],
      }),
    );
    expect(imported.edges).toEqual([{ from: 'a', to: 'b', fromPort: 'true' }]);
  });

  it('accetta `name` del server come etichetta del nodo', () => {
    const imported = fromImportJson(
      JSON.stringify({
        name: 'x',
        nodes: [{ id: 'a', defId: 'action_http', name: 'Chiamata al gestionale' }],
      }),
    );
    expect(imported.nodes[0]?.label).toBe('Chiamata al gestionale');
  });

  it('mette a zero le posizioni mancanti invece di lasciarle indefinite', () => {
    const imported = fromImportJson(
      JSON.stringify({ name: 'x', nodes: [{ id: 'a', defId: 'trigger_cron' }] }),
    );
    expect(imported.nodes[0]).toMatchObject({ x: 0, y: 0, config: {} });
  });

  it('un file che non è JSON viene rifiutato con un motivo', () => {
    expect(() => fromImportJson('non sono json')).toThrow(WorkflowImportError);
    expect(() => fromImportJson('non sono json')).toThrow(/JSON valido/);
  });

  it('un nodo senza defId ferma tutto: meglio niente che un documento monco', () => {
    expect(() => fromImportJson(JSON.stringify({ name: 'x', nodes: [{ id: 'a' }] }))).toThrow(
      /id o defId/,
    );
  });

  it('un JSON che non è un workflow viene rifiutato', () => {
    expect(() => fromImportJson('[1,2,3]')).toThrow(/non contiene un workflow/);
    expect(() => fromImportJson('{"name":"x"}')).toThrow(/elenco dei nodi/);
  });

  it('una destinazione sconosciuta ricade sull’esecuzione locale', () => {
    const imported = fromImportJson(
      JSON.stringify({ name: 'x', nodes: [], executionTarget: 'cloud' }),
    );
    expect(imported.executionTarget).toBe('local');
  });
});
