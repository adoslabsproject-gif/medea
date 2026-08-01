/**
 * Provare un nodo da solo, senza far girare tutto il workflow.
 *
 * È la differenza fra capire un errore in dieci secondi e capirlo in dieci
 * minuti: si cambia un campo, si preme, si vede cosa esce. Senza, l'unico modo
 * di sapere se una configurazione è giusta è eseguire l'intero workflow — e se
 * il nodo sta in fondo, aspettare tutto quello che viene prima.
 *
 * La prova gira sulla **bozza**, non su quello che c'è sul disco: si prova
 * quello che si sta guardando, non quello che si era salvato.
 */

import type { CanvasNode, WorkflowEdge } from '../types';

import { runtimeApi } from './client';

export interface NodeTestResult {
  ok: boolean;
  /** Cosa ha prodotto, se ha prodotto qualcosa. */
  output?: unknown;
  /** Cosa gli è arrivato in ingresso: serve a capire perché ha fatto così. */
  input?: unknown;
  error?: string;
  durationMs?: number;
}

interface EphemeralResponse {
  output?: unknown;
  durationMs?: number;
  step?: {
    status?: string;
    input?: string;
    output?: string;
    error?: string;
    durationMs?: number;
  };
}

/** Quello che il runtime restituisce serializzato, riportato a valore. */
function parse(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Esegue un solo nodo con l'ingresso che gli si dà.
 *
 * Gli altri nodi viaggiano lo stesso: servono al runtime per risolvere le
 * espressioni che li nominano. Eseguito, però, è solo quello chiesto.
 */
export async function testNode(args: {
  nodeId: string;
  nodes: readonly CanvasNode[];
  edges: readonly WorkflowEdge[];
  input?: unknown;
}): Promise<NodeTestResult> {
  try {
    const response = await runtimeApi.post<EphemeralResponse>('/workflows/test-node-ephemeral', {
      nodeId: args.nodeId,
      nodes: args.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
      edges: args.edges.map((e) => ({ from: e.from, to: e.to })),
      triggerInput: args.input ?? {},
    });

    const step = response.step;
    const failed = step?.status === 'error' || step?.error !== undefined;

    return {
      ok: !failed,
      ...(response.output !== undefined ? { output: response.output } : {}),
      ...(parse(step?.input) !== undefined ? { input: parse(step?.input) } : {}),
      ...(step?.error ? { error: step.error } : {}),
      ...(step?.durationMs !== undefined
        ? { durationMs: step.durationMs }
        : response.durationMs !== undefined
          ? { durationMs: response.durationMs }
          : {}),
    };
  } catch (e) {
    // Un nodo sconosciuto o un campo rifiutato tornano come errore della
    // chiamata: per chi prova è lo stesso fallimento, e va mostrato uguale.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
