/**
 * Copiare un nodo serve a riusarne la configurazione, che è la parte che
 * costa tempo. Questi test guardano le due cose che possono rompersi in
 * silenzio: gli id che collidono, e i collegamenti che si perdono.
 */

import { describe, expect, it } from 'vitest';

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import { copySelection, duplicateNodes, paste } from './clipboard';

const node = (id: string, config: Record<string, unknown> = {}): CanvasNode => ({
  id,
  defId: 'action_http',
  x: 100,
  y: 100,
  config,
});

const wf = (nodes: CanvasNode[], edges: WorkflowEdge[] = []): Workflow => ({
  name: 'x',
  nodes,
  edges,
  executionTarget: 'local',
});

describe('copiare', () => {
  it('porta con sé la configurazione, che è il motivo per cui si copia', () => {
    const clip = copySelection(wf([node('a', { url: 'https://reale.it', method: 'POST' })]), ['a']);
    expect(clip?.nodes[0]?.config).toEqual({ url: 'https://reale.it', method: 'POST' });
  });

  it('prende i collegamenti INTERNI alla selezione, non quelli che escono', () => {
    const base = wf(
      [node('a'), node('b'), node('fuori')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'fuori' },
      ],
    );
    const clip = copySelection(base, ['a', 'b']);
    expect(clip?.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('copiare niente non produce appunti vuoti da incollare', () => {
    expect(copySelection(wf([node('a')]), [])).toBeNull();
  });

  it('la copia è staccata dall’originale', () => {
    const base = wf([node('a', { url: 'prima' })]);
    const clip = copySelection(base, ['a']);
    if (clip?.nodes[0]) clip.nodes[0].config.url = 'dopo';
    expect(base.nodes[0]?.config.url).toBe('prima');
  });
});

describe('incollare', () => {
  it('rigenera gli id: due nodi non possono chiamarsi allo stesso modo', () => {
    const base = wf([node('action_http')]);
    const clip = copySelection(base, ['action_http']);
    const result = paste(base, clip!);
    expect(result.workflow.nodes).toHaveLength(2);
    expect(new Set(result.workflow.nodes.map((n) => n.id)).size).toBe(2);
  });

  it('due copie di seguito non collidono fra loro', () => {
    const base = wf([node('action_http')]);
    const clip = copySelection(base, ['action_http']);
    const once = paste(base, clip!);
    const twice = paste(once.workflow, clip!);
    expect(new Set(twice.workflow.nodes.map((n) => n.id)).size).toBe(3);
  });

  it('ricostruisce i collegamenti sui nuovi id', () => {
    const base = wf([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    const clip = copySelection(base, ['a', 'b']);
    const result = paste(base, clip!);
    const nuovi = new Set(result.newIds);
    const ricostruito = result.workflow.edges.find((e) => nuovi.has(e.from) && nuovi.has(e.to));
    expect(ricostruito).toBeDefined();
    // Il collegamento originale resta dov'era.
    expect(result.workflow.edges).toContainEqual({ from: 'a', to: 'b' });
  });

  it('sposta la copia invece di appoggiarla sopra l’originale', () => {
    const base = wf([node('a')]);
    const clip = copySelection(base, ['a']);
    const result = paste(base, clip!);
    const copia = result.workflow.nodes[1];
    expect(copia?.x).toBeGreaterThan(100);
    expect(copia?.y).toBeGreaterThan(100);
  });
});

describe('duplicare', () => {
  it('è copiare e incollare in un colpo solo', () => {
    const result = duplicateNodes(wf([node('a', { url: 'x' })]), ['a']);
    expect(result?.workflow.nodes).toHaveLength(2);
    expect(result?.workflow.nodes[1]?.config).toEqual({ url: 'x' });
  });

  it('duplicare niente non fa niente', () => {
    expect(duplicateNodes(wf([node('a')]), [])).toBeNull();
  });
});
