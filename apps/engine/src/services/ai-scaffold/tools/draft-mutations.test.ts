/**
 * Test 2026-grade — services/ai-scaffold/tools/draft-mutations.ts.
 *
 * 🚨 ADD NODE: required-field enumerate-all-missing in un solo error (Liara
 *    altrimenti fa multi-retry one-by-one — produzione 2026-05-31 bug).
 *
 * 🚨 ENUM CHECK: field.options strict → throw helpful.
 *
 * 🚨 REGEX CHECK: field.pattern → invalid regex skip silently (no crash).
 *
 * 🚨 CONNECT: from/to MUST exist nei nodes draft (orphan edge guard).
 *
 * 🚨 FINALIZE: 3 gate sequenziali (plan-completeness, complexity, orphan-edge).
 *
 * 🚨 ABORT GATE: abort hallucinato → reject force-continue (no aborted=true).
 *
 * 🚨 UPDATE: hint esplicito "forse hai dimenticato add_node?" quando id missing.
 *
 * 🚨 DELETE: cascade edges su id (from OR to match).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { first, at } from '@/__testkit__/assert.js';

// Mocks hoisted
const buildNodeCatalogMock = vi.hoisted(() => vi.fn());
const requirePlanMock = vi.hoisted(() => vi.fn() as ReturnType<typeof vi.fn>);
const shouldRejectFinalizeMock = vi.hoisted(() => vi.fn() as ReturnType<typeof vi.fn>);
const evaluateAbortMock = vi.hoisted(() => vi.fn() as ReturnType<typeof vi.fn>);

vi.mock('@/services/ai-scaffold/node-catalog.js', () => ({
  buildNodeCatalog: buildNodeCatalogMock,
}));
vi.mock('@/services/ai-scaffold/tools/complexity-gate.js', () => ({
  shouldRejectFinalize: shouldRejectFinalizeMock,
}));
vi.mock('@/services/ai-scaffold/tools/abort-gate.js', () => ({
  evaluateAbort: evaluateAbortMock,
}));
vi.mock('@/services/ai-scaffold/tools/plan-handler.js', () => ({
  requirePlan: requirePlanMock,
}));

const {
  addNodeHandler, connectNodesHandler, finalizeWorkflowHandler,
  abortHandler, updateNodeHandler, deleteNodeHandler, disconnectNodesHandler,
} = await import('./draft-mutations.js');

interface Session {
  draft: {
    id: string; name: string; description: string;
    nodes: { id: string; defId: string; name?: string; position: { x: number; y: number }; config: Record<string, string> }[];
    edges: { from: string; to: string; fromPort?: string }[];
  };
  finalized: boolean;
  aborted: boolean;
  abortReason: string;
  goal: string;
  plan: null | {
    accepted: boolean; proposedAt: number; reasoning: string;
    nodes: { id: string; defId: string; purpose: string }[];
    edges: { from: string; to: string; fromPort?: string }[];
  };
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    draft: { id: '', name: '', description: '', nodes: [], edges: [], ...over.draft },
    finalized: false,
    aborted: false,
    abortReason: '',
    goal: '',
    plan: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePlanMock.mockReturnValue(null);
  shouldRejectFinalizeMock.mockReturnValue({ reject: false });
  evaluateAbortMock.mockReturnValue({ reject: false, replyToAgent: '' });
  buildNodeCatalogMock.mockReturnValue([
    {
      defId: 'trigger_manual',
      fields: [],
    },
    {
      defId: 'action_http_request',
      fields: [
        { key: 'url', type: 'string', required: true },
        { key: 'method', type: 'string', required: false, options: ['GET', 'POST', 'PUT', 'DELETE'] },
        { key: 'email', type: 'string', required: false, pattern: '^\\S+@\\S+\\.\\S+$' },
      ],
    },
  ]);
});

describe('🚨 addNodeHandler — required field enumeration', () => {
  it('🚨 id missing → error obbligatorio', () => {
    const r = addNodeHandler(makeSession() as never, { defId: 'trigger_manual' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"id"') });
  });

  it('🚨 defId missing → error obbligatorio', () => {
    const r = addNodeHandler(makeSession() as never, { id: 'n1' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"defId"') });
  });

  it('🚨 defId NON nel catalog → error con count + hint list_node_catalog', () => {
    const r = addNodeHandler(makeSession() as never, { id: 'n1', defId: 'unknown_node_xyz' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('unknown_node_xyz');
      expect(r.error).toContain('list_node_catalog');
      expect(r.error).toContain('2 nodi');
    }
  });

  it('🚨 ALL required missing → enumerati TUTTI in un solo error', () => {
    const r = addNodeHandler(makeSession() as never, {
      id: 'n1', defId: 'action_http_request', config: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('"url"');
      expect(r.error).toContain('REQUIRED mancanti');
    }
  });

  it('🚨 enum field invalid → error con opzioni elencate', () => {
    const r = addNodeHandler(makeSession() as never, {
      id: 'n1', defId: 'action_http_request',
      config: { url: 'https://x.com', method: 'INVALID_METHOD' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('GET|POST|PUT|DELETE');
      expect(r.error).toContain('INVALID_METHOD');
    }
  });

  it('🚨 regex pattern violation → error', () => {
    const r = addNodeHandler(makeSession() as never, {
      id: 'n1', defId: 'action_http_request',
      config: { url: 'https://x.com', email: 'not-email' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('regex');
  });

  it('🚨 SECURITY: regex pattern INVALID → skip (no crash, no SecurityError)', () => {
    buildNodeCatalogMock.mockReturnValue([{
      defId: 'fake_node',
      fields: [{ key: 'k', type: 'string', required: false, pattern: '[unclosed' }],
    }]);
    const r = addNodeHandler(makeSession() as never, {
      id: 'n1', defId: 'fake_node', config: { k: 'value' },
    });
    expect(r.ok).toBe(true);
  });

  it('🚨 id duplicato → error "già aggiunto"', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n1', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      },
    });
    const r = addNodeHandler(s as never, { id: 'n1', defId: 'trigger_manual' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('già aggiunto') });
  });

  it('🚨 config value object → JSON.stringify normalizzato', () => {
    buildNodeCatalogMock.mockReturnValue([{
      defId: 'cfg_node', fields: [{ key: 'k', type: 'json', required: false }],
    }]);
    const s = makeSession();
    addNodeHandler(s as never, {
      id: 'n1', defId: 'cfg_node',
      config: { k: { complex: 'object', nested: 42 } },
    });
    expect(first(s.draft.nodes).config.k).toBe('{"complex":"object","nested":42}');
  });

  it('🚨 position auto-assign se non passata: x = nodes.length * 220 + 100, y = 200', () => {
    const s = makeSession({
      draft: { id: '', name: '', description: '', nodes: [], edges: [] },
    });
    addNodeHandler(s as never, { id: 'n0', defId: 'trigger_manual' });
    expect(first(s.draft.nodes).position).toEqual({ x: 100, y: 200 });
    addNodeHandler(s as never, { id: 'n1', defId: 'trigger_manual' });
    expect(at(s.draft.nodes, 1).position).toEqual({ x: 320, y: 200 });
  });

  it('🚨 x/y custom → preservate', () => {
    const s = makeSession();
    addNodeHandler(s as never, { id: 'n', defId: 'trigger_manual', x: 555, y: 777 });
    expect(first(s.draft.nodes).position).toEqual({ x: 555, y: 777 });
  });

  it('🚨 label string → node.name set', () => {
    const s = makeSession();
    addNodeHandler(s as never, { id: 'n', defId: 'trigger_manual', label: 'Custom Name' });
    expect(first(s.draft.nodes).name).toBe('Custom Name');
  });

  it('🚨 requirePlan reject → block add_node', () => {
    requirePlanMock.mockReturnValue({ ok: false, error: 'PLAN REQUIRED' });
    const r = addNodeHandler(makeSession() as never, { id: 'n', defId: 'trigger_manual' });
    expect(r).toEqual({ ok: false, error: 'PLAN REQUIRED' });
  });
});

describe('🚨 connectNodesHandler — orphan-edge guard', () => {
  it('🚨 from missing → error obbligatorio', () => {
    const r = connectNodesHandler(makeSession() as never, { to: 'b' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"from"') });
  });

  it('🚨 from non esiste nel draft → error helpful', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'b', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      },
    });
    const r = connectNodesHandler(s as never, { from: 'a', to: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('add_node');
  });

  it('🚨 connect happy: from + to esistono → edge aggiunto', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [
          { id: 'a', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
      },
    });
    const r = connectNodesHandler(s as never, { from: 'a', to: 'b' });
    expect(r.ok).toBe(true);
    expect(s.draft.edges).toHaveLength(1);
    expect(first(s.draft.edges)).toEqual({ from: 'a', to: 'b' });
  });

  it('🚨 fromPort string → preserved', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [
          { id: 'a', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
      },
    });
    connectNodesHandler(s as never, { from: 'a', to: 'b', fromPort: 'true' });
    expect(first(s.draft.edges).fromPort).toBe('true');
  });
});

describe('🚨 finalizeWorkflowHandler — 3 gate sequenziali', () => {
  function sessionWithNode(): Session {
    return makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n1', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      },
    });
  }

  it('🚨 id o name missing → error', () => {
    expect(finalizeWorkflowHandler(sessionWithNode() as never, { id: 'wf-1' }))
      .toEqual({ ok: false, error: expect.stringContaining('id') });
  });

  it('🚨 draft vuoto → error "Nessun nodo"', () => {
    const r = finalizeWorkflowHandler(makeSession() as never, { id: 'wf-1', name: 'Test' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Nessun nodo') });
  });

  it('🚨 plan accepted ma nodi missing → enumera tutti i mancanti', () => {
    const s = sessionWithNode();
    s.plan = {
      accepted: true, proposedAt: Date.now(), reasoning: 'test',
      nodes: [
        { id: 'n1', defId: 'trigger_manual', purpose: 'p1' },
        { id: 'n2_missing', defId: 'action_x', purpose: 'p2' },
        { id: 'n3_missing', defId: 'action_y', purpose: 'p3' },
      ],
      edges: [],
    };
    const r = finalizeWorkflowHandler(s as never, { id: 'wf', name: 'T' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('n2_missing');
      expect(r.error).toContain('n3_missing');
      expect(r.error).toContain('2 nodi');
    }
  });

  it('🚨 complexity gate reject → propaga error', () => {
    shouldRejectFinalizeMock.mockReturnValue({ reject: true, reason: 'troppo pochi nodi' });
    const r = finalizeWorkflowHandler(sessionWithNode() as never, { id: 'wf', name: 'T' });
    expect(r).toEqual({ ok: false, error: 'troppo pochi nodi' });
  });

  it('🚨 orphan edge → error specifico', () => {
    const s = sessionWithNode();
    s.draft.edges = [{ from: 'n1', to: 'GHOST' }];
    const r = finalizeWorkflowHandler(s as never, { id: 'wf', name: 'T' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Edge orfano');
  });

  it('🚨 success: setta id+name+description, finalized=true', () => {
    const s = sessionWithNode();
    const r = finalizeWorkflowHandler(s as never, {
      id: 'wf-001', name: 'My Workflow', description: 'desc text',
    });
    expect(r.ok).toBe(true);
    expect(s.draft.id).toBe('wf-001');
    expect(s.draft.name).toBe('My Workflow');
    expect(s.draft.description).toBe('desc text');
    expect(s.finalized).toBe(true);
  });
});

describe('🚨 abortHandler — abort-gate reject hallucinated', () => {
  it('🚨 evaluateAbort reject → ok:false + force continue + NO aborted=true', () => {
    evaluateAbortMock.mockReturnValue({
      reject: true, replyToAgent: 'Continua, REGOLA 12: nodo X è installato',
    });
    const s = makeSession();
    const r = abortHandler(s as never, { reason: 'nodo X non esiste' });
    expect(r).toEqual({ ok: false, error: 'Continua, REGOLA 12: nodo X è installato' });
    expect(s.aborted).toBe(false);
    expect(s.abortReason).toBe('');
  });

  it('🚨 abort accepted → session.aborted=true + reason recorded', () => {
    const s = makeSession();
    const r = abortHandler(s as never, { reason: 'goal impossibile' });
    expect(r.ok).toBe(true);
    expect(s.aborted).toBe(true);
    expect(s.abortReason).toBe('goal impossibile');
  });

  it('🚨 reason missing → "unspecified"', () => {
    const s = makeSession();
    abortHandler(s as never, {});
    expect(s.abortReason).toBe('unspecified');
  });
});

describe('🚨 updateNodeHandler — hint dimenticato add_node', () => {
  it('🚨 id missing → error', () => {
    const r = updateNodeHandler(makeSession() as never, {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining('id') });
  });

  it('🚨 nodo non esiste → hint helpful con sequenza corretta', () => {
    const r = updateNodeHandler(makeSession() as never, { id: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Hai forse dimenticato di add_node');
      expect(r.error).toContain('Sequenza corretta');
    }
  });

  it('🚨 patch ok: merge config + ritorna fieldsPatched', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: { existing: 'val' } }],
        edges: [],
      },
    });
    const r = updateNodeHandler(s as never, { id: 'n', config: { newKey: 'newVal' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { fieldsPatched: string[] }).fieldsPatched).toEqual(['newKey']);
    expect(first(s.draft.nodes).config).toEqual({ existing: 'val', newKey: 'newVal' });
  });

  it('🚨 enum re-validation con patch invalido → error', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n', defId: 'action_http_request', position: { x: 0, y: 0 }, config: { url: 'http://x' } }],
        edges: [],
      },
    });
    const r = updateNodeHandler(s as never, { id: 'n', config: { method: 'INVALID' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('GET|POST|PUT|DELETE');
  });

  it('🚨 x/y update → position aggiornata', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      },
    });
    updateNodeHandler(s as never, { id: 'n', x: 100, y: 200 });
    expect(first(s.draft.nodes).position).toEqual({ x: 100, y: 200 });
  });

  it('🚨 label → node.name update', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [{ id: 'n', defId: 'trigger_manual', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      },
    });
    updateNodeHandler(s as never, { id: 'n', label: 'New Label' });
    expect(first(s.draft.nodes).name).toBe('New Label');
  });
});

describe('🚨 deleteNodeHandler — cascade edges', () => {
  it('🚨 nodo non esiste → error "non esisteva"', () => {
    const r = deleteNodeHandler(makeSession() as never, { id: 'ghost' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('non esisteva') });
  });

  it('🚨 cascade: edge con from=id OR to=id rimossi', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '',
        nodes: [
          { id: 'a', defId: 'x', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', defId: 'x', position: { x: 0, y: 0 }, config: {} },
          { id: 'c', defId: 'x', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'a', to: 'c' }, // SURVIVES (no b)
        ],
      },
    });
    const r = deleteNodeHandler(s as never, { id: 'b' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { edgesAlsoRemoved: number }).edgesAlsoRemoved).toBe(2);
    expect(s.draft.nodes.map(n => n.id)).toEqual(['a', 'c']);
    expect(s.draft.edges).toEqual([{ from: 'a', to: 'c' }]);
  });
});

describe('🚨 disconnectNodesHandler — edge surgical removal', () => {
  it('🚨 from/to missing → error', () => {
    expect(disconnectNodesHandler(makeSession() as never, { from: 'a' }))
      .toEqual({ ok: false, error: expect.stringContaining('from e to') });
  });

  it('🚨 removed = before - after count', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '', nodes: [],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' }, // duplicate
          { from: 'a', to: 'c' },
        ],
      },
    });
    const r = disconnectNodesHandler(s as never, { from: 'a', to: 'b' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { removed: number }).removed).toBe(2);
    expect(s.draft.edges).toEqual([{ from: 'a', to: 'c' }]);
  });

  it('🚨 fromPort match strict (undefined vs string)', () => {
    const s = makeSession({
      draft: {
        id: '', name: '', description: '', nodes: [],
        edges: [
          { from: 'a', to: 'b' }, // no fromPort
          { from: 'a', to: 'b', fromPort: 'true' },
        ],
      },
    });
    const r = disconnectNodesHandler(s as never, { from: 'a', to: 'b', fromPort: 'true' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { removed: number }).removed).toBe(1);
    // L'edge senza fromPort sopravvive
    expect(s.draft.edges).toHaveLength(1);
    expect(first(s.draft.edges).fromPort).toBeUndefined();
  });
});
