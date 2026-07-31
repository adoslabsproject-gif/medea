import { describe, expect, it } from 'vitest';

import type { AgentStep } from '../scaffold';

import { builtNodes, toTraceEntry } from './tool-labels';

function step(partial: Partial<AgentStep> & Pick<AgentStep, 'tool'>): AgentStep {
  return { step: 1, args: {}, result: { ok: true }, ...partial };
}

describe('i passi dell’agente detti in italiano', () => {
  it('traduce il nome dello strumento', () => {
    expect(toTraceEntry(step({ tool: 'search_nodes', args: { query: 'email' } })).label).toBe(
      'Cerca il nodo giusto',
    );
  });

  it('lascia passare uno strumento che non conosce invece di nasconderlo', () => {
    // Meglio un nome tecnico che una riga muta: chi guarda deve vedere che è
    // successo qualcosa.
    expect(toTraceEntry(step({ tool: 'strumento_nuovo' })).label).toBe('strumento_nuovo');
  });

  it('mostra quale nodo è stato aggiunto', () => {
    const entry = toTraceEntry(
      step({ tool: 'add_node', args: { id: 'invia', defId: 'action_send_email' } }),
    );
    expect(entry.detail).toBe('action_send_email → invia');
  });

  it('mostra quali campi sono stati configurati', () => {
    const entry = toTraceEntry(
      step({ tool: 'set_config', args: { id: 'invia', config: { to: 'a@b.it', subject: 'x' } } }),
    );
    expect(entry.detail).toBe('invia · to, subject');
  });

  it('riconosce un passo fallito dal risultato', () => {
    const entry = toTraceEntry(
      step({
        tool: 'connect',
        args: { from: 'a', to: 'b' },
        result: { ok: false, error: 'nodo b assente' },
      }),
    );
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('nodo b assente');
  });

  it('considera riuscito un passo il cui risultato non parla di errori', () => {
    expect(toTraceEntry(step({ tool: 'finish', result: 'fatto' })).ok).toBe(true);
  });
});

describe('i nodi montati finora', () => {
  it('raccoglie gli aggiunti nell’ordine in cui compaiono', () => {
    const steps = [
      step({ step: 1, tool: 'add_node', args: { id: 'ogni_ora', defId: 'trigger_cron' } }),
      step({ step: 2, tool: 'add_node', args: { id: 'invia', defId: 'action_send_email' } }),
    ];
    expect(builtNodes(steps)).toEqual([
      { id: 'ogni_ora', defId: 'trigger_cron' },
      { id: 'invia', defId: 'action_send_email' },
    ]);
  });

  it('toglie quelli che l’agente ha poi cancellato', () => {
    const steps = [
      step({ step: 1, tool: 'add_node', args: { id: 'a', defId: 'trigger_cron' } }),
      step({ step: 2, tool: 'delete_node', args: { id: 'a' } }),
    ];
    expect(builtNodes(steps)).toEqual([]);
  });

  it('non conta un nodo che non è stato aggiunto davvero', () => {
    const steps = [
      step({
        step: 1,
        tool: 'add_node',
        args: { id: 'a', defId: 'inesistente' },
        result: { ok: false, error: 'defId sconosciuto' },
      }),
    ];
    expect(builtNodes(steps)).toEqual([]);
  });

  it('non duplica un nodo riconfigurato più volte', () => {
    const steps = [
      step({ step: 1, tool: 'add_node', args: { id: 'a', defId: 'trigger_cron' } }),
      step({
        step: 2,
        tool: 'set_config',
        args: { id: 'a', config: { cronExpression: '* * * * *' } },
      }),
      step({ step: 3, tool: 'add_node', args: { id: 'a', defId: 'trigger_cron' } }),
    ];
    expect(builtNodes(steps)).toHaveLength(1);
  });
});
