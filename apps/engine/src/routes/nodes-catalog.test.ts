/**
 * Test 2026-grade — nodes-catalog route.
 *
 * 🚨 AUTH: c.get('auth') null → 401 (no public catalog leak).
 *
 * 🚨 FILTER: ?type + ?package compongono filtri AND.
 *
 * 🚨 MAPPING: configFields + actions + deprecated + verified
 *    correttamente serializzati (no executors, no secrets).
 *
 * 🚨 COMMUNITY MERGE: bundled (statico) + community (dinamico per request).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const stdlibMods = [
  {
    def: {
      id: 'action_http',
      type: 'action',
      label: 'HTTP Request',
      icon: '🌐',
      color: '#3b82f6',
      description: 'Send HTTP',
      configFields: [
        { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://...' },
        {
          key: 'method',
          label: 'Method',
          type: 'select',
          required: true,
          options: ['GET', 'POST'],
          defaultValue: 'GET',
        },
      ],
      outputs: ['main'],
      vendor: 'flowforge',
      version: '1.0.0',
    },
  },
  {
    def: {
      id: 'trigger_webhook',
      type: 'trigger',
      label: 'Webhook',
      icon: '🪝',
      color: '#06b6d4',
      description: 'HTTP trigger',
      outputs: ['main'],
    },
  },
  {
    def: {
      id: 'legacy_node',
      type: 'action',
      label: 'Legacy',
      icon: '🗑️',
      color: '#999',
      description: 'old',
      deprecated: true,
    },
  },
];

vi.mock('@medea/engine-nodes-stdlib', () => ({ stdlibNodes: stdlibMods }));
vi.mock('@medea/engine-nodes-db', () => ({
  dbNodes: [
    {
      def: {
        id: 'db_query',
        type: 'action',
        label: 'DB Query',
        icon: '💾',
        color: '#9333ea',
        description: 'Run SQL',
        outputs: ['main'],
      },
    },
  ],
}));
vi.mock('@medea/engine-nodes-integrations-core', () => ({
  coreIntegrationNodes: [],
}));
vi.mock('@medea/engine-nodes-integrations-italia', () => ({
  italianConnectors: [
    {
      def: {
        id: 'sigla_invoice',
        type: 'action',
        label: 'Sigla Invoice',
        icon: '🇮🇹',
        color: '#fff',
        description: 'Italian ERP',
        outputs: ['main'],
      },
    },
  ],
}));
vi.mock('@medea/engine-nodes-ai-agents', () => ({
  aiAgentNodes: [
    {
      def: {
        id: 'agent_classify',
        type: 'ai',
        label: 'Classify',
        icon: '🤖',
        color: '#000',
        description: 'AI classifier',
        actions: [
          {
            id: 'classify',
            label: 'Classify',
            description: 'classify desc',
            category: 'ai',
            aiAction: true,
            configFields: [{ key: 'categories', label: 'Cat', type: 'text', required: true }],
          },
        ],
        outputs: ['main'],
      },
    },
  ],
}));
vi.mock('@medea/engine-nodes-llm', () => ({ llmNodes: [] }));

const listInstalledMock = vi.fn(() => [] as { def: unknown; verified?: boolean }[]);
vi.mock('@/services/community-nodes.service.js', () => ({
  listInstalled: listInstalledMock,
}));

const { createNodesCatalogRoutes } = await import('./nodes-catalog.js');

function makeApp(authenticated = true): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authenticated) c.set('auth' as never, { userId: 'u1' } as never);
    return next();
  });
  app.route('/api/v1/nodes', createNodesCatalogRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstalledMock.mockReturnValue([]);
});

describe('🚨 auth gate', () => {
  it('🚨 no auth → 401', async () => {
    const app = makeApp(false);
    const res = await app.request('/api/v1/nodes');
    expect(res.status).toBe(401);
  });
});

describe('🚨 catalog static (bundled)', () => {
  it('🚨 ritorna tutti i nodi bundled (4 mock fra stdlib/db/italia/ai)', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { nodes: { id: string; package: string }[]; total: number };
    // 3 stdlib + 1 db + 0 core + 1 italia + 1 ai + 0 llm = 6
    expect(json.total).toBe(6);
    expect(json.nodes.some((n) => n.id === 'action_http')).toBe(true);
    expect(json.nodes.some((n) => n.id === 'db_query' && n.package === 'db')).toBe(true);
  });

  it('🚨 mapping: configFields preserved con placeholder/options/defaultValue', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as {
      nodes: {
        id: string;
        configFields: { key: string; placeholder?: string; options?: string[] }[];
      }[];
    };
    const http = json.nodes.find((n) => n.id === 'action_http')!;
    expect(http.configFields).toHaveLength(2);
    expect(http.configFields[0]!.placeholder).toBe('https://...');
    expect(http.configFields[1]!.options).toEqual(['GET', 'POST']);
  });

  it('🚨 mapping: actions con aiAction + category propagati', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as {
      nodes: { id: string; actions?: { aiAction?: boolean; category?: string }[] }[];
    };
    const ai = json.nodes.find((n) => n.id === 'agent_classify')!;
    expect(ai.actions).toBeDefined();
    expect(ai.actions![0]!.aiAction).toBe(true);
    expect(ai.actions![0]!.category).toBe('ai');
  });

  it('🚨 mapping: deprecated flag preservato', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as { nodes: { id: string; deprecated?: boolean }[] };
    const legacy = json.nodes.find((n) => n.id === 'legacy_node')!;
    expect(legacy.deprecated).toBe(true);
  });

  it('🚨 mapping: outputs default [] se NodeDef non li definisce', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as { nodes: { id: string; outputs: string[] }[] };
    const legacy = json.nodes.find((n) => n.id === 'legacy_node')!;
    expect(legacy.outputs).toEqual([]);
  });

  it('🚨 configFields default required:false / type:"text" se omessi', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as {
      nodes: { id: string; configFields: { required: boolean; type: string }[] }[];
    };
    // legacy_node ha 0 configFields → array vuoto
    const legacy = json.nodes.find((n) => n.id === 'legacy_node')!;
    expect(legacy.configFields).toEqual([]);
  });
});

describe('🚨 community nodes merge', () => {
  it('🚨 listInstalled appended dinamicamente con package=community + verified', async () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'community_zapier',
          type: 'action',
          label: 'Zapier Webhook',
          icon: '⚡',
          color: '#000',
          description: 'Zapier',
          outputs: ['main'],
        },
        verified: true,
      },
    ]);
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as {
      nodes: { id: string; package: string; verified?: boolean }[];
    };
    const zap = json.nodes.find((n) => n.id === 'community_zapier')!;
    expect(zap.package).toBe('community');
    expect(zap.verified).toBe(true);
  });

  it('🚨 community verified=false → flag preserved', async () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'community_unverified',
          type: 'action',
          label: 'X',
          icon: 'x',
          color: '#000',
          description: 'X',
          outputs: [],
        },
        verified: false,
      },
    ]);
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const json = (await res.json()) as { nodes: { id: string; verified?: boolean }[] };
    const node = json.nodes.find((n) => n.id === 'community_unverified')!;
    expect(node.verified).toBe(false);
  });
});

describe('🚨 ?type filter', () => {
  it('🚨 ?type=trigger → solo nodi type=trigger', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?type=trigger');
    const json = (await res.json()) as { nodes: { type: string }[]; total: number };
    expect(json.total).toBe(1);
    expect(json.nodes.every((n) => n.type === 'trigger')).toBe(true);
  });

  it('🚨 ?type=ai → solo agent nodes', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?type=ai');
    const json = (await res.json()) as { nodes: { id: string }[]; total: number };
    expect(json.total).toBe(1);
    expect(json.nodes[0]!.id).toBe('agent_classify');
  });

  it('🚨 ?type=inesistente → total 0', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?type=fake');
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(0);
  });
});

describe('🚨 ?package filter', () => {
  it('🚨 ?package=stdlib → solo 3 nodi stdlib (incluso legacy + 2 attivi)', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?package=stdlib');
    const json = (await res.json()) as { nodes: { package: string }[]; total: number };
    expect(json.total).toBe(3);
    expect(json.nodes.every((n) => n.package === 'stdlib')).toBe(true);
  });

  it('🚨 ?package=integrations-italia → 1 nodo', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?package=integrations-italia');
    const json = (await res.json()) as { nodes: { id: string }[]; total: number };
    expect(json.total).toBe(1);
    expect(json.nodes[0]!.id).toBe('sigla_invoice');
  });
});

describe('🚨 filters combinabili (AND)', () => {
  it('🚨 ?type=action&package=stdlib → solo action stdlib', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?type=action&package=stdlib');
    const json = (await res.json()) as {
      nodes: { id: string; type: string; package: string }[];
      total: number;
    };
    // stdlib has: action_http (action), trigger_webhook (trigger), legacy_node (action)
    // action+stdlib → action_http + legacy_node = 2
    expect(json.total).toBe(2);
    expect(json.nodes.every((n) => n.type === 'action' && n.package === 'stdlib')).toBe(true);
  });

  it('🚨 ?type=action&package=community → 0 (no community installed)', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes?type=action&package=community');
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(0);
  });
});

describe('🚨 SECURITY: no executors, no secrets leaked', () => {
  it('🚨 response NON contiene chiavi "execute" / "executor" / "apiKey"', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes');
    const text = await res.text();
    expect(text.toLowerCase()).not.toMatch(/"execute"/u);
    expect(text.toLowerCase()).not.toMatch(/"executor"/u);
    expect(text.toLowerCase()).not.toMatch(/"apikey"/u);
  });
});

describe('🚨 schema introspection — GET /:defId/schema', () => {
  it('no auth → 401', async () => {
    const app = makeApp(false);
    const res = await app.request('/api/v1/nodes/action_http/schema');
    expect(res.status).toBe(401);
  });

  it('defId esistente → 200 con configFields + version + outputs', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes/action_http/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defId: string;
      configFields: unknown[];
      version: string | null;
      outputs: unknown[];
    };
    expect(body.defId).toBe('action_http');
    expect(Array.isArray(body.configFields)).toBe(true);
    expect(body.configFields.length).toBeGreaterThan(0);
    expect('version' in body).toBe(true);
    expect(Array.isArray(body.outputs)).toBe(true);
  });

  it('nodo con actions → le espone nello schema', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes/agent_classify/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions?: { id: string }[] };
    expect(body.actions?.some((a) => a.id === 'classify')).toBe(true);
  });

  it('defId inesistente → 404', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes/does_not_exist/schema');
    expect(res.status).toBe(404);
  });

  it('NON espone executor/segreti nello schema', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/nodes/action_http/schema');
    const text = (await res.text()).toLowerCase();
    expect(text).not.toMatch(/"executor"/u);
    expect(text).not.toMatch(/"execute"/u);
  });
});
