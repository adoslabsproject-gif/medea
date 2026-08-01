import { describe, expect, it } from 'vitest';

import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import { verificaCollegamento } from './connect-rules';

const trigger: NodeDef = { defId: 'trigger_cron', type: 'trigger', label: 'Orario' };
const azione: NodeDef = { defId: 'action_http', type: 'action', label: 'HTTP' };
const defs = new Map<string, NodeDef>([
  ['trigger_cron', trigger],
  ['action_http', azione],
]);

const nodes: CanvasNode[] = [
  { id: 'via', defId: 'trigger_cron', x: 0, y: 0, config: {} },
  { id: 'a', defId: 'action_http', x: 1, y: 0, config: {} },
  { id: 'b', defId: 'action_http', x: 2, y: 0, config: {} },
  { id: 'c', defId: 'action_http', x: 3, y: 0, config: {} },
];

function verifica(from: string, to: string, edges: WorkflowEdge[] = []) {
  return verificaCollegamento(from, to, nodes, edges, defs);
}

describe('quali collegamenti si possono fare', () => {
  it('quello normale, sì', () => {
    expect(verifica('a', 'b')).toBeNull();
  });

  it('un nodo verso sé stesso, no', () => {
    expect(verifica('a', 'a')?.motivo).toContain('sé stesso');
  });

  it('niente può entrare in un trigger', () => {
    // È dove il flusso comincia: quello che ci arrivasse non verrebbe mai
    // eseguito, e il motore non saprebbe cosa farne.
    expect(verifica('a', 'via')?.motivo).toContain('punto di partenza');
  });

  it('ma un trigger può uscire, ovviamente', () => {
    expect(verifica('via', 'a')).toBeNull();
  });

  it('lo stesso collegamento due volte, no', () => {
    expect(verifica('a', 'b', [{ from: 'a', to: 'b' }])?.motivo).toContain('già collegati');
  });

  it('un anello, no', () => {
    // Il motore girerebbe all'infinito, o si fermerebbe per un motivo che dal
    // disegno non si capisce.
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(verifica('c', 'a', edges)?.motivo).toContain('anello');
  });

  it('due strade che si ricongiungono NON sono un anello', () => {
    // È un disegno legittimo — due rami che tornano insieme — e rifiutarlo
    // insegnerebbe a combattere l'editor.
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
    ];
    expect(verifica('b', 'c', edges)).toBeNull();
  });

  it('un nodo che non c’è non fa esplodere niente', () => {
    expect(verifica('fantasma', 'a')).toBeNull();
  });
});
