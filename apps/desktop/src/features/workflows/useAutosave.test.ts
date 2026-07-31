/**
 * Il salvataggio automatico ha due modi di sbagliare, entrambi gravi: non
 * salvare (si perde il lavoro) e salvare troppo (si scrive sul disco venti
 * volte per un nome di nodo). Questi test guardano la regola che decide
 * *quando* vale la pena scrivere.
 */

import { describe, expect, it } from 'vitest';

import type { Workflow } from './types';
import { worthSaving } from './useAutosave';

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  name: 'Nuovo workflow',
  nodes: [],
  edges: [],
  executionTarget: 'local',
  ...over,
});

describe('quando vale la pena salvare', () => {
  it('un documento vuoto e mai salvato non crea una riga', () => {
    expect(worthSaving(wf())).toBe(false);
  });

  it('appena c’è un nodo, si salva', () => {
    expect(
      worthSaving(wf({ nodes: [{ id: 'a', defId: 'trigger_cron', x: 0, y: 0, config: {} }] })),
    ).toBe(true);
  });

  it('un workflow già salvato si continua a salvare anche se lo si svuota', () => {
    // Svuotare un workflow esistente è una modifica come un'altra: se non si
    // salvasse, riaprendolo tornerebbero i nodi appena cancellati.
    expect(worthSaving(wf({ id: '7' }))).toBe(true);
  });

  it('il solo nome non basta a creare una riga', () => {
    expect(worthSaving(wf({ name: 'Sto pensando al nome' }))).toBe(false);
  });
});
