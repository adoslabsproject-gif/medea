/**
 * Test 2026-grade — test-node routes (single-node execution).
 *
 * 🚨 ISOLATION: invoke SOLO il target node, no BFS downstream
 *    (vs full workflow run).
 *
 * 🚨 INPUT PRIORITY: explicit body.triggerInput > upstream pin (se enabled)
 *    > {} fallback.
 *
 * 🚨 AUDIT: ogni test-node SCRITTO in audit log (workflow.test_node /
 *    workflow.test_node_ephemeral) — owner deve vedere chi ha eseguito.
 *
 * 🚨 EPHEMERAL: workflow draft NON salvato → resourceId='__ephemeral__'
 *    + audit entry per editor che testano (anti-shadow IT).
 */
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const workflowsGetMock = vi.hoisted(() => vi.fn());
const pinsGetMock = vi.hoisted(() => vi.fn());
const resolveNodeModuleMock = vi.hoisted(() => vi.fn());
const executeNodeMock = vi.hoisted(() => vi.fn());
const auditAppendMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: vi.fn(() => ({ get: workflowsGetMock })),
}));

vi.mock('@/services/pin.service.js', () => ({
  PinService: vi.fn(() => ({ get: pinsGetMock })),
}));

vi.mock('@/services/llm-providers.service.js', () => ({
  LlmProvidersService: vi.fn(),
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: vi.fn(() => ({ append: auditAppendMock })),
}));

vi.mock('@/engine/workflow-engine.js', () => ({
  WorkflowEngine: vi.fn(() => ({
    resolveNodeModule: resolveNodeModuleMock,
    executeNode: executeNodeMock,
  })),
}));

vi.mock('@/engine/interpreter.js', () => ({
  interpolateConfig: vi.fn(),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-1',
}));

vi.mock('@/lib/logger.js');

const { createTestNodeRoutes } = await import('./test-node.js');

function makeApp(auth: unknown = { userId: 'u-1', role: 'editor' }) {
  const app: any = new Hono();
  app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/', createTestNodeRoutes({} as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  workflowsGetMock.mockReset();
  pinsGetMock.mockReset();
  resolveNodeModuleMock.mockReset();
  executeNodeMock.mockReset();
  auditAppendMock.mockResolvedValue(undefined);
});

describe('🚨 POST /workflows/:id/test-node/:nodeId — auth', () => {
  it('🚨 no auth → 401', async () => {
    const app = makeApp(null);
    const res = await app.request('/workflows/wf-1/test-node/node-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('🚨 workflow lookup', () => {
  it('🚨 workflow inesistente → 404', async () => {
    workflowsGetMock.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/workflows/ghost/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('🚨 nodeId non in workflow → 404', async () => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1',
      nodes: [{ id: 'other' }],
      edges: [],
    });
    const app = makeApp();
    const res = await app.request('/workflows/wf-1/test-node/missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('🚨 defId sconosciuto → 400', async () => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'unknown_node' }],
      edges: [],
    });
    resolveNodeModuleMock.mockReturnValue(null);
    const app = makeApp();
    const res = await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('🚨 carriedInput priority', () => {
  beforeEach(() => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', config: {} }],
      edges: [{ from: 'upstream', to: 'n1' }],
    });
    resolveNodeModuleMock.mockReturnValue({});
    executeNodeMock.mockResolvedValue({
      output: { result: 'OK' },
      step: { status: 'completed' },
    });
  });

  it('🚨 body.triggerInput presente → vince su pin', async () => {
    pinsGetMock.mockReturnValue({ enabled: true, output: { from: 'pin' } });
    const app = makeApp();
    await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggerInput: { from: 'body' } }),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: { from: 'body' },
      }),
    );
  });

  it('🚨 no triggerInput + upstream pin enabled → usa pin', async () => {
    pinsGetMock.mockReturnValue({ enabled: true, output: { from: 'pin' } });
    const app = makeApp();
    await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: { from: 'pin' },
      }),
    );
  });

  it('🚨 pin disabled → fallback {}', async () => {
    pinsGetMock.mockReturnValue({ enabled: false, output: { from: 'pin' } });
    const app = makeApp();
    await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: {},
      }),
    );
  });

  it('🚨 no pin esistente → fallback {}', async () => {
    pinsGetMock.mockReturnValue(null);
    const app = makeApp();
    await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: {},
      }),
    );
  });
});

