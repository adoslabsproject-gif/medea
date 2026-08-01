/**
 * Test modify — orchestratore della modifica agentica. LlmTurn SCRIPTATO (niente
 * modello reale → niente greensmoke). Verifica E2E i 4 stadi: seed (read-before-
 * edit) → loop → pending-secrets → diff→patch, su scenari reali di modifica:
 *   - aggiungi nodo + collega (il caso che il vecchio chatter NON sapeva fare)
 *   - rimuovi nodo (delete_node) → patch removeNodeIds
 *   - riconfigura nodo → patch updateNodes
 *   - segreto nuovo non configurato → pendingSecrets
 *   - nessun nodo adatto → niente patch, messaggio "crea nell'IDE"
 *   - read-before-edit: i nodi PRE-ESISTENTI restano se non toccati
 * + summarizeModification puro (mutation-checked).
 */
import { describe, it, expect } from 'vitest';
import { modifyWorkflow, summarizeModification, type ModifyWorkflowInput } from './modify.js';
import type { WorkflowSnapshot } from './state.js';
import type { LlmTurn, LlmTurnResult } from '@/services/db-agent/chat/types.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  { defId: 'trigger_webhook', type: 'trigger', label: 'Webhook', description: 'avvio http', fields: [], searchAliases: ['webhook'] },
  {
    defId: 'action_http_request', type: 'action', label: 'HTTP', description: 'http', fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'M', type: 'select', required: true, options: ['GET', 'POST'] },
    ],
  },
  {
    defId: 'action_send_email', type: 'action', label: 'Email', description: 'invia email', searchAliases: ['email', 'mail'],
    fields: [
      { key: 'to', label: 'To', type: 'text', required: true },
      { key: 'apiKey', label: 'Key', type: 'text', required: false },
    ],
  },
];

function scripted(turns: LlmTurnResult[]): LlmTurn {
  let i = 0;
  return () => Promise.resolve(turns[i++] ?? { kind: 'final', text: 'done' });
}
function call(id: string, name: string, args: unknown): LlmTurnResult {
  return { kind: 'tools', toolCalls: [{ id, name, args }] };
}
function base(over: Partial<ModifyWorkflowInput>): ModifyWorkflowInput {
  return {
    catalog: CATALOG,
    currentWorkflow: { nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] },
    request: 'modifica',
    llmTurn: scripted([{ kind: 'final', text: 'done' }]),
    configuredSecrets: new Set<string>(),
    ...over,
  };
}

describe('modifyWorkflow — aggiungi nodo + collega (il caso che il vecchio chatter NON faceva)', () => {
  it('🚨 add email + connect al webhook esistente → patch addNodes + addEdges', async () => {
    const r = await modifyWorkflow(base({
      currentWorkflow: { nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] },
      request: 'aggiungi un nodo email e collegalo al webhook',
      llmTurn: scripted([
        call('1', 'search_nodes', { query: 'email' }),
        call('2', 'add_node', { defId: 'action_send_email', id: 'email', config: { to: 'a@b.it' } }),
        call('3', 'connect', { from: 'w', to: 'email' }),
        call('4', 'finish', {}),
      ]),
    }));
    expect(r.patch.addNodes).toEqual([{ id: 'email', defId: 'action_send_email', config: { to: 'a@b.it' } }]);
    expect(r.patch.addEdges).toEqual([{ id: 'w->email#', from: 'w', to: 'email' }]);
    // 🚨 read-before-edit: il webhook PRE-ESISTENTE non è toccato (non in addNodes/remove)
    expect(r.patch.removeNodeIds).toBeUndefined();
    expect(r.stoppedReason).toBe('finish');
    expect(r.message).toMatch(/aggiunto 1 nodo/u);
  });
});

describe('modifyWorkflow — rimozione', () => {
  it('🚨 delete_node su nodo esistente → patch removeNodeIds (+ edge)', async () => {
    const wf: WorkflowSnapshot = {
      nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }, { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } }],
      edges: [{ from: 'w', to: 'h' }],
    };
    const r = await modifyWorkflow(base({
      currentWorkflow: wf,
      request: 'rimuovi il nodo http',
      llmTurn: scripted([call('1', 'delete_node', { nodeId: 'h' }), call('2', 'finish', {})]),
    }));
    expect(r.patch.removeNodeIds).toEqual(['h']);
    expect(r.patch.removeEdgeIds).toEqual(['w->h#']); // l'edge incidente cade nel diff
    expect(r.patch.addNodes).toBeUndefined();
    expect(r.message).toMatch(/rimosso 1 nodo/u);
  });
});

describe('modifyWorkflow — riconfigurazione', () => {
  it('🚨 set_config su nodo esistente → patch updateNodes con config completa', async () => {
    const wf: WorkflowSnapshot = {
      nodes: [{ id: 'h', defId: 'action_http_request', config: { url: 'https://old', method: 'GET' } }],
      edges: [],
    };
    const r = await modifyWorkflow(base({
      currentWorkflow: wf,
      request: 'cambia il metodo http in POST',
      llmTurn: scripted([call('1', 'set_config', { nodeId: 'h', config: { method: 'POST' }, merge: true }), call('2', 'finish', {})]),
    }));
    expect(r.patch.updateNodes).toEqual([{ id: 'h', patch: { config: { url: 'https://old', method: 'POST' } } }]);
  });
});

