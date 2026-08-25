/**
 * Le porte che un nodo dichiara, quando l'edge le nomina.
 *
 * Il caso vero: «Email con parole chiave», 2026-08-16.
 *
 *     trigger_imap → action_filter → community_telegram
 *
 * `action_filter` sceglie un ramo — `kept` se qualcosa è passato, `removed`
 * altrimenti — ma non dichiara `branching: true`, e il motore quel ramo lo
 * buttava via: Telegram partiva comunque, cioè l'avviso a ogni email.
 *
 * Questi test fissano il contratto in tutte e due le direzioni: la porta
 * nominata si rispetta, l'edge senza porta continua a ricevere tutto. La
 * seconda metà conta quanto la prima — è la garanzia che i workflow già
 * esistenti non cambiano comportamento sotto i piedi di nessuno.
 *
 * @module engine/porte-dichiarate.test
 */

import type { Edge, Workflow } from '@medea/engine-core-schema';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';

import { WorkflowEngine } from './workflow-engine.js';

/** Chi ha girato, in ordine. */
let girati: string[];

function def(id: string, opts: { outputs?: string[]; branching?: boolean } = {}) {
  return {
    id,
    label: id,
    kind: 'action' as const,
    category: 'test',
    inputs: [],
    outputs: opts.outputs ?? [],
    configSchema: {} as never,
    ...(opts.branching === true ? { branching: true } : {}),
  };
}

/** Un nodo che sceglie un ramo senza dichiararsi istradante: il filtro. */
function scegliePorta(id: string, ramo: string, outputs: string[], branching = false) {
  return {
    def: def(id, { outputs, ...(branching ? { branching: true } : {}) }),
    executor: async (_c: unknown, _i: unknown, _ctx: NodeExecutionContext) => {
      girati.push(id);
      // È `branch` che il motore legge (`node-executor.strategy.ts`), non
      // `chosenBranch`: quello è il nome che il ramo prende più a valle.
      return { output: { fatto: true }, branch: ramo };
    },
  };
}

function foglia(id: string) {
  return {
    def: def(id),
    executor: async (_c: unknown, _i: unknown, _ctx: NodeExecutionContext) => {
      girati.push(id);
      return { output: { ok: true } };
    },
  };
}

function workflow(nodi: string[], edges: Edge[]): Workflow {
  return {
    schemaVersion: '1.0.0',
    id: 'wf-porte',
    name: 'Porte',
    enabled: true,
    nodes: nodi.map((id, i) => ({ id, defId: id, x: i, y: 0, config: {} })),
    edges,
    nodeDefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function motore(...moduli: object[]): WorkflowEngine {
  return new WorkflowEngine(new InMemoryEventBus(), { nodeRegistry: moduli as never[] });
}

/** Fa girare il workflow e basta: qui interessa CHI ha girato. */
async function esegui(e: WorkflowEngine, wf: Workflow): Promise<void> {
  await e.run({ workflow: wf });
}

beforeEach(() => {
  girati = [];
});

describe('la porta nominata si rispetta', () => {
  /**
   * Il caso vero, in piccolo: il filtro non tiene niente (`removed`), e
   * l'avviso è collegato a `kept`. Non deve partire.
   */
  it('il ramo scartato non fa partire chi aspetta quello tenuto', async () => {
    const e = motore(scegliePorta('filtro', 'removed', ['kept', 'removed']), foglia('avviso'));
    await esegui(e, workflow(['filtro', 'avviso'], [{ from: 'filtro', to: 'avviso', fromPort: 'kept' }]));
    expect(girati).toEqual(['filtro']);
  });

  it('e il ramo giusto lo fa partire', async () => {
    const e = motore(scegliePorta('filtro', 'kept', ['kept', 'removed']), foglia('avviso'));
    await esegui(e, workflow(['filtro', 'avviso'], [{ from: 'filtro', to: 'avviso', fromPort: 'kept' }]));
    expect(girati).toEqual(['filtro', 'avviso']);
  });

  it('gli scartati si possono mandare da un’altra parte', async () => {
    const e = motore(
      scegliePorta('filtro', 'removed', ['kept', 'removed']),
      foglia('avviso'),
      foglia('registro'),
    );
    await esegui(
      e,
      workflow(
        ['filtro', 'avviso', 'registro'],
        [
          { from: 'filtro', to: 'avviso', fromPort: 'kept' },
          { from: 'filtro', to: 'registro', fromPort: 'removed' },
        ],
      ),
    );
    expect(girati).toEqual(['filtro', 'registro']);
  });
});

describe('quello che non deve cambiare', () => {
  /**
   * La garanzia di compatibilità: un edge senza porta ha sempre voluto dire
   * «passami tutto», e continua a dirlo. Chi ha già dei workflow salvati non
   * si ritrova rami morti dopo un aggiornamento.
   */
  it('un edge senza porta riceve tutto lo stesso', async () => {
    const e = motore(scegliePorta('filtro', 'removed', ['kept', 'removed']), foglia('avviso'));
    await esegui(e, workflow(['filtro', 'avviso'], [{ from: 'filtro', to: 'avviso' }]));
    expect(girati).toEqual(['filtro', 'avviso']);
  });

  it('accanto a una porta nominata, l’edge senza porta parte comunque', async () => {
    const e = motore(
      scegliePorta('filtro', 'removed', ['kept', 'removed']),
      foglia('avviso'),
      foglia('sempre'),
    );
    await esegui(
      e,
      workflow(
        ['filtro', 'avviso', 'sempre'],
        [
          { from: 'filtro', to: 'avviso', fromPort: 'kept' },
          { from: 'filtro', to: 'sempre' },
        ],
      ),
    );
    expect(girati).toEqual(['filtro', 'sempre']);
  });

  /** Un nodo che dichiara `branching: true` mantiene la regola severa. */
  it('chi è istradante davvero non segue gli edge senza porta', async () => {
    const e = motore(scegliePorta('se', 'true', ['true', 'false'], true), foglia('poi'));
    await esegui(e, workflow(['se', 'poi'], [{ from: 'se', to: 'poi' }]));
    expect(girati).toEqual(['se']);
  });

  /** Le porte inventate non contano: `outputs` è la lista di quelle vere. */
  it('una porta che il nodo non dichiara non attiva la selezione', async () => {
    const e = motore(scegliePorta('filtro', 'removed', ['kept', 'removed']), foglia('avviso'));
    await esegui(
      e,
      workflow(['filtro', 'avviso'], [{ from: 'filtro', to: 'avviso', fromPort: 'inventata' }]),
    );
    expect(girati).toEqual(['filtro', 'avviso']);
  });
});
