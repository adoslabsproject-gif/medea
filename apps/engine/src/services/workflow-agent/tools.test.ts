/**
 * Test tools — i 9 strumenti dell'agente via executeWorkflowTool. Verifica
 * happy-path + validazione Zod degli args + tool sconosciuto + wrap errori.
 */
import { describe, it, expect } from 'vitest';
import {
  executeWorkflowTool,
  listWorkflowTools,
  isFinishTool,
  type WorkflowAgentContext,
} from './tools.js';
import { WorkflowBuilder } from './state.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'trigger_webhook',
    type: 'trigger',
    label: 'Webhook',
    description: 'avvio http',
    fields: [],
    searchAliases: ['webhook'],
  },
  {
    defId: 'action_http_request',
    type: 'action',
    label: 'HTTP',
    description: 'chiama http endpoint',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'M', type: 'select', required: true, options: ['GET', 'POST'] },
    ],
  },
  {
    defId: 'db_insert',
    type: 'action',
    label: 'DB Insert',
    description: 'salva database',
    fields: [{ key: 'table', label: 'T', type: 'text', required: true }],
  },
];

function ctx(): WorkflowAgentContext {
  return { builder: new WorkflowBuilder(CATALOG), catalog: CATALOG };
}
function ok(r: ReturnType<typeof executeWorkflowTool>): { ok: true; data: unknown } {
  expect(r.ok).toBe(true);
  return r as { ok: true; data: unknown };
}

describe('listWorkflowTools + isFinishTool', () => {
  it('espone i 9 tool (incl. delete_node/disconnect) con parameters JSON-schema', () => {
    const tools = listWorkflowTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_node',
        'connect',
        'delete_node',
        'disconnect',
        'finish',
        'get_node_schema',
        'search_nodes',
        'set_config',
        'validate_workflow',
      ].sort(),
    );
    for (const t of tools) expect(t.parameters).toMatchObject({ type: 'object' });
  });
  it('isFinishTool', () => {
    expect(isFinishTool('finish')).toBe(true);
    expect(isFinishTool('add_node')).toBe(false);
  });
});

describe('search_nodes / get_node_schema', () => {
  it('search_nodes ritorna hit pertinenti', () => {
    const r = ok(executeWorkflowTool(ctx(), 'search_nodes', { query: 'salva database' }));
    const hits = (r.data as { hits: { defId: string }[] }).hits;
    expect(hits.map((h) => h.defId)).toContain('db_insert');
  });
  it('get_node_schema ritorna i campi + enum', () => {
    const r = ok(executeWorkflowTool(ctx(), 'get_node_schema', { defId: 'action_http_request' }));
    const d = r.data as { fields: { key: string; required: boolean; options?: string[] }[] };
    expect(d.fields.find((f) => f.key === 'method')!.options).toEqual(['GET', 'POST']);
    expect(d.fields.find((f) => f.key === 'url')!.required).toBe(true);
  });
  it('🚨 get_node_schema defId ignoto → error nel data (non lancia)', () => {
    const r = ok(executeWorkflowTool(ctx(), 'get_node_schema', { defId: 'inventato' }));
    expect((r.data as { error?: string }).error).toMatch(/non trovato/u);
  });
});

