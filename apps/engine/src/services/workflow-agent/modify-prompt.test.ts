/**
 * Test modify-prompt — il prompt di MODIFICA deve dare al modello lo stato
 * corrente (read-before-edit), abilitare i tool di rimozione e imporre la regola
 * "nodo non in catalogo → crealo nell'IDE". Bug-bounty su serializzazione +
 * troncamento + regole promesse nel commento (no commenti aspirazionali).
 */
import { describe, it, expect } from 'vitest';
import { buildWorkflowModifyPrompt, describeCurrentWorkflow } from './modify-prompt.js';
import type { WorkflowSnapshot } from './state.js';

const WF: WorkflowSnapshot = {
  nodes: [
    { id: 'w', defId: 'trigger_webhook', config: {} },
    { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
  ],
  edges: [{ from: 'w', to: 'h' }],
};

describe('describeCurrentWorkflow', () => {
  it('serializza nodi (id+defId+config) ed edge', () => {
    const s = describeCurrentWorkflow(WF);
    expect(s).toContain('Nodi (2)');
    expect(s).toContain('w [trigger_webhook]');
    expect(s).toContain('h [action_http_request]');
    expect(s).toContain('https://x'); // config inclusa
    expect(s).toContain('w → h'); // edge
  });

  it('workflow vuoto → diciture esplicite', () => {
    const s = describeCurrentWorkflow({ nodes: [], edges: [] });
    expect(s).toContain('(workflow vuoto)');
    expect(s).toContain('(nessun collegamento)');
  });

  it('edge con fromPort → mostra la porta', () => {
    const s = describeCurrentWorkflow({
      nodes: [],
      edges: [{ from: 'a', to: 'b', fromPort: 'true' }],
    });
    expect(s).toContain('porta: true');
  });

  it('🚨 config enorme → TRONCATA (no esplosione contesto)', () => {
    const big = 'x'.repeat(2000);
    const s = describeCurrentWorkflow({
      nodes: [{ id: 'n', defId: 'd', config: { blob: big } }],
      edges: [],
    });
    expect(s).toContain('[troncato]');
    expect(s.length).toBeLessThan(big.length); // mut: se non tronca, fallisce
  });

  it('nodo senza config → "(nessuna config)"', () => {
    const s = describeCurrentWorkflow({ nodes: [{ id: 'n', defId: 'd', config: {} }], edges: [] });
    expect(s).toContain('(nessuna config)');
  });
});

describe('buildWorkflowModifyPrompt — comportamenti promessi', () => {
  const p = buildWorkflowModifyPrompt({
    currentWorkflow: WF,
    request: 'aggiungi un nodo email e collegalo',
  });

  it('include la richiesta utente + lo stato corrente', () => {
    expect(p).toContain('aggiungi un nodo email e collegalo');
    expect(p).toContain('STATO CORRENTE DEL WORKFLOW');
    expect(p).toContain('w [trigger_webhook]');
  });

  it('🚨 abilita i tool di rimozione (delete_node + disconnect)', () => {
    expect(p).toContain('delete_node');
    expect(p).toContain('disconnect');
  });

  it("🚨 REGOLA nodi custom: se manca nel catalogo → crealo nell'IDE, NON improvvisare", () => {
    expect(p).toMatch(/I Miei Nodi/u);
    expect(p).toMatch(/NON improvvisare|NON inventare/u);
  });

  it('🚨 segreti come {{secrets.NOME}} + utente li compila a mano', () => {
    expect(p).toContain('{{secrets.NOME}}');
    expect(p).toMatch(/segreti/u);
  });

  it('extraContext incluso solo se presente', () => {
    expect(buildWorkflowModifyPrompt({ currentWorkflow: WF, request: 'x' })).not.toContain(
      'CONTESTO:',
    );
    expect(
      buildWorkflowModifyPrompt({ currentWorkflow: WF, request: 'x', extraContext: 'DB: clienti' }),
    ).toContain('clienti');
  });
});
