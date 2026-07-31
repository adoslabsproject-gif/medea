/**
 * Scorciatoie per costruire i workflow dei test.
 *
 * Ogni test deve dire in due righe quale situazione sta descrivendo; senza
 * questi helper metà del file sarebbe fatta di parentesi graffe.
 */

import type { QualityEdge, QualityGateInput, QualityIssue, QualityNode } from './types';

export function node(id: string, defId: string, config: Record<string, unknown> = {}): QualityNode {
  return { id, defId, config };
}

export function edge(from: string, to: string, fromPort?: string): QualityEdge {
  return { from, to, ...(fromPort ? { fromPort } : {}) };
}

export function input(
  nodes: QualityNode[],
  edges: QualityEdge[] = [],
  databases?: QualityGateInput['databases'],
): QualityGateInput {
  return { nodes, edges, ...(databases ? { databases } : {}) };
}

/** I codici dei problemi trovati, per asserzioni leggibili. */
export function codes(issues: readonly QualityIssue[]): string[] {
  return issues.map((i) => i.code);
}

/** Un workflow minimo ma sensato: parte, fa una cosa, finisce. */
export function healthyWorkflow(): QualityGateInput {
  return input(
    [
      node('avvio', 'trigger_cron', { cron: '0 9 * * *' }),
      node('scarica', 'action_http', { url: 'https://api.reale.it/dati', method: 'GET' }),
      node('avvisa', 'action_send_email', {
        to: 'destinatario@aziendareale.it',
        subject: 'Dati del giorno',
      }),
    ],
    [edge('avvio', 'scarica'), edge('scarica', 'avvisa')],
  );
}