describe('add_node / connect / set_config su uno stato condiviso', () => {
  it('🚨 build completo end-to-end via tool', () => {
    const c = ctx();
    ok(executeWorkflowTool(c, 'add_node', { defId: 'trigger_webhook', id: 'w' }));
    ok(
      executeWorkflowTool(c, 'add_node', {
        defId: 'action_http_request',
        id: 'h',
        config: { url: 'https://x', method: 'GET' },
      }),
    );
    ok(executeWorkflowTool(c, 'connect', { from: 'w', to: 'h' }));
    const fin = ok(executeWorkflowTool(c, 'finish', {}));
    const snap = fin.data as {
      snapshot: { nodes: unknown[]; edges: unknown[] };
      remainingIssues: string[];
    };
    expect(snap.snapshot.nodes).toHaveLength(2);
    expect(snap.snapshot.edges).toHaveLength(1);
    expect(snap.remainingIssues).toEqual([]);
  });

  it('🚨 add_node defId ignoto → result ok:false dal builder', () => {
    const r = ok(executeWorkflowTool(ctx(), 'add_node', { defId: 'inventato' }));
    expect((r.data as { ok: boolean }).ok).toBe(false);
  });

  it('🚨 add_node con config incompleta → warnings sui required', () => {
    const r = ok(executeWorkflowTool(ctx(), 'add_node', { defId: 'action_http_request', id: 'h' }));
    expect((r.data as { warnings?: string[] }).warnings!.join()).toMatch(/url|method/u);
  });

  it('validate_workflow segnala i required mancanti', () => {
    const c = ctx();
    executeWorkflowTool(c, 'add_node', { defId: 'db_insert', id: 'd' });
    const r = ok(executeWorkflowTool(c, 'validate_workflow', {}));
    const d = r.data as { valid: boolean; issues: string[] };
    expect(d.valid).toBe(false);
    expect(d.issues.join()).toMatch(/table/u);
  });
});

describe('delete_node / disconnect — modifica di workflow esistente', () => {
  it('🚨 delete_node rimuove nodo + edge incidenti (via tool, stato seedato)', () => {
    const c = ctx();
    c.builder.seed({
      nodes: [
        { id: 'w', defId: 'trigger_webhook', config: {} },
        { id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } },
        { id: 'd', defId: 'db_insert', config: { table: 't' } },
      ],
      edges: [
        { from: 'w', to: 'h' },
        { from: 'h', to: 'd' },
      ],
    });
    const r = ok(executeWorkflowTool(c, 'delete_node', { nodeId: 'h' }));
    expect((r.data as { ok: boolean }).ok).toBe(true);
    expect(
      c.builder
        .snapshot()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['d', 'w']);
    expect(c.builder.orphanEdges()).toEqual([]);
  });

  it('🚨 delete_node su nodo inesistente → result ok:false (non lancia)', () => {
    const r = ok(executeWorkflowTool(ctx(), 'delete_node', { nodeId: 'ghost' }));
    expect((r.data as { ok: boolean }).ok).toBe(false);
  });

  it('🚨 delete_node senza nodeId → Zod reject', () => {
    expect(executeWorkflowTool(ctx(), 'delete_node', {}).ok).toBe(false);
  });

  it("disconnect rimuove l'edge richiesto (fromPort onorato)", () => {
    const c = ctx();
    c.builder.seed({
      nodes: [
        { id: 'w', defId: 'trigger_webhook', config: {} },
        { id: 'd', defId: 'db_insert', config: { table: 't' } },
      ],
      edges: [
        { from: 'w', to: 'd', fromPort: 'true' },
        { from: 'w', to: 'd', fromPort: 'false' },
      ],
    });
    ok(executeWorkflowTool(c, 'disconnect', { from: 'w', to: 'd', fromPort: 'false' }));
    expect(c.builder.snapshot().edges).toEqual([{ from: 'w', to: 'd', fromPort: 'true' }]);
  });

  it('🚨 disconnect senza from/to → Zod reject', () => {
    expect(executeWorkflowTool(ctx(), 'disconnect', { from: 'w' }).ok).toBe(false);
  });
});

describe('executeWorkflowTool — robustezza', () => {
  it('🚨 tool sconosciuto → ok:false', () => {
    const r = executeWorkflowTool(ctx(), 'drop_database', {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/sconosciuto/u);
  });

  it('🚨 args che violano lo Zod → ok:false (es. add_node senza defId)', () => {
    const r = executeWorkflowTool(ctx(), 'add_node', { id: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/defId/u);
  });

  it('args null → trattati come {} (tool senza parametri)', () => {
    const r = executeWorkflowTool(ctx(), 'validate_workflow', null);
    expect(r.ok).toBe(true);
  });

  it('🚨 search_nodes con query vuota → Zod reject', () => {
    expect(executeWorkflowTool(ctx(), 'search_nodes', { query: '' }).ok).toBe(false);
  });
});
