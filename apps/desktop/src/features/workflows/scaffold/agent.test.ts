/**
 * Il loop dell'agente messo alla prova come si comporta un modello vero:
 * chiama gli strumenti in sequenza, a volte sbaglia, a volte si perde, a
 * volte dichiara finito qualcosa che non lo è.
 *
 * Il criterio resta lo stesso della generazione in un colpo: **nessun
 * workflow non valido esce da qui**.
 */

import { describe, expect, it } from 'vitest';

import type { NodeDef } from '../types';

import {
  agentToolsForProvider,
  runWorkflowAgent,
  type AgentChat,
  type AgentToolCall,
} from './agent';

const CATALOG: NodeDef[] = [
  {
    defId: 'trigger_cron',
    type: 'trigger',
    label: 'Pianificazione',
    description: 'avvia il workflow a orario',
    configFields: [{ key: 'cron', type: 'cron-builder', required: true }],
  },
  {
    defId: 'action_http',
    type: 'action',
    label: 'Chiamata HTTP',
    description: 'esegue una richiesta http get o post',
    configFields: [
      { key: 'url', type: 'string', required: true },
      { key: 'method', type: 'select', options: ['GET', 'POST'], defaultValue: 'GET' },
    ],
  },
  {
    defId: 'action_send_email',
    type: 'action',
    label: 'Invia email',
    description: 'invia una email a un destinatario',
    configFields: [
      { key: 'to', type: 'string', required: true },
      { key: 'subject', type: 'string', required: true },
    ],
  },
];

/** Un modello finto che esegue una sceneggiatura di chiamate a strumenti. */
function scriptedChat(script: AgentToolCall[][]): AgentChat {
  let turn = 0;
  return () => {
    const calls = script[turn] ?? [];
    turn++;
    return Promise.resolve({ content: '', toolCalls: calls });
  };
}

const call = (name: string, args: Record<string, unknown> = {}, id = name): AgentToolCall => ({
  id,
  name,
  arguments: args,
});

describe('strumenti esposti al provider', () => {
  it('sono i 9, nel formato function-calling', () => {
    const tools = agentToolsForProvider();
    expect(tools).toHaveLength(9);
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.function.name).toBe('search_nodes');
  });
});

