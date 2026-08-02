/**
 * Test WorkflowBuilder — la lavagna dell'agente. Bug-bounty su ogni operazione:
 * feedback immediato corretto (defId/id/config), niente stati incoerenti.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowBuilder } from './state.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'trigger_webhook',
    type: 'trigger',
    label: 'Webhook',
    description: '',
    fields: [{ key: 'path', label: 'Path', type: 'text', required: false }],
  },
  {
    defId: 'action_http_request',
    type: 'action',
    label: 'HTTP',
    description: '',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'M', type: 'select', required: true, options: ['GET', 'POST'] },
    ],
  },
  {
    defId: 'db_insert',
    type: 'action',
    label: 'DB Insert',
    description: '',
    fields: [{ key: 'table', label: 'T', type: 'text', required: true }],
  },
];

function b(): WorkflowBuilder {
  return new WorkflowBuilder(CATALOG);
}

describe('addNode', () => {
  it('🚨 defId sconosciuto → ok:false (suggerisce search_nodes)', () => {
    const r = b().addNode('action_inventato', undefined, {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/search_nodes/u);
  });

  it('defId valido → ok:true + id auto-derivato (strip prefisso)', () => {
    const r = b().addNode('action_http_request', undefined, { url: 'https://x', method: 'GET' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('http_request'); // id derivato da action_http_request
    expect(r.warnings).toBeUndefined(); // config completa
  });

  it('🚨 config incompleta (manca required url) → ok:true MA warnings col messaggio', () => {
    const r = b().addNode('action_http_request', 'h1', { method: 'GET' });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.join()).toMatch(/url/u);
  });

  it('🚨 id collisione → ok:false', () => {
    const wf = b();
    wf.addNode('db_insert', 'mio', { table: 't' });
    const r = wf.addNode('trigger_webhook', 'mio', {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/id "mio"/u);
  });

  it('🚨 id auto-derivati UNICI (counter su collisione di base)', () => {
    const wf = b();
    wf.addNode('db_insert', undefined, { table: 'a' });
    wf.addNode('db_insert', undefined, { table: 'b' });
    const ids = wf.snapshot().nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2); // distinti
    expect(ids).toContain('insert');
    expect(ids.some((i) => i.includes('insert_2'))).toBe(true);
  });
});

describe('connect', () => {
  it('collega due nodi esistenti', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    expect(wf.connect('w', 'd').ok).toBe(true);
    expect(wf.snapshot().edges).toEqual([{ from: 'w', to: 'd' }]);
  });

  it('🚨 from/to inesistente → ok:false', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    expect(wf.connect('w', 'ghost').ok).toBe(false);
    expect(wf.connect('ghost', 'w').ok).toBe(false);
  });

  it('🚨 collegamento duplicato → ok:false', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'd');
    expect(wf.connect('w', 'd').ok).toBe(false);
  });

  it('fromPort distinto → edge separato (branching logic_if)', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'd', 'true');
    expect(wf.connect('w', 'd', 'false').ok).toBe(true);
    expect(wf.snapshot().edges).toHaveLength(2);
  });
});

describe('setConfig', () => {
  it('🚨 nodo inesistente → ok:false', () => {
    expect(b().setConfig('ghost', { url: 'x' }, true).ok).toBe(false);
  });

  it('merge:true fonde, merge:false rimpiazza', () => {
    const wf = b();
    wf.addNode('action_http_request', 'h', { url: 'https://x', method: 'GET' });
    wf.setConfig('h', { method: 'POST' }, true);
    expect(wf.snapshot().nodes[0]!.config).toEqual({ url: 'https://x', method: 'POST' });
    wf.setConfig('h', { url: 'https://y', method: 'GET' }, false);
    expect(wf.snapshot().nodes[0]!.config).toEqual({ url: 'https://y', method: 'GET' });
  });

  it('🚨 set che lascia config invalida → warnings (enum fuori lista)', () => {
    const wf = b();
    wf.addNode('action_http_request', 'h', { url: 'https://x', method: 'GET' });
    const r = wf.setConfig('h', { method: 'PATCH' }, true);
    expect(r.warnings!.join()).toMatch(/PATCH/u);
  });
});

describe('seed — read-before-edit del workflow esistente', () => {
  it('seeda nodi+edge preservandoli nello snapshot', () => {
    const wf = b();
    wf.seed({
      nodes: [
        { id: 'w', defId: 'trigger_webhook', config: {} },
        { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
      ],
      edges: [{ from: 'w', to: 'h' }],
    });
    const s = wf.snapshot();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['h', 'w']);
    expect(s.edges).toEqual([{ from: 'w', to: 'h' }]);
    expect(wf.hasNode('h')).toBe(true);
  });

  it("🚨 PRESERVA nodi CUSTOM (defId fuori catalog, creati nell'IDE) — non li rifiuta", () => {
    const wf = b();
    wf.seed({
      nodes: [{ id: 'c', defId: 'community_mio_nodo_custom', config: { foo: 'bar' } }],
      edges: [],
    });
    // il nodo custom è presente anche se addNode lo rifiuterebbe (defId non in catalog)
    expect(wf.hasNode('c')).toBe(true);
    expect(wf.snapshot().nodes[0]).toEqual({
      id: 'c',
      defId: 'community_mio_nodo_custom',
      config: { foo: 'bar' },
    });
    expect(wf.addNode('community_mio_nodo_custom', undefined, {}).ok).toBe(false); // mut: addNode resta strict
  });

  it("🚨 seed è una COPIA della config (mutare l'input non tocca il builder)", () => {
    const wf = b();
    const cfg = { url: 'https://x' };
    wf.seed({ nodes: [{ id: 'h', defId: 'action_http_request', config: cfg }], edges: [] });
    cfg.url = 'HACKED';
    expect(wf.snapshot().nodes[0]!.config.url).toBe('https://x');
  });

  it('seed idempotente per id (no edge duplicati su doppio seed)', () => {
    const wf = b();
    const snap = {
      nodes: [
        { id: 'w', defId: 'trigger_webhook', config: {} },
        { id: 'd', defId: 'db_insert', config: { table: 't' } },
      ],
      edges: [{ from: 'w', to: 'd' }],
    };
    wf.seed(snap);
    wf.seed(snap);
    expect(wf.snapshot().nodes).toHaveLength(2); // mut: no duplicati
    expect(wf.snapshot().edges).toHaveLength(1);
  });

  it('🚨 nodo CUSTOM seedato (defId fuori catalog) NON è un unknown_def in validate()', () => {
    const wf = b();
    wf.seed({
      nodes: [{ id: 'c', defId: 'custom_action_stream_proxy', config: { foo: 'bar' } }],
      edges: [],
    });
    // bug scoperto in E2E: il custom preesistente NON deve comparire come issue
    expect(
      wf
        .validate()
        .some((v) => v.kind === 'unknown_def' && v.defId === 'custom_action_stream_proxy'),
    ).toBe(false);
  });

  it('🚨 il filtro custom NON nasconde i problemi dei nodi NUOVI (required mancante)', () => {
    const wf = b();
    wf.seed({ nodes: [{ id: 'c', defId: 'custom_x', config: {} }], edges: [] });
    wf.addNode('action_http_request', 'h', {}); // nuovo, mancano url+method
    const v = wf.validate();
    expect(v.some((x) => x.kind === 'unknown_def' && x.defId === 'custom_x')).toBe(false); // custom silenziato
    expect(v.some((x) => x.kind === 'missing_required' && x.key === 'url')).toBe(true); // ma il nuovo è flaggato
  });

  it('dopo seed il modello può modificare (setConfig su nodo seedato)', () => {
    const wf = b();
    wf.seed({
      nodes: [
        { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
      ],
      edges: [],
    });
    expect(wf.setConfig('h', { method: 'POST' }, true).ok).toBe(true);
    expect(wf.snapshot().nodes[0]!.config).toEqual({ url: 'https://x', method: 'POST' });
  });
});

describe('deleteNode', () => {
  it('🚨 nodo inesistente → ok:false', () => {
    expect(b().deleteNode('ghost').ok).toBe(false);
  });

  it('rimuove il nodo E gli edge che lo toccano (in+out) — niente orfani', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('action_http_request', 'h', { url: 'https://x', method: 'GET' });
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'h');
    wf.connect('h', 'd');
    const r = wf.deleteNode('h');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 collegamento/u); // mut: conteggio edge caduti
    expect(
      wf
        .snapshot()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['d', 'w']);
    expect(wf.snapshot().edges).toEqual([]); // entrambi gli edge incidenti rimossi
    expect(wf.orphanEdges()).toEqual([]);
  });

  it('delete senza edge incidenti → nessun "collegamento" nel messaggio', () => {
    const wf = b();
    wf.addNode('db_insert', 'd', { table: 't' });
    const r = wf.deleteNode('d');
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(/collegamento/u);
  });
});

describe('disconnect', () => {
  it('🚨 edge inesistente → ok:false', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    expect(wf.disconnect('w', 'd').ok).toBe(false);
  });

  it("rimuove l'edge lasciando i nodi", () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'd');
    expect(wf.disconnect('w', 'd').ok).toBe(true);
    expect(wf.snapshot().edges).toEqual([]);
    expect(wf.snapshot().nodes).toHaveLength(2); // i nodi restano
  });

  it('🚨 disconnect rispetta fromPort (rimuove il ramo richiesto, non il primo match)', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'd', 'true'); // edge indice 0
    wf.connect('w', 'd', 'false'); // edge indice 1
    // chiede di rimuovere 'false' (indice 1): se fromPort è ignorato verrebbe
    // tolto il PRIMO match ('true') → ramo sbagliato.
    expect(wf.disconnect('w', 'd', 'false').ok).toBe(true);
    expect(wf.snapshot().edges).toEqual([{ from: 'w', to: 'd', fromPort: 'true' }]);
  });

  it('🚨 disconnect con fromPort che non matcha (esiste solo edge senza porta) → ok:false', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('db_insert', 'd', { table: 't' });
    wf.connect('w', 'd'); // edge senza fromPort
    // se fromPort è ignorato, rimuoverebbe per errore l'edge senza porta
    expect(wf.disconnect('w', 'd', 'true').ok).toBe(false);
    expect(wf.snapshot().edges).toHaveLength(1);
  });
});

describe('validate / orphanEdges / snapshot', () => {
  it('validate aggrega le violazioni di tutti i nodi', () => {
    const wf = b();
    wf.addNode('action_http_request', 'h', {}); // mancano url+method
    const v = wf.validate();
    expect(v.some((x) => x.kind === 'missing_required' && x.key === 'url')).toBe(true);
    expect(v.some((x) => x.kind === 'missing_required' && x.key === 'method')).toBe(true);
  });

  it('workflow completo valido → validate vuoto', () => {
    const wf = b();
    wf.addNode('trigger_webhook', 'w', {});
    wf.addNode('action_http_request', 'h', { url: 'https://x', method: 'GET' });
    wf.connect('w', 'h');
    expect(wf.validate()).toEqual([]);
    expect(wf.orphanEdges()).toEqual([]);
  });

  it('🚨 snapshot è una COPIA (mutarla non tocca il builder)', () => {
    const wf = b();
    wf.addNode('db_insert', 'd', { table: 't' });
    const snap = wf.snapshot();
    snap.nodes[0]!.config.table = 'HACKED';
    snap.nodes.push({ id: 'x', defId: 'y', config: {} });
    expect(wf.snapshot().nodes).toHaveLength(1);
    expect(wf.snapshot().nodes[0]!.config.table).toBe('t');
  });
});
