/**
 * I nodi di comunità: installarli, elencarli, toglierli.
 *
 * Un pacchetto `.ffnode` è codice di terzi che verrà eseguito sul computer di
 * chi lo installa. Per questo si installa **da un file scelto a mano**, non
 * cercando in un catalogo remoto: in Medea non c'è nessun registro da
 * interrogare, e la decisione di fidarsi resta una decisione, non un click su
 * un pulsante «Installa» accanto a un nome.
 *
 * Il motore verifica la firma Ed25519 del pacchetto e dice se è riconosciuta;
 * qui quel verdetto si mostra invece di nasconderlo.
 */

import { setCommunityNodes } from '../catalog';
import type { NodeDef } from '../types';

import { runtimeApi } from './client';

export interface CommunityNode {
  vendor: string;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  category?: string;
  installedAt: string;
  /** Vero se la firma del pacchetto è riconosciuta. */
  verified: boolean;
  actionsCount: number;
}

/** Una definizione come la restituisce il motore. */
interface RuntimeNodeDescriptor {
  id: string;
  type: string;
  label: string;
  icon?: string;
  color?: string;
  description?: string;
  configFields?: unknown[];
  actions?: unknown[];
  outputs?: string[];
  package?: string;
  vendor?: string;
  version?: string;
}

export function listCommunityNodes(): Promise<{ nodes: CommunityNode[]; total: number }> {
  return runtimeApi.get('/community-nodes/installed');
}

/**
 * Installa un pacchetto da un file scelto dall'utente.
 *
 * Il contenuto viaggia in base64 perché è così che il motore lo accetta: è la
 * stessa strada che usa il portale, quindi un pacchetto che si installa lì si
 * installa anche qui.
 */
export async function installCommunityNode(bytes: Uint8Array): Promise<CommunityNode> {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);

  const installed = await runtimeApi.post<{
    vendor: string;
    id: string;
    version: string;
    verified: boolean;
  }>('/community-nodes/install', { base64 });

  await refreshCommunityNodes();

  return {
    ...installed,
    displayName: `${installed.vendor}/${installed.id}`,
    installedAt: new Date().toISOString(),
    actionsCount: 0,
  };
}

export async function uninstallCommunityNode(vendor: string, id: string): Promise<void> {
  await runtimeApi.delete(`/community-nodes/${vendor}/${id}`);
  await refreshCommunityNodes();
}

/** Una definizione del motore, nella forma che usa l'editor. */
function toNodeDef(d: RuntimeNodeDescriptor): NodeDef {
  return {
    defId: d.id,
    type: d.type as NodeDef['type'],
    label: d.label,
    ...(d.icon ? { icon: d.icon } : {}),
    ...(d.color ? { color: d.color } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(Array.isArray(d.configFields) && d.configFields.length > 0
      ? { configFields: d.configFields as NonNullable<NodeDef['configFields']> }
      : {}),
    // Le operazioni: un pacchetto di comunità non è un nodo per operazione,
    // è UN nodo che ne dichiara fino a settantacinque. Buttarle via — come
    // faceva questa funzione — rendeva quei nodi inconfigurabili: si
    // trascinavano sul disegno e non c'era modo di dire cosa dovessero fare.
    ...(Array.isArray(d.actions) && d.actions.length > 0
      ? { actions: d.actions as NonNullable<NodeDef['actions']> }
      : {}),
    ...(Array.isArray(d.outputs) && d.outputs.length > 0 ? { outputFields: d.outputs } : {}),
  };
}

/**
 * Chiede al motore quali nodi aggiuntivi ci sono, e li mette nel catalogo.
 *
 * Se il motore non risponde non è un errore da mostrare: significa solo che
 * per ora ci sono i 193 preinstallati, che è la condizione normale di chi non
 * ha mai installato niente.
 */
export async function refreshCommunityNodes(): Promise<void> {
  try {
    const nodes = await runtimeApi.get<
      RuntimeNodeDescriptor[] | { nodes: RuntimeNodeDescriptor[] }
    >('/nodes?package=community');
    const list = Array.isArray(nodes) ? nodes : nodes.nodes;
    setCommunityNodes(list.filter((n) => n.package === 'community').map(toNodeDef));
  } catch {
    setCommunityNodes([]);
  }
}