describe('🚨 audit log su success + error', () => {
  beforeEach(() => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1',
      nodes: [{ id: 'n1', defId: 'action_http', config: {} }],
      edges: [],
    });
    resolveNodeModuleMock.mockReturnValue({});
  });

  it('🚨 success → audit append workflow.test_node + actorId', async () => {
    executeNodeMock.mockResolvedValue({
      output: { ok: true },
      step: { status: 'completed' },
    });
    const app = makeApp();
    await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.test_node',
        actorId: 'u-1',
        resourceId: 'wf-1',
      }),
    );
  });

  it('🚨 execute throw → 500 + error msg (NO crash route)', async () => {
    executeNodeMock.mockRejectedValue(new Error('node crashed'));
    const app = makeApp();
    const res = await app.request('/workflows/wf-1/test-node/n1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('node crashed');
  });
});

describe('🚨 ephemeral test-node (draft non salvata)', () => {
  it('🚨 no auth → 401', async () => {
    const app = makeApp(null);
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', nodes: [{ id: 'n1', defId: 'x' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('🚨 nodeId non in draft.nodes → 404', async () => {
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'ghost',
        nodes: [{ id: 'n1', defId: 'x' }],
      }),
    });
    expect(res.status).toBe(404);
  });

  it('🚨 defId unknown → 400', async () => {
    resolveNodeModuleMock.mockReturnValue(null);
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'n1',
        nodes: [{ id: 'n1', defId: 'unknown' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 success → ephemeral:true + runId + audit', async () => {
    resolveNodeModuleMock.mockReturnValue({});
    executeNodeMock.mockResolvedValue({
      output: { result: 1 },
      step: { status: 'completed' },
    });
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'n1',
        nodes: [{ id: 'n1', defId: 'action_http', config: {} }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ephemeral).toBe(true);
    expect(body.runId).toMatch(/^ephemeral-/);
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.test_node_ephemeral',
        resourceId: '__ephemeral__',
      }),
    );
  });

  it('🚨 error → AUDIT comunque scritto (anti-shadow IT)', async () => {
    resolveNodeModuleMock.mockReturnValue({});
    executeNodeMock.mockRejectedValue(new Error('eph fail'));
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'n1',
        nodes: [{ id: 'n1', defId: 'action_http', config: {} }],
      }),
    });
    expect(res.status).toBe(500);
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ status: 'error' }),
      }),
    );
  });

  it('🚨 carriedInput default {}', async () => {
    resolveNodeModuleMock.mockReturnValue({});
    executeNodeMock.mockResolvedValue({ output: {}, step: { status: 'completed' } });
    const app = makeApp();
    await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', nodes: [{ id: 'n1', defId: 'x' }] }),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: {},
        workflowId: '__ephemeral__',
      }),
    );
  });

  it('🚨 triggerInput esplicito forwardato', async () => {
    resolveNodeModuleMock.mockReturnValue({});
    executeNodeMock.mockResolvedValue({ output: {}, step: { status: 'completed' } });
    const app = makeApp();
    await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'n1',
        nodes: [{ id: 'n1', defId: 'x' }],
        triggerInput: { custom: 'value' },
      }),
    });
    expect(executeNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        carriedInput: { custom: 'value' },
      }),
    );
  });
});

describe('🚨 zod schema validation', () => {
  it('🚨 ephemeral senza nodes array → 400', async () => {
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 ephemeral senza nodeId → 400', async () => {
    const app = makeApp();
    const res = await app.request('/workflows/test-node-ephemeral', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [] }),
    });
    expect(res.status).toBe(400);
  });
});