describe('modifyWorkflow — pending-secrets (avviso dati sensibili)', () => {
  it('🚨 nodo nuovo con {{secrets.X}} non configurato → pendingSecrets + avviso nel messaggio', async () => {
    const r = await modifyWorkflow(base({
      currentWorkflow: { nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] },
      request: 'aggiungi invio email con la mia api key',
      configuredSecrets: new Set<string>(), // NESSUN segreto configurato
      llmTurn: scripted([
        call('1', 'add_node', { defId: 'action_send_email', id: 'email', config: { to: 'a@b.it', apiKey: '{{secrets.EMAIL_API_KEY}}' } }),
        call('2', 'connect', { from: 'w', to: 'email' }),
        call('3', 'finish', {}),
      ]),
    }));
    expect(r.pendingSecrets.map((s) => s.name)).toEqual(['EMAIL_API_KEY']);
    expect(r.pendingSecrets[0]!.referencedBy).toContain('email');
    expect(r.message).toMatch(/EMAIL_API_KEY/u);
    expect(r.message).toMatch(/configurare a mano/u);
  });

  it('🚨 segreto GIÀ configurato → NON compare in pendingSecrets', async () => {
    const r = await modifyWorkflow(base({
      currentWorkflow: { nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] },
      request: 'aggiungi email',
      configuredSecrets: new Set<string>(['EMAIL_API_KEY']),
      llmTurn: scripted([
        call('1', 'add_node', { defId: 'action_send_email', id: 'email', config: { to: 'a@b.it', apiKey: '{{secrets.EMAIL_API_KEY}}' } }),
        call('2', 'finish', {}),
      ]),
    }));
    expect(r.pendingSecrets).toEqual([]); // mut: se ignora configuredSecrets, fallisce
  });
});

describe('modifyWorkflow — nessun nodo adatto (regola IDE)', () => {
  it('🚨 il modello non trova un nodo e termina FINAL → niente patch, messaggio del modello', async () => {
    const r = await modifyWorkflow(base({
      currentWorkflow: { nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }], edges: [] },
      request: 'aggiungi un nodo che parla con il mio gestionale proprietario',
      llmTurn: scripted([
        call('1', 'search_nodes', { query: 'gestionale proprietario' }), // 0 hit pertinenti
        { kind: 'final', text: 'Non esiste un nodo adatto nel catalogo: crealo nell\'IDE (tab "I Miei Nodi").' },
      ]),
    }));
    expect(r.patch).toEqual({}); // nessuna modifica
    expect(r.stoppedReason).toBe('final');
    expect(r.message).toMatch(/I Miei Nodi/u); // relaya la guida del modello
  });
});

describe('modifyWorkflow — read-before-edit / no-op', () => {
  it('🚨 nessuna operazione del modello → patch vuoto + il workflow esistente è PRESERVATO', async () => {
    const wf: WorkflowSnapshot = {
      nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }, { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } }],
      edges: [{ from: 'w', to: 'h' }],
    };
    const r = await modifyWorkflow(base({ currentWorkflow: wf, request: 'che fa questo workflow?', llmTurn: scripted([{ kind: 'final', text: 'Spiegazione...' }]) }));
    expect(r.patch).toEqual({}); // mut: se NON seedasse, i nodi esistenti apparirebbero come addNodes
  });
});

describe('modifyWorkflow — nodo CUSTOM preesistente non inquina il risultato (bug E2E 2026-06-16)', () => {
  it('🚨 seed con nodo custom + agente aggiunge/collega → remainingIssues VUOTO, no "Restano da sistemare"', async () => {
    const wf: WorkflowSnapshot = {
      nodes: [{ id: 'proxy', defId: 'custom_action_stream_proxy', config: { foo: 'bar' } }],
      edges: [],
    };
    const r = await modifyWorkflow(base({
      currentWorkflow: wf,
      request: 'aggiungi una chiamata http di salute dopo il proxy',
      llmTurn: scripted([
        call('1', 'add_node', { defId: 'action_http_request', id: 'h', config: { url: 'https://x/health', method: 'GET' } }),
        call('2', 'connect', { from: 'proxy', to: 'h' }),
        call('3', 'finish', {}),
      ]),
    }));
    // il nodo custom preesistente NON deve comparire come problema
    expect(r.remainingIssues).toEqual([]);
    expect(r.message).not.toMatch(/Restano da sistemare/u);
    // ma la modifica è avvenuta (read-before-edit: proxy preservato, http collegato)
    expect(r.patch.addNodes?.map((n) => n.id)).toEqual(['h']);
    expect(r.patch.addEdges?.map((e) => e.id)).toEqual(['proxy->h#']);
    expect(r.patch.removeNodeIds).toBeUndefined();
  });
});

describe('summarizeModification (puro)', () => {
  it('patch vuoto + testo modello → usa il testo', () => {
    expect(summarizeModification({}, [], [], 'crea nell\'IDE')).toBe('crea nell\'IDE');
  });
  it('patch vuoto senza testo → messaggio neutro', () => {
    expect(summarizeModification({}, [], [], '   ')).toMatch(/nessun.*cambiament|non comporta/iu);
  });
  it('conta le operazioni + avvisa su secret e issue residue', () => {
    const msg = summarizeModification(
      { addNodes: [{ id: 'a', defId: 'x', config: {} }], addEdges: [{ id: 'a->b#', from: 'a', to: 'b' }] },
      ['Nodo "a": manca url.'],
      [{ name: 'API_KEY', referencedBy: ['a'], fields: ['key'] }],
      '',
    );
    expect(msg).toMatch(/aggiunto 1 nodo/u);
    expect(msg).toMatch(/creato 1 collegamento/u);
    expect(msg).toMatch(/API_KEY/u);
    expect(msg).toMatch(/Restano da sistemare/u);
  });
});
