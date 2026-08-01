/**
 * I dati fissati su un nodo.
 *
 * Fissare un nodo significa dire al motore: «questo non eseguirlo, usa questo
 * risultato». Serve a due cose che oggi costano molto tempo:
 *
 *   PROVARE A VALLE senza rifare quello che c'è a monte. Un nodo che manda
 *   una email, o che chiama un servizio a pagamento, non va rieseguito venti
 *   volte per sistemare il nodo dopo.
 *
 *   PROVARE UN CASO che nella realtà capita di rado — la risposta che torna
 *   vuota, l'errore del fornitore — senza aspettare che capiti.
 *
 * I dati fissati stanno nel motore, accanto al workflow, e sono **della copia
 * di prova**: fissare un nodo non deve cambiare cosa succede in produzione.
 */

import { runtimeApi } from './client';

export interface Pin {
  nodeId: string;
  output: unknown;
  enabled: boolean;
}

/** Quali nodi hanno dati fissati. */
export async function listPins(runtimeWorkflowId: string): Promise<Pin[]> {
  const { pins } = await runtimeApi.get<{ pins: Pin[] }>(`/workflows/${runtimeWorkflowId}/pins`);
  return pins;
}

/**
 * Fissa un risultato su un nodo.
 *
 * `enabled: false` lo tiene salvato ma spento: si riprova con l'esecuzione
 * vera senza perdere il dato di prova, che è la cosa che serve subito dopo
 * aver capito il problema.
 */
export async function setPin(
  runtimeWorkflowId: string,
  nodeId: string,
  output: unknown,
  enabled = true,
): Promise<void> {
  await runtimeApi.put(`/workflows/${runtimeWorkflowId}/pins/${nodeId}`, { output, enabled });
}

/** Toglie il dato fissato: da qui in poi il nodo esegue davvero. */
export async function clearPin(runtimeWorkflowId: string, nodeId: string): Promise<void> {
  await runtimeApi.delete(`/workflows/${runtimeWorkflowId}/pins/${nodeId}`);
}
