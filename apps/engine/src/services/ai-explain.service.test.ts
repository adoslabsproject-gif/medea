/**
 * Test 2026-grade — AiExplainService (diagnose failed run via LLM + propose fix).
 *
 * 🚨 BUSINESS-CRITICAL: workflow debugging path. Test reali con SQLite
 * :memory: + dispatcher LLM injected (no real API call). Coverage:
 *
 *  - Lifecycle: load run → find failed step → resolve LLM → dispatch →
 *    parse JSON → validate Zod → log interaction → return result
 *  - 🚨 RunNotFoundError per tenant scope
 *  - 🚨 RunSucceededError se status=success
 *  - 🚨 NoFailedStepError se nessun step con status=error
 *  - LLM response: strip code fences, parse JSON, validate ReplySchema
 *  - 🚨 invalid JSON → LlmResponseError
 *  - 🚨 schema validation fail → LlmResponseError
 *  - patch validation server-side: updateNodes id+configFields,
 *    addNodes defId catalog, removeNodeIds existence
 *  - confidence/risk/evidence/self_check optional fields propagated
 *  - metrics counter + histogram (success path)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  sqlite: null as unknown as ReturnType<typeof Database>,
  resolveLlm: vi.fn(),
  insertInteraction: vi.fn(),
  isCaptureEnabled: vi.fn(),
  setCapturePreference: vi.fn(),
  getCaptureSettings: vi.fn(),
  stdlibNodeDefs: vi.fn(),
  counterInc: vi.fn(),
  histogramObserve: vi.fn(),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.sqlite }),
}));

vi.mock('./llm-resolver.service.js', () => {
  class NoLlmProviderError extends Error {
    override name = 'NoLlmProviderError';
  }
  return {
    llmResolver: { resolve: (...a: unknown[]) => m.resolveLlm(...a) },
    NoLlmProviderError,
  };
});

vi.mock('./ai-interactions.service.js', () => ({
  AIInteractionsService: class {
    insert = m.insertInteraction;
    isCaptureEnabled = m.isCaptureEnabled;
    setCapturePreference = m.setCapturePreference;
    getCaptureSettings = m.getCaptureSettings;
  },
}));

vi.mock('@/adapters/llm-anthropic.js', () => ({
  AnthropicProvider: class {
    complete = vi.fn();
  },
}));

vi.mock('@/prompts/run-explain.prompt.js', () => ({
  buildRunExplainSystemPrompt: () => 'sys prompt',
  buildRunExplainUserContent: (args: unknown) => `user content: ${JSON.stringify(args).slice(0, 60)}`,
}));

vi.mock('@flowforge/nodes-stdlib', () => ({
  stdlibNodeDefs: (...a: unknown[]) => m.stdlibNodeDefs(...a),
}));

vi.mock('@/lib/metrics-store.js', () => ({
  counterInc: (...a: unknown[]) => m.counterInc(...a),
  histogramObserve: (...a: unknown[]) => m.histogramObserve(...a),
}));

vi.mock('@/lib/logger.js');

import {
  AiExplainService,
  RunNotFoundError, RunSucceededError, NoFailedStepError, LlmResponseError,
  type LlmDispatcher,
} from './ai-explain.service.js';

function setupSchema(db: ReturnType<typeof Database>): void {
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      nodes_json TEXT NOT NULL DEFAULT '[]',
      edges_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      tenant_id TEXT DEFAULT 'default',
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL
    );
  `);
}

function seedRunAndWorkflow(db: ReturnType<typeof Database>, opts: {
  runId?: string; workflowId?: string; tenantId?: string;
  status?: string; steps?: unknown[];
  nodes?: unknown[]; edges?: unknown[];
} = {}): void {
  const tenantId = opts.tenantId ?? 't1';
  const wfId = opts.workflowId ?? 'wf-1';
  const runId = opts.runId ?? 'run-1';
  db.prepare(`INSERT INTO workflows (id, tenant_id, name, nodes_json, edges_json) VALUES (?, ?, ?, ?, ?)`)
    .run(wfId, tenantId, 'wf1', JSON.stringify(opts.nodes ?? []), JSON.stringify(opts.edges ?? []));
  db.prepare(`INSERT INTO runs (id, workflow_id, tenant_id, status, steps_json) VALUES (?, ?, ?, ?, ?)`)
    .run(runId, wfId, tenantId, opts.status ?? 'error', JSON.stringify(opts.steps ?? [
      { nodeId: 'n1', defId: 'action_send_email', status: 'error', error: 'SMTP timeout' },
    ]));
}

const validLlmJson = JSON.stringify({
  explanation: 'SMTP host unreachable',
  fix: 'Verifica connettività con smtp.example.com:587',
  confidence: 0.85,
  root_cause: 'Connection timeout',
  evidence: ['SMTP timeout'],
  risk: 'safe',
  self_check: {
    patch_keys_exist_in_nodedef: true,
    patch_modifies_only_target_node: true,
    explanation_cites_evidence: true,
  },
});

beforeEach(() => {
  m.sqlite = new Database(':memory:');
  setupSchema(m.sqlite);
  m.resolveLlm.mockReset().mockReturnValue({ provider: 'anthropic', apiKey: 'sk-x', model: 'claude-sonnet-4-5' });
  m.insertInteraction.mockReset().mockReturnValue('int-1');
  m.isCaptureEnabled.mockReset().mockReturnValue(true);
  m.stdlibNodeDefs.mockReset().mockReturnValue([
    { id: 'action_send_email', configFields: [{ key: 'host' }, { key: 'port' }] },
    { id: 'action_http_request', configFields: [{ key: 'url' }] },
  ]);
  m.counterInc.mockReset();
  m.histogramObserve.mockReset();
});

const makeService = (dispatcherText: string): AiExplainService => {
  const dispatcher: LlmDispatcher = async () => dispatcherText;
  return new AiExplainService(dispatcher);
};

describe('🚨 lifecycle errors', () => {
  it('🚨 run not found → RunNotFoundError (tenant scope)', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(validLlmJson);
    await expect(svc.explain({ tenantId: 't-OTHER', runId: 'run-1' }))
      .rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('🚨 run.status=success → RunSucceededError', async () => {
    seedRunAndWorkflow(m.sqlite, { status: 'success' });
    const svc = makeService(validLlmJson);
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(RunSucceededError);
  });

  it('🚨 nessuno step in error → NoFailedStepError', async () => {
    seedRunAndWorkflow(m.sqlite, {
      status: 'error',
      steps: [
        { nodeId: 'n1', defId: 'a', status: 'success' },
        { nodeId: 'n2', defId: 'b', status: 'pending' },
      ],
    });
    const svc = makeService(validLlmJson);
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(NoFailedStepError);
  });

  it('steps_json malformed → fallback empty steps → NoFailedStepError', async () => {
    seedRunAndWorkflow(m.sqlite);
    m.sqlite.prepare(`UPDATE runs SET steps_json = ? WHERE id = ?`).run('not json{', 'run-1');
    const svc = makeService(validLlmJson);
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(NoFailedStepError);
  });
});

describe('🚨 LLM dispatch + parsing', () => {
  it('happy path: dispatcher → JSON valido → ExplainResult con explanation+fix+interactionId', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(validLlmJson);
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.explanation).toBe('SMTP host unreachable');
    expect(r.fix).toContain('Verifica connettivit');
    expect(r.interactionId).toBe('int-1');
    expect(r.failedNodeId).toBe('n1');
    expect(r.runId).toBe('run-1');
    expect(r.confidence).toBe(0.85);
    expect(r.risk).toBe('safe');
    expect(r.evidence).toEqual(['SMTP timeout']);
    expect(r.self_check?.patch_keys_exist_in_nodedef).toBe(true);
  });

  it('🚨 code fences ```json ... ``` strip-pati', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService('```json\n' + validLlmJson + '\n```');
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.explanation).toBe('SMTP host unreachable');
  });

  it('🚨 invalid JSON → LlmResponseError', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService('not a json at all');
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(LlmResponseError);
  });

  it('🚨 missing required field (no fix) → schema validation fail', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(JSON.stringify({ explanation: 'only this' }));
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(LlmResponseError);
  });

  it('🚨 confidence out-of-range (>1) → schema fail', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f', confidence: 1.5,
    }));
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(LlmResponseError);
  });

  it('🚨 risk enum invalid → schema fail', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f', risk: 'catastrophic',
    }));
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(LlmResponseError);
  });
});

describe('🚨 server_validation — patch validation post-LLM', () => {
  it('patch null → valid=true + issues=[]', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email', config: { host: 'x' } }],
    });
    const svc = makeService(validLlmJson);
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(true);
    expect(r.server_validation?.issues).toEqual([]);
  });

  it('🚨 updateNodes: nodeId inesistente → issue', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { updateNodes: [{ id: 'GHOST-NODE', patch: { config: {} } }] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(false);
    expect(r.server_validation?.issues.some((i) => i.includes('GHOST-NODE'))).toBe(true);
  });

  it('🚨 updateNodes: config key non in NodeDef.configFields → issue', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: {
        updateNodes: [{ id: 'n1', patch: { config: { invalidKey: 'x', host: 'ok' } } }],
      },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(false);
    expect(r.server_validation?.issues.some((i) => i.includes('invalidKey'))).toBe(true);
    // 'host' è valido → NON deve essere in issues
    expect(r.server_validation?.issues.every((i) => !i.includes('updateNodes[n1].config.host'))).toBe(true);
  });

  it('🚨 addNodes: defId non nel catalog → issue', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { addNodes: [{ defId: 'NON_EXISTENT_NODE' }] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(false);
    expect(r.server_validation?.issues.some((i) => i.includes('NON_EXISTENT_NODE'))).toBe(true);
  });

  it('🚨 removeNodeIds: nodeId inesistente → issue', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { removeNodeIds: ['GHOST'] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(false);
    expect(r.server_validation?.issues.some((i) => i.includes('GHOST'))).toBe(true);
  });

  it('🚨 workflow snapshot unavailable → issue specifico', async () => {
    seedRunAndWorkflow(m.sqlite, { nodes: [] });
    // Forzo la malformazione del workflow nodes_json
    m.sqlite.prepare(`UPDATE workflows SET nodes_json = ? WHERE id = ?`).run('not json{', 'wf-1');
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { updateNodes: [{ id: 'n1', patch: {} }] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(false);
    expect(r.server_validation?.issues[0]).toContain('workflow snapshot unavailable');
  });

  it('happy: updateNodes con config valido → valid=true', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { updateNodes: [{ id: 'n1', patch: { config: { host: 'smtp.new.com', port: 465 } } }] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.server_validation?.valid).toBe(true);
    expect(r.patch).toBeDefined();
  });
});

describe('🚨 metrics + interaction logging', () => {
  it('happy: counterInc success + histogramObserve called', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(validLlmJson);
    await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(m.counterInc).toHaveBeenCalledWith(expect.objectContaining({
      name: 'flowforge_ai_explain_total',
      tags: expect.objectContaining({ provider: 'anthropic', outcome: 'success' }),
    }));
    expect(m.histogramObserve).toHaveBeenCalledWith(expect.objectContaining({
      name: 'flowforge_ai_explain_latency_ms',
    }));
  });

  it('🚨 dispatch fail → counterInc error + propagate throw', async () => {
    seedRunAndWorkflow(m.sqlite);
    const failDispatcher: LlmDispatcher = async () => { throw new Error('API timeout'); };
    const svc = new AiExplainService(failDispatcher);
    await expect(svc.explain({ tenantId: 't1', runId: 'run-1' }))
      .rejects.toThrow(/API timeout/u);
    expect(m.counterInc).toHaveBeenCalledWith(expect.objectContaining({
      tags: expect.objectContaining({ outcome: 'error' }),
    }));
  });

  it('AIInteractionsService.insert chiamato con interactionType=run_explain', async () => {
    seedRunAndWorkflow(m.sqlite, { tenantId: 't1' });
    const svc = makeService(validLlmJson);
    await svc.explain({ tenantId: 't1', runId: 'run-1', userId: 'u-99' });
    expect(m.insertInteraction).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        tenantId: 't1', userId: 'u-99', workflowId: 'wf-1',
      }),
      interactionType: 'run_explain',
      response: expect.objectContaining({
        model: 'anthropic/claude-sonnet-4-5',
      }),
    }));
  });

  it('senza userId → context.userId NON nel payload', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(validLlmJson);
    await svc.explain({ tenantId: 't1', runId: 'run-1' });
    const callArgs = m.insertInteraction.mock.calls[0]?.[0] as { context: { userId?: string } };
    expect(callArgs.context.userId).toBeUndefined();
  });
});

describe('result.patch propagation', () => {
  it('patch presente in LLM reply → result.patch presente', async () => {
    seedRunAndWorkflow(m.sqlite, {
      nodes: [{ id: 'n1', defId: 'action_send_email' }],
    });
    const svc = makeService(JSON.stringify({
      explanation: 'e', fix: 'f',
      patch: { updateNodes: [{ id: 'n1', patch: { config: { host: 'x' } } }] },
    }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.patch).toEqual({ updateNodes: [{ id: 'n1', patch: { config: { host: 'x' } } }] });
  });

  it('patch assente → result.patch undefined', async () => {
    seedRunAndWorkflow(m.sqlite);
    const svc = makeService(JSON.stringify({ explanation: 'e', fix: 'f' }));
    const r = await svc.explain({ tenantId: 't1', runId: 'run-1' });
    expect(r.patch).toBeUndefined();
  });
});
