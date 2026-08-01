import { describe, expect, it } from 'vitest';

import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import { keysFromOutput, outputPrefix, upstreamSources } from './sources';

const azione: NodeDef = {
  defId: 'action_run_js',
  type: 'action',
  label: 'JavaScript',
  outputFields: ['dichiarato'],
};
const trigger: NodeDef = { defId: 'trigger_webhook', type: 'trigger', label: 'Webhook' };

const nodes: CanvasNode[] = [
  { id: 'via', defId: 'trigger_webhook', x: 0, y: 0, config: {} },
  { id: 'calcola', defId: 'action_run_js', x: 1, y: 0, config: {} },
  { id: 'usa', defId: 'action_run_js', x: 2, y: 0, config: {} },
];
const edges: WorkflowEdge[] = [
  { from: 'via', to: 'calcola' },
  { from: 'calcola', to: 'usa' },
];
const defs = new Map<string, NodeDef>([
  ['trigger_webhook', trigger],
  ['action_run_js', azione],
]);

describe('dove sta davvero il risultato di un nodo', () => {
  it('un’azione lo mette dentro una busta', () => {
    // Verificato eseguendo: `{{$node.x.json.campo}}` risolve nella stringa
    // vuota, `{{$node.x.json.result.campo}}` nel valore.
    expect(outputPrefix('x', azione)).toBe('$node.x.json.result');
  });

  it('un trigger no: quello che produce non passa da un esecutore', () => {
    expect(outputPrefix('x', trigger)).toBe('$node.x.json');
  });
});

describe('le chiavi di quello che un nodo ha prodotto', () => {
  it('le cerca dentro la busta', () => {
    expect(keysFromOutput({ result: { a: 1, b: 2 }, durationMs: 3 })).toEqual(['a', 'b']);
  });

  it('e senza busta le prende dal primo livello', () => {
    expect(keysFromOutput({ method: 'POST', body: {} })).toEqual(['method', 'body']);
  });

  it('non inventa chiavi da un valore che non è un oggetto', () => {
    expect(keysFromOutput('testo')).toEqual([]);
    expect(keysFromOutput(null)).toEqual([]);
    expect(keysFromOutput({ result: [1, 2] })).toEqual([]);
  });
});

describe('cosa si può referenziare', () => {
  it('solo i nodi a monte', () => {
    // Quelli a valle non sono ancora stati eseguiti quando questo passo gira.
    const fonti = upstreamSources('calcola', nodes, edges, defs);
    const nomi = fonti.map((f) => f.expression);
    expect(nomi.some((e) => e.includes('$node.via'))).toBe(true);
    expect(nomi.some((e) => e.includes('$node.usa'))).toBe(false);
  });

  it('senza esecuzioni, offre i campi dichiarati dal nodo', () => {
    const fonti = upstreamSources('usa', nodes, edges, defs);
    const campo = fonti.find((f) => f.expression === '$node.calcola.json.result.dichiarato');
    expect(campo?.hint).toBe('dichiarato dal nodo');
  });

  it('con un’esecuzione alle spalle, offre i campi VERI', () => {
    // Un action_http dichiara `body`; cosa c'è dentro si sa solo dopo averlo
    // chiamato — e allora quello che si è visto batte quello che è dichiarato.
    const outputs = new Map<string, unknown>([
      ['calcola', { result: { totale: 42, valuta: 'EUR' }, durationMs: 1 }],
    ]);
    const fonti = upstreamSources('usa', nodes, edges, defs, outputs);
    const nomi = fonti.map((f) => f.expression);

    expect(nomi).toContain('$node.calcola.json.result.totale');
    expect(nomi).toContain('$node.calcola.json.result.valuta');
    expect(nomi).not.toContain('$node.calcola.json.result.dichiarato');
  });

  it('per un trigger i campi non passano da `result`', () => {
    const outputs = new Map<string, unknown>([['via', { method: 'POST', body: {} }]]);
    const fonti = upstreamSources('calcola', nodes, edges, defs, outputs);
    expect(fonti.map((f) => f.expression)).toContain('$node.via.json.body');
  });
});
