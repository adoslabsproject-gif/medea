/**
 * Rieseguire un'esecuzione passata, a partire da un nodo.
 *
 * Quando un workflow fallisce al quinto nodo, rifare i primi quattro è tempo
 * buttato — e se uno di quelli manda una email, è anche una email in più a
 * ogni tentativo. La riesecuzione riusa le uscite già registrate per tutto
 * quello che viene prima, e riparte da dove serve.
 *
 * È il motivo per cui lo storico tiene le uscite di ogni passo e non solo lo
 * stato: senza, questa funzione non potrebbe esistere.
 */

import { runtimeApi } from './client';

export interface ReplayResult {
  runId: string;
  status: string;
  /** Quanti passi sono stati saltati riusando le uscite già registrate. */
  reused: number;
}

/**
 * Riparte da `fromNode`, riusando quello che c'era prima.
 *
 * `runtimeWorkflowId` è l'identificativo del workflow **dentro il runtime**:
 * quello di Medea non gli dice niente.
 */
export async function replayRun(args: {
  runtimeWorkflowId: string;
  runId: string;
  fromNode: string;
  /** Fin dove arrivare. Assente: fino alla fine. */
  toNode?: string;
}): Promise<ReplayResult> {
  const query = new URLSearchParams({ fromNode: args.fromNode });
  if (args.toNode) query.set('toNode', args.toNode);

  const response = await runtimeApi.post<{
    run?: { runId?: string; status?: string };
    pinnedCount?: number;
  }>(`/workflows/${args.runtimeWorkflowId}/runs/${args.runId}/replay?${query.toString()}`, {});

  return {
    runId: response.run?.runId ?? '',
    status: response.run?.status ?? 'unknown',
    reused: response.pinnedCount ?? 0,
  };
}
