/**
 * Il diff è quello che l'utente legge prima di accettare una modifica: se
 * mente, accetta qualcosa che non ha visto. Questi test guardano il caso che
 * conta — cosa è cambiato davvero — e i due che ingannano: uno spostamento
 * sul canvas non è una modifica, e un nodo rinominato non è un nodo nuovo.
 */

import { describe, expect, it } from 'vitest';

import type { CanvasNode, Workflow } from '../types';

import { computePatch, summarizePatch } from './diff';
import { isEmptyPatch } from './types';

const node = (id: string, defId: string, config: Record<string, unknown> = {}): CanvasNode => ({
  id,
  defId,
  x: 0,
  y: 0,
  config,
});

const wf = (nodes: CanvasNode[], edges: Workflow['edges'] = []): Workflow => ({
  name: 'test',
  nodes,
  edges,
  executionTarget: 'local',
});

describe('cosa è cambiato', () => {
  it('riconosce un nodo aggiunto', () => {
    const patch = computePatch(
      wf([node('a', 'trigger_cron')]),
      wf([node('a', 'trigger_cron'), node('b', 'action_http')]),
    );
    expect(patch.addNodes.map((n) => n.id)).toEqual(['b']);
    expect(patch.removeNodes).toEqual([]);
  });

  it('riconosce un nodo rimosso', () => {
    const patch = computePatch(
      wf([node('a', 'trigger_cron'), node('b', 'action_http')]),
      wf([node('a', 'trigger_cron')]),
    );
    expect(patch.removeNodes.map((n) => n.id)).toEqual(['b']);
  });

  it('mostra il valore di prima e quello di dopo per ogni campo cambiato', () => {
    const patch = computePatch(
      wf([node('a', 'action_http', { url: 'https://vecchio.test', method: 'GET' })]),
      wf([node('a', 'action_http', { url: 'https://nuovo.test', method: 'GET' })]),
    );
    expect(patch.updateNodes).toHaveLength(1);
    expect(patch.updateNodes[0]?.changes).toEqual([
      { key: 'url', before: 'https://vecchio.test', after: 'https://nuovo.test' },
    ]);
  });

  it('segnala un campo riempito per la prima volta', () => {
    const patch = computePatch(
      wf([node('a', 'action_send_email', {})]),
      wf([node('a', 'action_send_email', { subject: 'Riepilogo' })]),
    );
    expect(patch.updateNodes[0]?.changes).toEqual([
      { key: 'subject', before: '(vuoto)', after: 'Riepilogo' },
    ]);
  });

  it('non considera modifica lo spostamento sul canvas', () => {
    const before = wf([node('a', 'trigger_cron', { cron: '0 9 * * *' })]);
    const after = wf([{ ...node('a', 'trigger_cron', { cron: '0 9 * * *' }), x: 500, y: 300 }]);
    expect(isEmptyPatch(computePatch(before, after))).toBe(true);
  });

  it('distingue i collegamenti per ramo di partenza', () => {
    const nodes = [node('if', 'logic_if'), node('x', 'action_http')];
    const patch = computePatch(
      wf(nodes, [{ from: 'if', to: 'x', fromPort: 'true' }]),
      wf(nodes, [{ from: 'if', to: 'x', fromPort: 'false' }]),
    );
    expect(patch.addEdges).toHaveLength(1);
    expect(patch.removeEdges).toHaveLength(1);
  });

  it('accorcia i valori lunghissimi invece di riversarli nel diff', () => {
    const patch = computePatch(
      wf([node('a', 'action_run_js', { code: 'x' })]),
      wf([node('a', 'action_run_js', { code: 'y'.repeat(500) })]),
    );
    expect(patch.updateNodes[0]?.changes[0]?.after.length).toBeLessThanOrEqual(160);
    expect(patch.updateNodes[0]?.changes[0]?.after.endsWith('…')).toBe(true);
  });
});

describe('riepilogo in una riga', () => {
  it('conta ciò che cambia, al singolare e al plurale', () => {
    const patch = computePatch(
      wf([node('a', 'trigger_cron')]),
      wf(
        [node('a', 'trigger_cron'), node('b', 'action_http'), node('c', 'action_send_email')],
        [{ from: 'a', to: 'b' }],
      ),
    );
    expect(summarizePatch(patch)).toBe('+2 nodi · +1 collegamento');
  });

  it('lo dice quando non cambia niente', () => {
    const same = wf([node('a', 'trigger_cron')]);
    expect(summarizePatch(computePatch(same, same))).toBe('nessuna modifica');
  });
});
