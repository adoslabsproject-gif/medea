/**
 * Test in-process della route SSE /workflow-agent/build — app Hono reale, auth
 * iniettata, LlmTurn SCRIPTATO + catalog ridotto (niente modello reale → niente
 * greensmoke). Verifica: happy-path (step→done col workflow), auth, validazione,
 * error-event, e la risoluzione provider (NoLlmProviderError / no-tool-calling).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { LlmTurn, LlmTurnResult } from '@/services/db-agent/chat/types.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import type { WorkflowSnapshot } from '@/services/workflow-agent/state.js';

vi.mock('@/lib/logger.js');
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'tenant-1' }));
vi.mock('@/config.js', () => ({ liaraBaseUrl: () => 'http://liara.local/v1', isLiaraEnabled: () => true }));

const resolveMock = vi.fn();
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: (...a: unknown[]) => resolveMock(...a) },
  NoLlmProviderError: class NoLlmProviderError extends Error {
    httpStatus: 401 | 402 | 403 = 401;
    constructor(msg: string, status?: 401 | 402 | 403) { super(msg); if (status) this.httpStatus = status; }
  },
}));

const resolveToolEndpointMock = vi.fn();
vi.mock('@/services/llm/provider-registry.js', () => ({
  resolveToolEndpoint: (...a: unknown[]) => resolveToolEndpointMock(...a),
}));

const { createWorkflowAgentRoutes } = await import('./workflow-agent.js');

const CATALOG: NodeCatalogEntry[] = [
  { defId: 'trigger_webhook', type: 'trigger', label: 'Webhook', description: 'avvio http', fields: [], searchAliases: ['webhook'] },
  {
    defId: 'action_http_request', type: 'action', label: 'HTTP', description: 'http', fields: [
      { key: 'url', label: 'URL', type: 'text', required: true },
      { key: 'method', label: 'M', type: 'select', required: true, options: ['GET', 'POST'] },
    ],
  },
];

function scripted(turns: LlmTurnResult[]): LlmTurn {
  const queue = [...turns];
  return () => Promise.resolve(queue.shift() ?? { kind: 'final', text: 'done' });
}
function call(id: string, name: string, args: unknown): LlmTurnResult {
  return { kind: 'tools', toolCalls: [{ id, name, args }] };
}

/** App con auth iniettata + LlmTurn scriptato + catalog ridotto. */
function buildApp(auth: Record<string, unknown> | null, turn?: LlmTurn): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth as never); await next(); });
  app.route('/workflow-agent', createWorkflowAgentRoutes({
    catalog: CATALOG,
    ...(turn ? { llmTurnFor: () => turn } : {}),
  }));
  return app;
}
async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request('/workflow-agent/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /workflow-agent/build — happy path', () => {
  it('🚨 SSE: step per ogni tool + done col workflow costruito', async () => {
    const app = buildApp({ userId: 'u1', tenantId: 't', role: 'editor' }, scripted([
      call('1', 'search_nodes', { query: 'webhook' }),
      call('2', 'add_node', { defId: 'trigger_webhook', id: 'w' }),
      call('3', 'add_node', { defId: 'action_http_request', id: 'h', config: { url: 'https://x', method: 'GET' } }),
      call('4', 'connect', { from: 'w', to: 'h' }),
      call('5', 'finish', {}),
    ]));
    const res = await post(app, { goal: 'webhook poi http get' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: step');
    expect(text).toContain('search_nodes');
    expect(text).toContain('event: done');
    // il done porta lo snapshot col workflow costruito
    const doneLine = text.split('\n\n').find((b) => b.includes('event: done'))!;
    const data = JSON.parse(doneLine.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim());
    expect(data.snapshot.nodes.map((n: { defId: string }) => n.defId)).toEqual(['trigger_webhook', 'action_http_request']);
    expect(data.snapshot.edges).toHaveLength(1);
    expect(data.stoppedReason).toBe('finish');
    expect(data.remainingIssues).toEqual([]);
    // 🚨 il done porta il Workflow ASSEMBLATO (importabile come il wizard singleshot)
    expect(data.workflow).toBeTruthy();
    expect(data.workflow.nodes.map((n: { defId: string }) => n.defId)).toEqual(['trigger_webhook', 'action_http_request']);
    expect(data.workflow.edges).toHaveLength(1);
    // posizioni assegnate dall'assemblaggio (x crescente) → canvas leggibile
    expect(typeof data.workflow.nodes[0].x).toBe('number');
  });
});

describe('POST /workflow-agent/build — auth & validazione', () => {
  it('🚨 401 senza auth.userId', async () => {
    const res = await post(buildApp({ tenantId: 't', role: 'editor' }, scripted([])), { goal: 'qualcosa di valido' });
    expect(res.status).toBe(401);
  });

  it('🚨 401 auth null', async () => {
    const res = await post(buildApp(null, scripted([])), { goal: 'qualcosa di valido' });
    expect(res.status).toBe(401);
  });

  it('🚨 goal troppo corto → 400 (zod)', async () => {
    const res = await post(buildApp({ userId: 'u1', tenantId: 't' }, scripted([])), { goal: 'ab' });
    expect(res.status).toBe(400);
  });

  it('🚨 campo extra → 400 (strict)', async () => {
    const res = await post(buildApp({ userId: 'u1', tenantId: 't' }, scripted([])), { goal: 'goal valido', hacker: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /workflow-agent/build — error path', () => {
  it('🚨 LlmTurn lancia (modello giù) → SSE event error (no crash)', async () => {
    const boom: LlmTurn = () => Promise.reject(new Error('Liara 502'));
    const res = await post(buildApp({ userId: 'u1', tenantId: 't' }, boom), { goal: 'goal valido' });
    expect(res.status).toBe(200); // lo stream si apre, l'errore è un evento
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: done');
  });
});

describe('POST /workflow-agent/build — risoluzione provider (no llmTurnFor)', () => {
  function appNoTurn(auth: Record<string, unknown>): Hono {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', auth as never); await next(); });
    app.route('/workflow-agent', createWorkflowAgentRoutes({ catalog: CATALOG }));
    return app;
  }

  it('🚨 NoLlmProviderError → httpStatus dichiarato (402 quota)', async () => {
    const { NoLlmProviderError } = await import('@/services/llm-resolver.service.js');
    resolveMock.mockImplementation(() => { throw new NoLlmProviderError('Quota', 402); });
    const res = await post(appNoTurn({ userId: 'u1', tenantId: 't' }), { goal: 'goal valido' });
    expect(res.status).toBe(402);
  });

  it('🚨 provider senza tool-calling → 400, agente mai avviato', async () => {
    resolveMock.mockReturnValue({ provider: 'anthropic', apiKey: 'k', model: 'claude' });
    resolveToolEndpointMock.mockReturnValue(null);
    const res = await post(appNoTurn({ userId: 'u1', tenantId: 't' }), { goal: 'goal valido' });
    expect(res.status).toBe(400);
    const j = await res.json() as { error: string };
    expect(j.error).toMatch(/tool-calling/u);
  });

  it('🚨 BYOK senza apiKey → 401', async () => {
    resolveMock.mockReturnValue({ provider: 'openai', apiKey: '', model: 'gpt-4o' });
    const res = await post(appNoTurn({ userId: 'u1', tenantId: 't' }), { goal: 'goal valido' });
    expect(res.status).toBe(401);
  });
});

// ─── /modify ──────────────────────────────────────────────────────────────

const EXISTING: WorkflowSnapshot = {
  nodes: [{ id: 'w', defId: 'trigger_webhook', config: {} }],
  edges: [],
};

function buildModifyApp(
  auth: Record<string, unknown> | null,
  turn: LlmTurn,
  over: { loadWorkflowSnapshot?: (id: string) => WorkflowSnapshot | null; configuredSecretsFor?: () => ReadonlySet<string> } = {},
): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth as never); await next(); });
  app.route('/workflow-agent', createWorkflowAgentRoutes({
    catalog: CATALOG,
    llmTurnFor: () => turn,
    loadWorkflowSnapshot: over.loadWorkflowSnapshot ?? (() => EXISTING),
    configuredSecretsFor: over.configuredSecretsFor ?? (() => new Set<string>()),
  }));
  return app;
}
async function postModify(app: Hono, body: unknown): Promise<Response> {
  return app.request('/workflow-agent/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function parseDone(text: string): Record<string, unknown> {
  const doneBlock = text.split('\n\n').find((b) => b.includes('event: done'))!;
  return JSON.parse(doneBlock.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim());
}

describe('POST /workflow-agent/modify — happy path', () => {
  it('🚨 SSE: aggiungi+collega sul workflow esistente → done col patch (read-before-edit)', async () => {
    const app = buildModifyApp({ userId: 'u1', tenantId: 't', role: 'editor' }, scripted([
      call('1', 'add_node', { defId: 'action_http_request', id: 'h', config: { url: 'https://x', method: 'GET' } }),
      call('2', 'connect', { from: 'w', to: 'h' }),
      call('3', 'finish', {}),
    ]));
    const res = await postModify(app, { workflowId: 'wf1', request: 'aggiungi un nodo http e collegalo al webhook' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: step');
    expect(text).toContain('event: done');
    const data = parseDone(text);
    const patch = data.patch as { addNodes?: { id: string }[]; addEdges?: { id: string }[]; removeNodeIds?: string[] };
    expect(patch.addNodes?.map((n) => n.id)).toEqual(['h']);
    expect(patch.addEdges?.map((e) => e.id)).toEqual(['w->h#']);
    // 🚨 il webhook PRE-ESISTENTE non è ricreato né rimosso
    expect(patch.removeNodeIds).toBeUndefined();
    expect(data.stoppedReason).toBe('finish');
  });

  it('🚨 pendingSecrets nel done quando il modello usa {{secrets.X}} non configurato', async () => {
    const app = buildModifyApp({ userId: 'u1', tenantId: 't' }, scripted([
      call('1', 'set_config', { nodeId: 'w', config: { path: '{{secrets.HOOK_TOKEN}}' }, merge: true }),
      call('2', 'finish', {}),
    ]), { configuredSecretsFor: () => new Set<string>() });
    const res = await postModify(app, { workflowId: 'wf1', request: 'proteggi il webhook con un token segreto' });
    const data = parseDone(await res.text());
    const secrets = data.pendingSecrets as { name: string }[];
    expect(secrets.map((s) => s.name)).toEqual(['HOOK_TOKEN']);
  });
});

describe('POST /workflow-agent/modify — auth, validazione, not-found', () => {
  it('🚨 401 senza auth', async () => {
    const res = await postModify(buildModifyApp(null, scripted([])), { workflowId: 'wf1', request: 'fai qualcosa' });
    expect(res.status).toBe(401);
  });

  it('🚨 404 se il workflow non esiste (loader → null)', async () => {
    const app = buildModifyApp({ userId: 'u1', tenantId: 't' }, scripted([]), { loadWorkflowSnapshot: () => null });
    const res = await postModify(app, { workflowId: 'ghost', request: 'modifica qualcosa' });
    expect(res.status).toBe(404);
  });

  it('🚨 request troppo corta → 400 (zod)', async () => {
    const res = await postModify(buildModifyApp({ userId: 'u1', tenantId: 't' }, scripted([])), { workflowId: 'wf1', request: 'x' });
    expect(res.status).toBe(400);
  });

  it('🚨 campo extra → 400 (strict)', async () => {
    const res = await postModify(buildModifyApp({ userId: 'u1', tenantId: 't' }, scripted([])), { workflowId: 'wf1', request: 'modifica valida', hacker: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /workflow-agent/modify — error path', () => {
  it('🚨 LlmTurn lancia → SSE event error (no done, no crash)', async () => {
    const boom: LlmTurn = () => Promise.reject(new Error('Liara 502'));
    const res = await postModify(buildModifyApp({ userId: 'u1', tenantId: 't' }, boom), { workflowId: 'wf1', request: 'modifica valida' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: done');
  });
});
