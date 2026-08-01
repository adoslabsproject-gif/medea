/**
 * Test di INTEGRAZIONE del finalize gate dentro il finalizeWorkflowHandler.
 *
 * Verifica che il gate sia effettivamente collegato al handler (non solo
 * import) e che blocchi finalize prematuri con il messaggio prescrittivo.
 *
 * NON e\` smoke test — istanzia la session vera, aggiunge nodi veri,
 * chiama il handler vero, e asserisce il behavior osservabile.
 */

import { describe, it, expect } from 'vitest';
import { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import { finalizeWorkflowHandler } from './draft-mutations.js';

const ENTERPRISE_GOAL = `Document intelligence pipeline: cartella S3 con PDF in arrivo, OCR + vision AI extract entities, classifica documento (contratto/fattura/preventivo), validazione schema, branching per tipo: contratto → legal team review queue, fattura → ERP push, preventivo → CRM opportunity, in caso di low confidence routing manuale + Slack notification, summary AI giornaliero al management.`;

function makeSessionWith(goal: string, nNodes: number): ScaffoldSession {
  const s = new ScaffoldSession('tenant-test');
  s.goal = goal;
  // Aggiungiamo direttamente al draft per by-passare la validazione catalog
  // (i defId qui non servono ad essere validi, ci interessa il count).
  for (let i = 0; i < nNodes; i++) {
    s.draft.nodes.push({
      id: `n${i.toString()}`,
      defId: 'noop',
      position: { x: 0, y: 0 },
      config: {},
    });
  }
  // Stub plan accepted in modo che la finalize gate sia testabile in isolamento
  // (altrimenti requirePlan blocca prima della complexity gate). Test del plan
  // gate vero in plan-handler.test.ts. Plan nodes matchano draft per soddisfare
  // anche il plan-vs-actual completeness check.
  s.plan = {
    accepted: true,
    proposedAt: Date.now(),
    reasoning: 'stub for integration test',
    nodes: s.draft.nodes.map((n) => ({ id: n.id, defId: n.defId, purpose: 'stub' })),
    edges: [],
  };
  return s;
}

describe('finalizeWorkflowHandler — complexity gate integration', () => {
  it('Enterprise goal + 2 nodi → REJECT (matches bug 2026-05-30)', () => {
    const s = makeSessionWith(ENTERPRISE_GOAL, 2);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Test' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Finalize PREMATURO');
      expect(r.error).toContain('enterprise');
    }
    // Session NON deve essere segnata come finalized.
    expect(s.finalized).toBe(false);
  });

  it('Enterprise goal + 25 nodi (= cap superiore) → ACCEPT', () => {
    // 25 = cap massimo del minNodes computer (vedi complexity-gate.ts).
    // Quindi con 25 nodi il gate accetta SEMPRE, qualunque sia il goal.
    const s = makeSessionWith(ENTERPRISE_GOAL, 25);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Doc Pipeline' });
    expect(r.ok).toBe(true);
    expect(s.finalized).toBe(true);
  });

  it('Goal vuoto + 2 nodi → ACCEPT (gate disabilitato senza goal)', () => {
    const s = makeSessionWith('', 2);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Test' });
    expect(r.ok).toBe(true);
    expect(s.finalized).toBe(true);
  });

  it('Gate prima dei controlli edge orfani — REJECT non guardia su edge mancanti', () => {
    // Anche se non ci sono edge orfani (perche\` non ci sono edge), il gate
    // deve scattare prima. Verifica l'ordine dei check.
    const s = makeSessionWith(ENTERPRISE_GOAL, 1);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Test' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Finalize PREMATURO');
      // NON deve essere il messaggio orphan edge.
      expect(r.error).not.toContain('orfano');
    }
  });

  it('Goal basic + 0 nodi → REJECT con messaggio "Nessun nodo" (gate non scatta)', () => {
    // Quando 0 nodi, scatta il check precedente "Nessun nodo nel draft".
    const s = makeSessionWith('ciao', 0);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Test' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Nessun nodo');
    }
  });

  it('Messaggio gate include suggerimento list_node_catalog (recovery actionable)', () => {
    const s = makeSessionWith(ENTERPRISE_GOAL, 3);
    const r = finalizeWorkflowHandler(s, { id: 'wf1', name: 'Test' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Anti-regression: il messaggio DEVE dire all'agente cosa fare dopo.
      expect(r.error).toContain('list_node_catalog');
    }
  });
});
