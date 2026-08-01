/**
 * Test loop — il driver agentico con LlmTurn SCRIPTATO (niente modello reale →
 * niente greensmoke). Verifica: build completo end-to-end, feedback dei tool
 * ri-alimentato, stop su finish/final/max_iterations, correzione dopo errore.
 */
import { describe, it, expect, vi } from 'vitest';
import { runWorkflowAgent } from './loop.js';
import type { LlmTurn, LlmTurnInput, LlmTurnResult } from '@/services/db-agent/chat/types.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  { defId: 'trigger_webhook', type: 'trigger', label: 'Webhook', description: 'avvio http', fields: [], searchAliases: ['webhook'] },
  {
    defId: 'action_http_request', type: 'action', label: 'HTTP', description: 'http', fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'M', type: 'select', required: true, options: ['GET', 'POST'] },
    ],
  },
];

/** LlmTurn scriptato: ritorna i turni nell'ordine dato; default finisce. */
function scripted(turns: LlmTurnResult[]): { fn: LlmTurn; inputs: LlmTurnInput[] } {
  const inputs: LlmTurnInput[] = [];
  let i = 0;
  const fn: LlmTurn = (input) => {
    inputs.push(input);
    const t = turns[i++] ?? { kind: 'final', text: 'done' };
    return Promise.resolve(t);
  };
  return { fn, inputs };
}
function call(id: string, name: string, args: unknown): LlmTurnResult {
  return { kind: 'tools', toolCalls: [{ id, name, args }] };
}

describe('build completo end-to-end', () => {
  it('🚨 search → add → add → connect → validate → finish: snapshot valido', async () => {
    const { fn, inputs } = scripted([
      call('1', 'search_nodes', { query: 'webhook' }),
      call('2', 'add_node', { defId: 'trigger_webhook', id: 'w' }),
      call('3', 'add_node', { defId: 'action_http_request', id: 'h', config: { url: 'https://x', method: 'GET' } }),
      call('4', 'connect', { from: 'w', to: 'h' }),
      call('5', 'validate_workflow', {}),
      call('6', 'finish', {}),
    ]);
    const onStep = vi.fn();
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'webhook poi http' }, llmTurn: fn, onStep });

    expect(r.stoppedReason).toBe('finish');
    expect(r.snapshot.nodes).toHaveLength(2);
    expect(r.snapshot.edges).toEqual([{ from: 'w', to: 'h' }]);
    expect(r.remainingIssues).toEqual([]);
    expect(r.steps.map((s) => s.tool)).toEqual(['search_nodes', 'add_node', 'add_node', 'connect', 'validate_workflow', 'finish']);
    expect(onStep).toHaveBeenCalledTimes(6);

    // 🚨 FEEDBACK: il 2º turno DEVE aver ricevuto il risultato del search nel thread
    const secondTurnMsgs = inputs[1]!.messages;
    expect(secondTurnMsgs.some((m) => m.role === 'tool' && m.content.includes('hits'))).toBe(true);
    // il system prompt contiene il goal
    expect(inputs[0]!.system).toContain('webhook poi http');
    // i tool sono esposti al modello
    expect(inputs[0]!.tools.map((t) => t.name)).toContain('add_node');
  });
});

describe('correzione dopo errore', () => {
  it('🚨 add_node con defId errato → errore ri-alimentato → il modello corregge', async () => {
    const { fn, inputs } = scripted([
      call('1', 'add_node', { defId: 'INVENTATO' }),       // fallisce
      call('2', 'add_node', { defId: 'trigger_webhook', id: 'w' }), // corregge
      call('3', 'finish', {}),
    ]);
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'g' }, llmTurn: fn });
    expect(r.steps[0]).toEqual({ tool: 'add_node', ok: false });
    expect(r.snapshot.nodes.map((n) => n.defId)).toEqual(['trigger_webhook']);
    // il turno 2 ha ricevuto il messaggio d'errore del builder
    const t2 = inputs[1]!.messages;
    expect(t2.some((m) => m.role === 'tool' && /ok":false|inventato/iu.test(m.content))).toBe(true);
  });
});

