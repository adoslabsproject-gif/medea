/**
 * Il riordino automatico è quello che rende leggibile un workflow appena
 * generato. Non deve essere perfetto, deve essere prevedibile: il flusso da
 * sinistra a destra, i rami aperti in verticale, e lo stesso documento sempre
 * disegnato uguale.
 */

import { describe, expect, it } from 'vitest';

import type { CanvasNode, WorkflowEdge } from '../types';

import { autoLayout, computeDepths, needsLayout, nextFreeSpot } from './layout';

const node = (id: string): CanvasNode => ({ id, defId: 'action_http', x: 0, y: 0, config: {} });

describe('profondità nel flusso', () => {
  it('conta i passi dal punto di partenza', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const depth = computeDepths(nodes, edges);
    expect([depth.get('a'), depth.get('b'), depth.get('c')]).toEqual([0, 1, 2]);
  });

  it('non gira all’infinito su un anello', () => {
    const nodes = [node('a'), node('b')];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(() => computeDepths(nodes, edges)).not.toThrow();
  });
});

describe('riordino', () => {
  it('dispone il flusso da sinistra a destra', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const placed = autoLayout(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    const x = new Map(placed.map((n) => [n.id, n.x]));
    expect(x.get('a')).toBeLessThan(x.get('b') ?? 0);
    expect(x.get('b')).toBeLessThan(x.get('c') ?? 0);
  });

  it('apre i rami in verticale, sulla stessa colonna', () => {
    const nodes = [node('if'), node('si'), node('no')];
    const placed = autoLayout(nodes, [
      { from: 'if', to: 'si', fromPort: 'true' },
      { from: 'if', to: 'no', fromPort: 'false' },
    ]);
    const si = placed.find((n) => n.id === 'si');
    const no = placed.find((n) => n.id === 'no');
    expect(si?.x).toBe(no?.x);
    expect(si?.y).not.toBe(no?.y);
  });

  it('non sovrappone due nodi', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(node);
    const placed = autoLayout(nodes, [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' },
    ]);
    const spots = new Set(placed.map((n) => `${String(n.x)},${String(n.y)}`));
    expect(spots.size).toBe(placed.length);
  });

  it('dà sempre lo stesso risultato per lo stesso workflow', () => {
    const nodes = [node('a'), node('b')];
    const edges: WorkflowEdge[] = [{ from: 'a', to: 'b' }];
    expect(autoLayout(nodes, edges)).toEqual(autoLayout(nodes, edges));
  });

  it('regge un workflow vuoto e uno senza collegamenti', () => {
    expect(autoLayout([], [])).toEqual([]);
    expect(autoLayout([node('solo')], [])).toHaveLength(1);
  });
});

describe('quando serve riordinare', () => {
  it('riconosce i nodi arrivati tutti nello stesso punto', () => {
    expect(needsLayout([node('a'), node('b')])).toBe(true);
  });

  it('lascia stare un workflow già disposto', () => {
    expect(needsLayout([node('a'), { ...node('b'), x: 300, y: 40 }])).toBe(false);
  });

  it('un nodo solo non ha bisogno di niente', () => {
    expect(needsLayout([node('a')])).toBe(false);
  });
});

describe('dove appoggiare un nodo nuovo', () => {
  it('parte dall’origine quando il canvas è vuoto', () => {
    expect(nextFreeSpot([])).toEqual({ x: 80, y: 80 });
  });

  it('scende sotto l’ultimo invece di sovrapporsi', () => {
    const spot = nextFreeSpot([{ ...node('a'), x: 300, y: 100 }]);
    expect(spot.x).toBe(300);
    expect(spot.y).toBeGreaterThan(100);
  });
});
