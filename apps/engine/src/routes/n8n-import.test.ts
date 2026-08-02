/**
 * Test 2026-grade — n8n-import route.
 *
 * 🚨 PARSING UNTRUSTED INPUT: bug magnet. JSON arbitrario dell'utente →
 *    serializzato in workflow runtime. Test aggressivo su edge case.
 *
 * 🚨 ID SANITIZATION: regex /[^a-z0-9_-]/gi → ID FlowForge safe.
 *
 * 🚨 NODE TYPE MAPPING: 23 mapping noti, unmapped → fallback action_http.
 *
 * 🚨 CONNECTIONS: n8n usa `node.name` come key. Test collisione + missing target.
 *
 * 🚨 STATS: nodesImported, edgesImported, unmappedTypes accuracy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const workflowCreateMock = vi.fn();
class WorkflowServiceMock {
  create = workflowCreateMock;
}
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: WorkflowServiceMock,
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));
vi.mock('@/lib/actor.js', () => ({
  getActorId: () => 'actor-1',
}));

const { createN8nImportRoutes } = await import('./n8n-import.js');

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/v1', createN8nImportRoutes({} as never));
  return app;
}

async function importN8n(body: unknown): Promise<Response> {
  return makeApp().request('/api/v1/import/n8n', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowCreateMock.mockResolvedValue({
    id: 'wf-imported',
    name: 'Imported',
    nodes: [],
    edges: [],
  });
});

describe('🚨 input validation', () => {
  it('🚨 body null → 400', async () => {
    const res = await importN8n('null');
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/JSON object/u);
  });

  it('🚨 body array (non object) → 400', async () => {
    // typeof [] === 'object' → passa il check, ma è valid array workflow null
    const res = await importN8n([]);
    // L'array passa typeof check, viene processato come N8nWorkflow vuoto
    expect(res.status).toBe(201);
  });

  it('🚨 body number → 400', async () => {
    const res = await importN8n('42');
    expect(res.status).toBe(400);
  });

  it('🚨 body string → 400', async () => {
    const res = await importN8n('"raw-string"');
    expect(res.status).toBe(400);
  });

  it('🚨 body vuoto {} → 201 workflow vuoto', async () => {
    const res = await importN8n({});
    expect(res.status).toBe(201);
    const created = workflowCreateMock.mock.calls[0]![0] as {
      name: string;
      nodes: unknown[];
      edges: unknown[];
    };
    expect(created.name).toBe('Imported from n8n');
    expect(created.nodes).toEqual([]);
    expect(created.edges).toEqual([]);
  });
});

describe('🚨 node type mapping', () => {
  it('🚨 mappa httpRequest → action_http', async () => {
    await importN8n({
      nodes: [{ id: 'n1', name: 'HTTP', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('action_http');
  });

  it('🚨 mappa scheduleTrigger → trigger_cron', async () => {
    await importN8n({
      nodes: [{ name: 'Cron', type: 'n8n-nodes-base.scheduleTrigger' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('trigger_cron');
  });

  it('🚨 mappa start + manualTrigger → trigger_manual (alias)', async () => {
    await importN8n({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.start' },
        { name: 'Manual', type: 'n8n-nodes-base.manualTrigger' },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('trigger_manual');
    expect(created.nodes[1]!.defId).toBe('trigger_manual');
  });

  it('🚨 AI: openAi/anthropic → action_llm_complete (nodo LLM REALE, non HTTP)', async () => {
    // Bug latente chiuso: la vecchia mappa puntava a "ai_openai" INESISTENTE → nodo
    // che non si carica. Ora mappa al nodo LLM VERO action_llm_complete (FlowForge ce
    // l'ha): l'intento AI NON è degradato a una fetch HTTP generica.
    await importN8n({
      nodes: [
        { name: 'AI', type: '@n8n/n8n-nodes-langchain.openAi' },
        { name: 'AI2', type: '@n8n/n8n-nodes-langchain.anthropic' },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('action_llm_complete');
    expect(created.nodes[1]!.defId).toBe('action_llm_complete');
  });

  it('🚨 community VERI → community_*; stripe (fantasma) → action_http', async () => {
    // slack/discord/github/notion/telegram esistono nel catalog → community_<vendor>.
    // stripe NON esiste (era community_stripe fantasma) → fallback action_http reale.
    const types = [
      ['slack', 'community_slack'],
      ['discord', 'community_discord'],
      ['github', 'community_github'],
      ['notion', 'community_notion'],
      ['telegram', 'community_telegram'],
      ['stripe', 'action_http'], // no defId fantasma
    ];
    for (const [n8nType, expected] of types) {
      workflowCreateMock.mockClear();
      await importN8n({
        nodes: [{ name: 'X', type: `n8n-nodes-base.${n8nType}` }],
      });
      const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
      expect(created.nodes[0]!.defId).toBe(expected);
    }
  });

  it('🚨 IF n8n (v2) → logic_if con conditionRules mappate (end-to-end)', async () => {
    await importN8n({
      nodes: [
        {
          name: 'Gate',
          type: 'n8n-nodes-base.if',
          parameters: {
            conditions: {
              combinator: 'and',
              conditions: [
                {
                  leftValue: '={{ $json.status }}',
                  rightValue: 'active',
                  operator: { type: 'string', operation: 'equals' },
                },
              ],
            },
          },
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { defId: string; config: Record<string, string> }[];
    };
    expect(created.nodes[0]!.defId).toBe('logic_if');
    const rules = JSON.parse(created.nodes[0]!.config.conditionRules ?? '{}') as {
      rules: { left: string; op: string; right: string }[];
    };
    expect(rules.rules[0]).toEqual({
      left: 'input.status',
      op: 'equals',
      type: 'string',
      right: 'active',
    });
  });

  it('🚨 Function n8n = CODE → action_run_js (non logic_transform); Set → logic_transform', async () => {
    await importN8n({
      nodes: [
        { name: 'Fn', type: 'n8n-nodes-base.function' },
        { name: 'St', type: 'n8n-nodes-base.set' },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('action_run_js'); // Function = code node
    expect(created.nodes[1]!.defId).toBe('logic_transform'); // Set = mapper
  });

  it('🚨 UNMAPPED: fallback a action_http + warning', async () => {
    const res = await importN8n({
      nodes: [
        { name: 'Custom1', type: 'n8n-nodes-base.veryCustomThing' },
        { name: 'Custom2', type: 'community.foo' },
      ],
    });
    const json = (await res.json()) as { stats: { unmappedTypes: string[]; warnings: string } };
    expect(json.stats.unmappedTypes).toHaveLength(2);
    expect(json.stats.unmappedTypes).toContain('n8n-nodes-base.veryCustomThing');
    expect(json.stats.warnings).toMatch(/2 node type\(s\)/u);

    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { defId: string }[] };
    expect(created.nodes[0]!.defId).toBe('action_http');
    expect(created.nodes[1]!.defId).toBe('action_http');
  });

  it('🚨 unmappedTypes vuoto → warnings null (NO message false alarm)', async () => {
    const res = await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.httpRequest' }],
    });
    const json = (await res.json()) as { stats: { warnings: string | null } };
    expect(json.stats.warnings).toBeNull();
  });

  it('🚨 deduplication unmappedTypes: 5 nodi stesso type → 1 entry', async () => {
    const res = await importN8n({
      nodes: Array.from({ length: 5 }, (_, i) => ({
        name: `Custom${i}`,
        type: 'totally.unknown',
      })),
    });
    const json = (await res.json()) as { stats: { unmappedTypes: string[] } };
    expect(json.stats.unmappedTypes).toHaveLength(1);
  });
});

describe('🚨 ID sanitization', () => {
  it('🚨 caratteri SAFE preservati ([a-zA-Z0-9_-])', async () => {
    await importN8n({
      nodes: [{ id: 'My-Node_1', name: 'X', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { id: string }[] };
    expect(created.nodes[0]!.id).toBe('My-Node_1');
  });

  it('🚨 caratteri unsafe → underscore (regex case-insensitive)', async () => {
    await importN8n({
      nodes: [{ id: 'My Node!@#$', name: 'X', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { id: string }[] };
    expect(created.nodes[0]!.id).toBe('My_Node____');
  });

  it('🚨 ID assente → usa node.name + index suffix', async () => {
    await importN8n({
      nodes: [
        { name: 'First Node', type: 'n8n-nodes-base.httpRequest' },
        { name: 'Second', type: 'n8n-nodes-base.httpRequest' },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { id: string }[] };
    expect(created.nodes[0]!.id).toBe('First_Node_0');
    expect(created.nodes[1]!.id).toBe('Second_1');
  });

  it('🚨 ID presente → NO suffix index', async () => {
    await importN8n({
      nodes: [{ id: 'my-id', name: 'X', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { id: string }[] };
    expect(created.nodes[0]!.id).toBe('my-id');
    expect(created.nodes[0]!.id).not.toMatch(/_0$/u);
  });

  it('🚨 Unicode/emoji name → sanitizzato', async () => {
    await importN8n({
      nodes: [{ name: 'Nodo Italiano à 🚨', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { id: string }[] };
    expect(created.nodes[0]!.id).toMatch(/^Nodo_Italiano_+_+0$/u);
  });
});

describe('🚨 position handling', () => {
  it('🚨 position presente → coordinate preserved', async () => {
    await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.httpRequest', position: [500, 300] }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { x: number; y: number }[] };
    expect(created.nodes[0]!.x).toBe(500);
    expect(created.nodes[0]!.y).toBe(300);
  });

  it('🚨 position assente → default (idx * 200, 100) — auto-layout', async () => {
    await importN8n({
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.httpRequest' },
        { name: 'B', type: 'n8n-nodes-base.httpRequest' },
        { name: 'C', type: 'n8n-nodes-base.httpRequest' },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { x: number; y: number }[] };
    expect(created.nodes[0]).toMatchObject({ x: 0, y: 100 });
    expect(created.nodes[1]).toMatchObject({ x: 200, y: 100 });
    expect(created.nodes[2]).toMatchObject({ x: 400, y: 100 });
  });

  it('🚨 position parziale: solo X → Y default fallback (??=100)', async () => {
    // position è tuple [number, number], se è [500] (1 elemento) → position[1] = undefined → ?? 100
    await importN8n({
      nodes: [
        {
          name: 'X',
          type: 'n8n-nodes-base.httpRequest',
          position: [500] as unknown as [number, number],
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { nodes: { x: number; y: number }[] };
    expect(created.nodes[0]!.x).toBe(500);
    expect(created.nodes[0]!.y).toBe(100);
  });
});

describe('🚨 parameters / config conversion', () => {
  it('🚨 parameters string preserved as-is', async () => {
    await importN8n({
      nodes: [
        {
          name: 'X',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'https://api.example.com', method: 'GET' },
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string> }[];
    };
    expect(created.nodes[0]!.config.url).toBe('https://api.example.com');
    expect(created.nodes[0]!.config.method).toBe('GET');
  });

  it('🚨 tipo PASSTHROUGH (Set): parametri non-string preservati via JSON.stringify', async () => {
    // I tipi a struttura complessa (Set/IF/Switch) preservano i param RAW per review.
    await importN8n({
      nodes: [
        {
          name: 'X',
          type: 'n8n-nodes-base.set',
          parameters: { timeout: 30000, enabled: true, tags: ['a', 'b'], opts: { retry: 3 } },
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string> }[];
    };
    expect(created.nodes[0]!.config.timeout).toBe('30000');
    expect(created.nodes[0]!.config.enabled).toBe('true');
    expect(created.nodes[0]!.config.tags).toBe('["a","b"]');
    expect(created.nodes[0]!.config.opts).toBe('{"retry":3}');
  });

  it('🚨 parameters assente (Set) → config con solo _n8nOriginalType', async () => {
    await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.set' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string> }[];
    };
    expect(Object.keys(created.nodes[0]!.config)).toEqual(['_n8nOriginalType']);
  });

  it('🚨 MAPPING REALE HTTP: url/method/body ai campi FlowForge (non raw n8n)', async () => {
    await importN8n({
      nodes: [
        {
          name: 'X',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            method: 'post',
            url: 'https://api.com/x',
            jsonBody: '{"a":1}',
            timeout: 30000,
            authentication: 'genericCredentialType',
          },
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string> }[];
    };
    const cfg = created.nodes[0]!.config;
    expect(cfg.method).toBe('POST'); // normalizzato uppercase
    expect(cfg.url).toBe('https://api.com/x');
    expect(cfg.bodyType).toBe('json');
    expect(cfg.body).toBe('{"a":1}');
    expect(cfg.timeout).toBeUndefined(); // param n8n non pertinente: NON copiato raw
  });

  it('🚨 ESPRESSIONI transpilate: $node["Nome"] → $node.<id>, leading = strippato', async () => {
    await importN8n({
      nodes: [
        { name: 'Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: 'hook' } },
        {
          name: 'Call',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: '=https://api.com/{{ $node["Trigger"].json["userId"] }}' },
        },
      ],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { id: string; config: Record<string, string> }[];
    };
    const triggerId = created.nodes[0]!.id;
    expect(created.nodes[1]!.config.url).toBe(`https://api.com/{{$node.${triggerId}.json.userId}}`);
  });

  it('🚨 WARNING di mapping esposti nelle stats (auth/header/espressioni da rivedere)', async () => {
    const res = await importN8n({
      nodes: [
        {
          name: 'Call',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            url: 'https://x',
            authentication: 'genericCredentialType',
            sendHeaders: true,
          },
        },
      ],
    });
    const json = (await res.json()) as { stats: { mappingWarnings: string[] } };
    expect(json.stats.mappingWarnings.some((w) => w.includes('autenticazione'))).toBe(true);
    expect(json.stats.mappingWarnings.some((w) => w.includes('header'))).toBe(true);
  });

  it('🚨 _n8nOriginalType SEMPRE settato (anche per nodi mappati)', async () => {
    await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.httpRequest' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string> }[];
    };
    expect(created.nodes[0]!.config._n8nOriginalType).toBe('n8n-nodes-base.httpRequest');
  });

  it('🚨 _n8nOriginalType per nodi UNMAPPED (forensic audit)', async () => {
    await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.veryCustomThing' }],
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      nodes: { config: Record<string, string>; defId: string }[];
    };
    expect(created.nodes[0]!.defId).toBe('action_http');
    expect(created.nodes[0]!.config._n8nOriginalType).toBe('n8n-nodes-base.veryCustomThing');
  });
});

describe('🚨 connections / edges', () => {
  it('🚨 mappa connections n8n → edges {from, to}', async () => {
    const res = await importN8n({
      nodes: [
        { id: 'a', name: 'A', type: 'n8n-nodes-base.start' },
        { id: 'b', name: 'B', type: 'n8n-nodes-base.httpRequest' },
      ],
      connections: {
        A: { main: [[{ node: 'B' }]] },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      edges: { from: string; to: string }[];
    };
    expect(created.edges).toHaveLength(1);
    expect(created.edges[0]).toEqual({ from: 'a', to: 'b' });
    const json = (await res.json()) as { stats: { edgesImported: number } };
    expect(json.stats.edgesImported).toBe(1);
  });

  it('🚨 multi-branch connections (fanout)', async () => {
    await importN8n({
      nodes: [
        { id: 'src', name: 'Source', type: 'n8n-nodes-base.start' },
        { id: 't1', name: 'T1', type: 'n8n-nodes-base.httpRequest' },
        { id: 't2', name: 'T2', type: 'n8n-nodes-base.httpRequest' },
      ],
      connections: {
        Source: {
          main: [[{ node: 'T1' }, { node: 'T2' }]],
        },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      edges: { from: string; to: string }[];
    };
    expect(created.edges).toHaveLength(2);
    expect(created.edges.some((e) => e.to === 't1')).toBe(true);
    expect(created.edges.some((e) => e.to === 't2')).toBe(true);
  });

  it('🚨 multi-output connections (if true/false branches)', async () => {
    await importN8n({
      nodes: [
        { id: 'if', name: 'IF', type: 'n8n-nodes-base.if' },
        { id: 't', name: 'TrueBranch', type: 'n8n-nodes-base.httpRequest' },
        { id: 'f', name: 'FalseBranch', type: 'n8n-nodes-base.httpRequest' },
      ],
      connections: {
        IF: {
          main: [[{ node: 'TrueBranch' }], [{ node: 'FalseBranch' }]],
        },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      edges: { from: string; to: string }[];
    };
    expect(created.edges).toHaveLength(2);
  });

  it('🚨 SECURITY: target NOT in nodeIdMap → edge SCARTATO (no orphan)', async () => {
    await importN8n({
      nodes: [{ id: 'a', name: 'A', type: 'n8n-nodes-base.httpRequest' }],
      connections: {
        A: { main: [[{ node: 'NonExistent' }]] },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { edges: unknown[] };
    expect(created.edges).toEqual([]); // orphan target skipped
  });

  it('🚨 source name NOT in map (n8n bug) → edge SCARTATO', async () => {
    await importN8n({
      nodes: [{ id: 'b', name: 'B', type: 'n8n-nodes-base.httpRequest' }],
      connections: {
        UnknownSource: { main: [[{ node: 'B' }]] },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { edges: unknown[] };
    expect(created.edges).toEqual([]);
  });

  it('🚨 connections vuoto → edges []', async () => {
    await importN8n({
      nodes: [{ name: 'X', type: 'n8n-nodes-base.httpRequest' }],
      connections: {},
    });
    const created = workflowCreateMock.mock.calls[0]![0] as { edges: unknown[] };
    expect(created.edges).toEqual([]);
  });
});

describe('🚨 workflow metadata', () => {
  it('🚨 default name = "Imported from n8n"', async () => {
    await importN8n({ nodes: [] });
    const created = workflowCreateMock.mock.calls[0]![0] as { name: string };
    expect(created.name).toBe('Imported from n8n');
  });

  it('🚨 custom name preserved', async () => {
    await importN8n({ name: 'My Custom Workflow' });
    const created = workflowCreateMock.mock.calls[0]![0] as { name: string };
    expect(created.name).toBe('My Custom Workflow');
  });

  it('🚨 enabled SEMPRE false (manual review prima di abilitare)', async () => {
    await importN8n({ name: 'X' });
    const created = workflowCreateMock.mock.calls[0]![0] as { enabled: boolean };
    expect(created.enabled).toBe(false);
  });

  it('🚨 tags include "imported-from-n8n" per filtering admin', async () => {
    await importN8n({ name: 'X' });
    const created = workflowCreateMock.mock.calls[0]![0] as { tags: string[] };
    expect(created.tags).toContain('imported-from-n8n');
  });

  it('🚨 tenantId + createdBy popolati da context (audit trail)', async () => {
    await importN8n({ name: 'X' });
    const created = workflowCreateMock.mock.calls[0]![0] as { tenantId: string; createdBy: string };
    expect(created.tenantId).toBe('tenant-A');
    expect(created.createdBy).toBe('actor-1');
  });
});

describe('🚨 stats response shape', () => {
  it('🚨 ritorna nodesImported + edgesImported + unmappedTypes + warnings', async () => {
    const res = await importN8n({
      nodes: [
        { name: 'A', type: 'n8n-nodes-base.httpRequest' },
        { name: 'B', type: 'unknown.xyz' },
      ],
      connections: { A: { main: [[{ node: 'B' }]] } },
    });
    const json = (await res.json()) as {
      stats: {
        nodesImported: number;
        edgesImported: number;
        unmappedTypes: string[];
        warnings: string | null;
      };
    };
    expect(json.stats.nodesImported).toBe(2);
    expect(json.stats.edgesImported).toBe(1);
    expect(json.stats.unmappedTypes).toEqual(['unknown.xyz']);
    expect(json.stats.warnings).toMatch(/1 node type\(s\)/u);
  });

  it('🚨 workflow object ritornato dentro response', async () => {
    workflowCreateMock.mockResolvedValueOnce({ id: 'wf-NEW', name: 'X' });
    const res = await importN8n({ name: 'X' });
    const json = (await res.json()) as { workflow: { id: string } };
    expect(json.workflow.id).toBe('wf-NEW');
  });
});

describe('🚨 name collision edge case', () => {
  it('🚨 BUG: 2 nodi stesso name → nodeIdMap overwrite (last wins)', async () => {
    // PROBLEMA REALE: n8n consente nomi duplicati. nodeIdMap.set(name, id) → overwrite
    // → connections riferite al "primo" puntano al "secondo".
    await importN8n({
      nodes: [
        { id: 'first', name: 'Duplicate', type: 'n8n-nodes-base.httpRequest' },
        { id: 'second', name: 'Duplicate', type: 'n8n-nodes-base.httpRequest' },
        { id: 'target', name: 'Target', type: 'n8n-nodes-base.httpRequest' },
      ],
      connections: {
        Duplicate: { main: [[{ node: 'Target' }]] },
      },
    });
    const created = workflowCreateMock.mock.calls[0]![0] as {
      edges: { from: string; to: string }[];
    };
    // L'edge esce dal SECONDO (last-in-map wins)
    expect(created.edges).toHaveLength(1);
    expect(created.edges[0]!.from).toBe('second');
    expect(created.edges[0]!.to).toBe('target');
  });
});