describe('condizioni di stop', () => {
  it('risposta FINAL (senza finish) → stoppedReason final + snapshot di quanto costruito', async () => {
    const { fn } = scripted([
      call('1', 'add_node', { defId: 'trigger_webhook', id: 'w' }),
      { kind: 'final', text: 'ho finito' },
    ]);
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'g' }, llmTurn: fn });
    expect(r.stoppedReason).toBe('final');
    expect(r.snapshot.nodes).toHaveLength(1);
  });

  it('🚨 max_iterations: il modello non chiude mai → stop netto, no loop infinito', async () => {
    // llmTurn che chiama SEMPRE validate_workflow, non finisce mai
    const fn: LlmTurn = () => Promise.resolve(call('x', 'validate_workflow', {}));
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'g' }, llmTurn: fn, maxIterations: 4 });
    expect(r.stoppedReason).toBe('max_iterations');
    expect(r.iterations).toBe(4);
    expect(r.steps).toHaveLength(4);
  });

  it('🚨 finish con tool error NON ferma (ok=false) — ma finish non può fallire qui, usa validate poi finish', async () => {
    // sanity: un finish ok chiude; un tool sconosciuto prima NON chiude
    const { fn } = scripted([
      call('1', 'tool_inesistente', {}),
      call('2', 'finish', {}),
    ]);
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'g' }, llmTurn: fn });
    expect(r.steps[0]).toEqual({ tool: 'tool_inesistente', ok: false });
    expect(r.stoppedReason).toBe('finish');
  });
});

describe('iniezione builder + initial message (modalità MODIFICA)', () => {
  it('🚨 default (create): initial message storico + system derivato dal prompt', async () => {
    const { fn, inputs } = scripted([{ kind: 'final', text: 'ok' }]);
    await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'mio goal' }, llmTurn: fn });
    expect(inputs[0]!.messages[0]!.content).toContain('Inizia con search_nodes');
    expect(inputs[0]!.system).toContain('mio goal'); // mut: se ignora prompt, fallisce
  });

  it('🚨 builder iniettato + seedato → l\'agente PARTE dal workflow esistente (read-before-edit)', async () => {
    const { WorkflowBuilder } = await import('./state.js');
    const builder = new WorkflowBuilder(CATALOG);
    builder.seed({ nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] });
    // il modello aggiunge un nodo http e lo collega al trigger PRE-ESISTENTE
    const { fn } = scripted([
      call('1', 'add_node', { defId: 'action_http_request', id: 'h', config: { url: 'https://x', method: 'GET' } }),
      call('2', 'connect', { from: 'w', to: 'h' }),
      call('3', 'finish', {}),
    ]);
    const r = await runWorkflowAgent({
      catalog: CATALOG, prompt: { goal: 'aggiungi http' }, llmTurn: fn,
      builder, initialUserMessage: 'Modifica: aggiungi un nodo http e collegalo al webhook.',
    });
    // il trigger seedato è ancora lì + il nodo aggiunto → connect è valido
    expect(r.snapshot.nodes.map((n) => n.id).sort()).toEqual(['h', 'w']);
    expect(r.snapshot.edges).toEqual([{ from: 'w', to: 'h' }]); // mut: senza builder iniettato, 'w' non esiste → connect fallirebbe
    expect(r.remainingIssues).toEqual([]);
  });

  it('🚨 systemPrompt iniettato è usato VERBATIM (modify-mode prompt)', async () => {
    const { fn, inputs } = scripted([{ kind: 'final', text: 'ok' }]);
    await runWorkflowAgent({
      catalog: CATALOG, prompt: { goal: 'x' }, llmTurn: fn,
      systemPrompt: 'PROMPT-MODIFICA-CUSTOM-XYZ',
    });
    expect(inputs[0]!.system).toBe('PROMPT-MODIFICA-CUSTOM-XYZ');
  });

  it('🚨 finalText = testo dell\'ultimo turno final (es. "crea il nodo nell\'IDE")', async () => {
    const { fn } = scripted([{ kind: 'final', text: 'Non c\'è un nodo adatto: crealo nell\'IDE.' }]);
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'x' }, llmTurn: fn });
    expect(r.finalText).toBe('Non c\'è un nodo adatto: crealo nell\'IDE.');
  });

  it('finalText cattura anche l\'ultimo testo prima di finish', async () => {
    const { fn } = scripted([
      { kind: 'tools', text: 'aggiungo il trigger', toolCalls: [{ id: '1', name: 'add_node', args: { defId: 'trigger_webhook', id: 'w' } }] },
      call('2', 'finish', {}),
    ]);
    const r = await runWorkflowAgent({ catalog: CATALOG, prompt: { goal: 'x' }, llmTurn: fn });
    expect(r.finalText).toBe('aggiungo il trigger');
  });
});

describe('buildWorkflowAgentPrompt', () => {
  it('include goal + i passi dei tool + contesto opzionale', async () => {
    const { buildWorkflowAgentPrompt } = await import('./prompt.js');
    const p = buildWorkflowAgentPrompt({ goal: 'manda email', extraContext: 'DB: clienti(id,email)' });
    expect(p).toContain('manda email');
    expect(p).toContain('search_nodes');
    expect(p).toContain('clienti(id,email)');
  });
  it('senza extraContext → nessuna sezione CONTESTO', async () => {
    const { buildWorkflowAgentPrompt } = await import('./prompt.js');
    expect(buildWorkflowAgentPrompt({ goal: 'x' })).not.toContain('CONTESTO:');
  });
});
