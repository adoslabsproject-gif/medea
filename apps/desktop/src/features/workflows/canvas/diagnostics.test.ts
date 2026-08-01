/**
 * Un nodo che non c'è deve fermare tutto.
 *
 * Medea non ha un registro remoto da cui scaricare i pacchetti `.ffnode`, ed è
 * una scelta (ADR 0005): un pacchetto è codice di terzi che gira su questo
 * computer, e fidarsi deve restare una decisione. Ma quella scelta regge solo
 * se, quando un workflow importato usa un nodo che qui non è installato, l'app
 * lo dice e **impedisce di attivarlo**.
 *
 * Segnalarlo e lasciar attivare sarebbe il peggio dei due mondi: si accende
 * un'automazione convinti che funzioni, e lo si scopre alle tre di notte
 * quando parte il cron.
 */

import { describe, expect, it } from 'vitest';

import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import { diagnose } from './diagnostics';

const TRIGGER: NodeDef = {
  defId: 'trigger_manual',
  type: 'trigger',
  label: 'A mano',
  description: 'parte quando lo si fa partire',
  configFields: [],
};

const AZIONE: NodeDef = {
  defId: 'action_run_js',
  type: 'action',
  label: 'Codice',
  description: 'esegue del codice',
  configFields: [],
};

function nodo(id: string, defId: string): CanvasNode {
  return { id, defId, x: 0, y: 0, config: {} };
}

const CATALOGO = new Map<string, NodeDef>([
  [TRIGGER.defId, TRIGGER],
  [AZIONE.defId, AZIONE],
]);

describe('un nodo non installato', () => {
  const nodes = [nodo('avvio', 'trigger_manual'), nodo('strano', 'community_chissache')];
  const edges: WorkflowEdge[] = [{ from: 'avvio', to: 'strano' }];

  it('si vede sul nodo', () => {
    const d = diagnose(nodes, edges, CATALOGO);
    expect(d.issuesByNode.get('strano')?.join(' ')).toContain('non è installato');
  });

  it('è critico, non un avviso', () => {
    const d = diagnose(nodes, edges, CATALOGO);
    const suo = d.issues.find((i) => i.code === 'NODE_NOT_INSTALLED');
    expect(suo?.severity).toBe('critical');
    expect(suo?.nodeId).toBe('strano');
  });

  it('e impedisce di attivare il workflow', () => {
    // Il punto di tutto il file: senza questo, l'avviso è decorativo.
    expect(diagnose(nodes, edges, CATALOGO).ok).toBe(false);
  });

  it('mentre un workflow di soli nodi conosciuti non ne ha traccia', () => {
    const sani = [nodo('avvio', 'trigger_manual'), nodo('fai', 'action_run_js')];
    const d = diagnose(sani, [{ from: 'avvio', to: 'fai' }], CATALOGO);
    expect(d.issues.some((i) => i.code === 'NODE_NOT_INSTALLED')).toBe(false);
  });
});