describe('costruzione guidata dagli strumenti', () => {
  it('completa un workflow valido seguendo la sequenza attesa', async () => {
    const res = await runWorkflowAgent({
      goal: 'ogni mattina scarica i dati e mandami una email',
      catalog: CATALOG,
      chat: scriptedChat([
        [call('search_nodes', { query: 'pianificazione oraria' })],
        [call('add_node', { defId: 'trigger_cron', id: 'cron', config: { cron: '0 9 * * *' } })],
        [
          call('add_node', {
            defId: 'action_http',
            id: 'fetch',
            config: { url: 'https://x.test' },
          }),
        ],
        [
          call('add_node', {
            defId: 'action_send_email',
            id: 'notify',
            config: { to: 'io@x.test', subject: 'Report' },
          }),
        ],
        [
          call('connect', { from: 'cron', to: 'fetch' }),
          call('connect', { from: 'fetch', to: 'notify' }),
        ],
        [call('validate_workflow')],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.workflow.nodes).toHaveLength(3);
      expect(res.workflow.edges).toHaveLength(2);
      expect(res.steps.map((s) => s.tool)).toContain('validate_workflow');
    }
  });

  it('rifiuta la chiusura se il workflow non è valido', async () => {
    const res = await runWorkflowAgent({
      goal: 'x',
      catalog: CATALOG,
      chat: scriptedChat([
        // Email senza oggetto: manca un campo obbligatorio.
        [
          call('add_node', {
            defId: 'action_send_email',
            id: 'notify',
            config: { to: 'io@x.test' },
          }),
        ],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.violations.some((v) => v.kind === 'missing_required')).toBe(true);
      // Lo stato raggiunto resta disponibile: l'utente può recuperarlo.
      expect(res.partial?.nodes).toHaveLength(1);
    }
  });

  it('non consegna un workflow pieno di segnaposto, anche se ben formato', async () => {
    const res = await runWorkflowAgent({
      goal: 'x',
      catalog: CATALOG,
      chat: scriptedChat([
        [call('add_node', { defId: 'trigger_cron', id: 'cron', config: { cron: '0 9 * * *' } })],
        // URL fittizio: nessun campo obbligatorio manca, ma non funzionerà mai.
        [
          call('add_node', {
            defId: 'action_http',
            id: 'fetch',
            config: { url: 'https://api.example.com/dati' },
          }),
        ],
        [call('connect', { from: 'cron', to: 'fetch' })],
        [call('finish')],
        [call('finish')],
        [call('finish')],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.qualityIssues.some((i) => i.code === 'MOCK_PLACEHOLDER')).toBe(true);
      expect(res.violations).toEqual([]);
    }
  });

  it('dice al modello cosa non va invece di bocciarlo subito', async () => {
    let turn = 0;
    const chat: AgentChat = ({ history }) => {
      turn++;
      if (turn === 1) {
        return Promise.resolve({
          content: '',
          toolCalls: [
            call(
              'add_node',
              { defId: 'trigger_cron', id: 'cron', config: { cron: '0 9 * * *' } },
              'a',
            ),
            call(
              'add_node',
              { defId: 'action_http', id: 'fetch', config: { url: 'https://api.example.com' } },
              'b',
            ),
            call('connect', { from: 'cron', to: 'fetch' }, 'c'),
            call('finish', {}, 'd'),
          ],
        });
      }
      // Il richiamo è arrivato e dice cosa correggere.
      const ultimo = history[history.length - 1];
      expect(ultimo?.role).toBe('user');
      expect(ultimo?.content).toContain('MOCK_PLACEHOLDER');
      return Promise.resolve({
        content: '',
        toolCalls: [
          call(
            'set_config',
            { nodeId: 'fetch', config: { url: 'https://api.aziendareale.it' } },
            'e',
          ),
          call('finish', {}, 'f'),
        ],
      });
    };

    const res = await runWorkflowAgent({ goal: 'x', catalog: CATALOG, chat });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.workflow.nodes[1]?.config.url).toBe('https://api.aziendareale.it');
  });

  it('riporta al modello il rifiuto di un defId inventato', async () => {
    const res = await runWorkflowAgent({
      goal: 'x',
      catalog: CATALOG,
      chat: scriptedChat([
        [call('add_node', { defId: 'action_slack_inventato' })],
        [call('finish')],
      ]),
    });

    const first = res.steps[0]?.result as { ok: boolean; error: string };
    expect(first.ok).toBe(false);
    expect(first.error).toContain('search_nodes');
  });

  it('sollecita il modello che smette di usare gli strumenti', async () => {
    let calls = 0;
    const chat: AgentChat = () => {
      calls++;
      return Promise.resolve({ content: 'Ho finito, credo.', toolCalls: [] });
    };
    const res = await runWorkflowAgent({ goal: 'x', catalog: CATALOG, chat });
    expect(res.ok).toBe(false);
    // Ha insistito più di una volta prima di arrendersi.
    expect(calls).toBeGreaterThan(1);
  });

  it("si ferma invece di girare a vuoto all'infinito", async () => {
    const chat: AgentChat = () =>
      Promise.resolve({ content: '', toolCalls: [call('search_nodes', { query: 'email' })] });
    const res = await runWorkflowAgent({ goal: 'x', catalog: CATALOG, chat });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('passi');
  });

  it('accetta la chiusura implicita se il workflow è già valido', async () => {
    let turn = 0;
    const chat: AgentChat = () => {
      turn++;
      if (turn === 1) {
        return Promise.resolve({
          content: '',
          toolCalls: [
            call(
              'add_node',
              { defId: 'trigger_cron', id: 'cron', config: { cron: '0 9 * * *' } },
              'a',
            ),
            call(
              'add_node',
              { defId: 'action_http', id: 'fetch', config: { url: 'https://x.test' } },
              'b',
            ),
            call('connect', { from: 'cron', to: 'fetch' }, 'c'),
          ],
        });
      }
      // Il modello risponde a parole invece di chiamare `finish`.
      return Promise.resolve({ content: 'Fatto.', toolCalls: [] });
    };
    const res = await runWorkflowAgent({ goal: 'x', catalog: CATALOG, chat });
    expect(res.ok).toBe(true);
  });
});

describe('modifica di un workflow esistente', () => {
  const seed = {
    name: 'Esistente',
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cron: '0 9 * * *' } },
      { id: 'fetch', defId: 'action_http', x: 220, y: 0, config: { url: 'https://vecchio.test' } },
    ],
    edges: [{ from: 'cron', to: 'fetch' }],
  };

  it('parte dallo stato corrente invece di ricominciare', async () => {
    const res = await runWorkflowAgent({
      goal: "cambia l'indirizzo chiamato",
      catalog: CATALOG,
      seed,
      chat: scriptedChat([
        [call('set_config', { nodeId: 'fetch', config: { url: 'https://nuovo.test' } })],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.workflow.nodes).toHaveLength(2);
      expect(res.workflow.nodes[1]?.config.url).toBe('https://nuovo.test');
      // Il collegamento preesistente non è stato toccato.
      expect(res.workflow.edges).toHaveLength(1);
    }
  });

  it('rimuove un nodo, i suoi collegamenti, e ricuce il flusso', async () => {
    const treNodi = {
      ...seed,
      nodes: [
        ...seed.nodes,
        {
          id: 'notify',
          defId: 'action_send_email',
          x: 440,
          y: 0,
          config: { to: 'io@aziendareale.it', subject: 'Fatto' },
        },
      ],
      edges: [...seed.edges, { from: 'fetch', to: 'notify' }],
    };

    const res = await runWorkflowAgent({
      goal: 'togli la chiamata http',
      catalog: CATALOG,
      seed: treNodi,
      chat: scriptedChat([
        [call('delete_node', { nodeId: 'fetch' })],
        [call('connect', { from: 'cron', to: 'notify' })],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.workflow.nodes.map((n) => n.id)).toEqual(['cron', 'notify']);
      // I due collegamenti che passavano dal nodo rimosso sono spariti con lui.
      expect(res.workflow.edges).toEqual([{ from: 'cron', to: 'notify' }]);
    }
  });

  it('non consegna un workflow che la rimozione ha lasciato monco', async () => {
    const res = await runWorkflowAgent({
      goal: 'togli la chiamata http',
      catalog: CATALOG,
      seed,
      chat: scriptedChat([
        [call('delete_node', { nodeId: 'fetch' })],
        [call('finish')],
        [call('finish')],
        [call('finish')],
        [call('finish')],
      ]),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Resta un trigger che non porta da nessuna parte: il workflow non
      // farebbe mai nulla.
      expect(res.qualityIssues.some((i) => i.code === 'ORPHAN_TRIGGER')).toBe(true);
      expect(res.partial?.nodes).toHaveLength(1);
    }
  });
});
