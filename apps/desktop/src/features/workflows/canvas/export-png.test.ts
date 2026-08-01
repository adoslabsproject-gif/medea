import { describe, expect, it } from 'vitest';

import type { CanvasNode } from '../types';

import { bounds } from './export-png';

function nodo(x: number, y: number): CanvasNode {
  return { id: `n${String(x)}`, defId: 'action_http', x, y, config: {} };
}

describe('l’area del disegno', () => {
  it('racchiude tutti i nodi', () => {
    const area = bounds([nodo(0, 0), nodo(300, 200)]);
    expect(area.width).toBeGreaterThan(300);
    expect(area.height).toBeGreaterThan(200);
  });

  it('lascia respiro attorno: un diagramma che tocca il bordo si legge peggio', () => {
    const area = bounds([nodo(100, 100)]);
    expect(area.minX).toBeLessThan(100);
    expect(area.minY).toBeLessThan(100);
  });

  it('gestisce le coordinate negative', () => {
    // Trascinando a sinistra si finisce sotto zero, ed è normale.
    const area = bounds([nodo(-500, -300), nodo(0, 0)]);
    expect(area.minX).toBeLessThan(-500);
    expect(area.width).toBeGreaterThan(500);
  });

  it('un disegno vuoto ha comunque una dimensione', () => {
    // Un canvas 0×0 non produce nessun PNG, e il tasto sembrerebbe rotto.
    const area = bounds([]);
    expect(area.width).toBeGreaterThan(0);
    expect(area.height).toBeGreaterThan(0);
  });
});
