/**
 * Le operazioni sul grafo sono quello che l'utente fa davvero: inserire un
 * nodo in mezzo, staccare un collegamento, accendere il fan-out. Un errore
 * qui non si vede subito — si vede quando il workflow gira e i dati vanno
 * dalla parte sbagliata.
 */

import { describe, expect, it } from 'vitest';

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import {
  addEdge,
  dropEdge,
  dropNode,
  edgeId,
  insertBetween,
  sameEdge,
  setMapMode,
  uniqueNodeId,
} from './graph-ops';

const node = (id: string, defId = 'action_http'): CanvasNode => ({
  id,
  defId,
  x: 0,
  y: 0,
  config: {},
});

const wf = (nodes: CanvasNode[], edges: WorkflowEdge[]): Workflow => ({
  name: 'x',
  nodes,
  edges,
  executionTarget: 'local',
});

describe('identità di un collegamento', () => {
  it('due collegamenti fra gli stessi nodi ma da rami diversi sono diversi', () => {
    expect(sameEdge({ from: 'a', to: 'b', fromPort: 'true' }, { from: 'a', to: 'b' })).toBe(false);
  });

  it('un ramo assente e uno vuoto sono la stessa cosa', () => {
    expect(sameEdge({ from: 'a', to: 'b' }, { from: 'a', to: 'b', fromPort: '' })).toBe(true);
  });
});

describe('inserire un nodo in mezzo', () => {
  const base = wf([node('a'), node('b')], [{ from: 'a', to: 'b' }]);

  it('spezza il collegamento in due invece di aggiungerne uno terzo', () => {
    const next = insertBetween(base, { from: 'a', to: 'b' }, node('mezzo'));
    expect(next.edges).toEqual([
      { from: 'a', to: 'mezzo' },
      { from: 'mezzo', to: 'b' },
    ]);
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'b', 'mezzo']);
  });

  it('il ramo di partenza resta sul primo tratto', () => {
    const branched = wf(
      [node('if', 'logic_if'), node('b')],
      [{ from: 'if', to: 'b', fromPort: 'true' }],
    );
    const next = insertBetween(branched, { from: 'if', to: 'b', fromPort: 'true' }, node('mezzo'));
    expect(next.edges).toEqual([
      { from: 'if', to: 'mezzo', fromPort: 'true' },
      { from: 'mezzo', to: 'b' },
    ]);
  });

  it('non tocca gli altri collegamenti', () => {
    const wider = wf(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    );
    const next = insertBetween(wider, { from: 'a', to: 'b' }, node('mezzo'));
    expect(next.edges).toContainEqual({ from: 'a', to: 'c' });
  });
});

describe('togliere', () => {
  it('un nodo si porta via tutto ciò che entra e esce da lui', () => {
    const base = wf(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    const next = dropNode(base, 'b');
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(next.edges).toEqual([]);
  });

  it('un collegamento sparisce senza toccare i nodi', () => {
    const base = wf([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    const next = dropEdge(base, { from: 'a', to: 'b' });
    expect(next.edges).toEqual([]);
    expect(next.nodes).toHaveLength(2);
  });
});

describe('collegare', () => {
  const base = wf([node('a'), node('b')], []);

  it('rifiuta il collegamento di un nodo a sé stesso', () => {
    expect(addEdge(base, { from: 'a', to: 'a' }).edges).toEqual([]);
  });

  it('non crea un doppione', () => {
    const once = addEdge(base, { from: 'a', to: 'b' });
    expect(addEdge(once, { from: 'a', to: 'b' }).edges).toHaveLength(1);
  });

  it('ammette due collegamenti fra gli stessi nodi da rami diversi', () => {
    const first = addEdge(base, { from: 'a', to: 'b', fromPort: 'true' });
    expect(addEdge(first, { from: 'a', to: 'b', fromPort: 'false' }).edges).toHaveLength(2);
  });
});

describe('fan-out sul collegamento', () => {
  const base = wf([node('a'), node('b')], [{ from: 'a', to: 'b' }]);

  it('accende la modalità', () => {
    expect(setMapMode(base, { from: 'a', to: 'b' }, 'each').edges[0]).toEqual({
      from: 'a',
      to: 'b',
      mapMode: 'each',
    });
  });

  it('spegnerla toglie il campo invece di lasciarlo indefinito', () => {
    const on = setMapMode(base, { from: 'a', to: 'b' }, 'auto');
    const off = setMapMode(on, { from: 'a', to: 'b' }, 'off');
    expect(off.edges[0]).toEqual({ from: 'a', to: 'b' });
    expect('mapMode' in (off.edges[0] ?? {})).toBe(false);
  });
});

describe('identificativi', () => {
  it('il primo nodo di un tipo prende il nome del tipo', () => {
    expect(uniqueNodeId('action_http', [])).toBe('action_http');
  });

  it('i successivi si numerano', () => {
    const nodes = [node('action_http'), node('action_http_2')];
    expect(uniqueNodeId('action_http', nodes)).toBe('action_http_3');
  });

  it('un defId senza lettere utili non produce un id vuoto', () => {
    expect(uniqueNodeId('---', [])).toBe('nodo');
  });

  it('due collegamenti fra gli stessi nodi hanno id diversi', () => {
    const a: WorkflowEdge = { from: 'x', to: 'y', fromPort: 'true' };
    const b: WorkflowEdge = { from: 'x', to: 'y', fromPort: 'false' };
    expect(edgeId(a, 0)).not.toBe(edgeId(b, 1));
  });
});
