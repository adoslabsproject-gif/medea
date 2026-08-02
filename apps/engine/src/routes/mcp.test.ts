/**
 * Tests per mcp route — JSON-RPC 2.0 bridge MCP (Model Context Protocol).
 *
 * Invarianti CRITICALI:
 *  - JSON-RPC 2.0 envelope (jsonrpc, id, result|error)
 *  - initialize → protocolVersion + serverInfo + capabilities.tools
 *  - tools/list → array tools con name = wf_{slug}_{idShort}
 *  - tools/list → solo workflow enabled inclusi
 *  - tools/call → safeParseJson(last.output) prima del wrap content[text]
 *  - tools/call output stringa JSON → content.text = JSON pretty-print (2-space)
 *  - tools/call output stringa non-JSON → content.text = stringa raw
 *  - tools/call workflow fail → isError=true + nodeId + error message
 *  - tools/call missing name → error -32602
 *  - method sconosciuto → error -32601
 *  - body non-object → error -32600
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createMcpRoutes } from './mcp.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';

const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;

let workflowList: ReturnType<typeof vi.fn>;
let workflowListMcpExposed: ReturnType<typeof vi.fn>;
let workflowIsMcpExposed: ReturnType<typeof vi.fn>;
let runExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  workflowList = vi.fn(async () => [
    { id: 'abcd1234-uuid', name: 'My Tool', enabled: true, description: 'desc' },
    { id: 'efgh5678-uuid', name: 'Disabled Tool', enabled: false },
  ]);
  // AUDIT FIX WE-9: MCP usa listMcpExposed (opt-in). Default mock: My Tool è mcp_exposed.
  workflowListMcpExposed = vi.fn(async () => [
    { id: 'abcd1234-uuid', name: 'My Tool', description: 'desc' },
  ]);
  workflowIsMcpExposed = vi.fn(async (id: string) => id === 'abcd1234-uuid');
  runExecute = vi.fn();
  vi.spyOn(WorkflowService.prototype, 'list').mockImplementation(workflowList as never);
  vi.spyOn(WorkflowService.prototype, 'listMcpExposed').mockImplementation(
    workflowListMcpExposed as never,
  );
  vi.spyOn(WorkflowService.prototype, 'isMcpExposed').mockImplementation(
    workflowIsMcpExposed as never,
  );
  vi.spyOn(RunService.prototype, 'execute').mockImplementation(runExecute as never);
});

// Wrappa la route con un middleware che inietta auth context (tenantId + userId),
// altrimenti getTenantId() throw "called on unauthenticated request".
function makeApp() {
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('auth', { tenantId: 'default', userId: 'u-test', email: 'u@test.it', role: 'owner' });
    await next();
  });
  root.route('/', createMcpRoutes(eventBus));
  return root;
}

async function rpc(method: string, params?: unknown, id: string | number = 1) {
  const res = await makeApp().request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

describe('MCP — JSON-RPC envelope', () => {
  it('body non-object → error -32600 Invalid Request', async () => {
    const res = await makeApp().request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"plain-string"',
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
  });

  it('initialize → protocolVersion + serverInfo + capabilities', async () => {
    const r = (await rpc('initialize')) as {
      result: { protocolVersion: string; serverInfo: object; capabilities: object };
    };
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.serverInfo).toEqual({ name: 'flowforge-mcp', version: '0.1.0' });
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('method sconosciuto → error -32601', async () => {
    const r = (await rpc('totally/unknown')) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
  });
});

describe('MCP — tools/list', () => {
  it('ritorna solo workflow enabled', async () => {
    const r = (await rpc('tools/list')) as { result: { tools: { name: string }[] } };
    expect(r.result.tools).toHaveLength(1);
    expect(r.result.tools[0]!.name).toBe('wf_my_tool_abcd1234');
  });

  it('name pattern wf_{slug}_{idShort8} robusto a caratteri speciali', async () => {
    workflowListMcpExposed.mockResolvedValue([
      { id: '11112222-uuid', name: 'Hello, World! 2026', description: null },
    ]);
    const r = (await rpc('tools/list')) as { result: { tools: { name: string }[] } };
    expect(r.result.tools[0]!.name).toBe('wf_hello_world_2026_11112222');
  });

  /**
   * 🚨 AUDIT FIX WE-9 (2026-06-09 HIGH) — REGRESSION GUARD:
   *
   * Pre-fix: tools/list filtrava solo `enabled` → tutti i workflow del
   * tenant esposti a qualsiasi caller MCP autenticato → ACL bypass.
   *
   * Post-fix: solo workflow con mcp_exposed=1 (opt-in esplicito).
   */
  it('🚨 [REGRESSION WE-9] tools/list ritorna SOLO workflow con mcp_exposed (default 0)', async () => {
    // Workflow enabled MA non mcp_exposed → not in list
    workflowListMcpExposed.mockResolvedValue([]); // nessuno opt-in
    const r = (await rpc('tools/list')) as { result: { tools: unknown[] } };
    expect(r.result.tools).toHaveLength(0);
  });

  it('🚨 [REGRESSION WE-9] workflowList NON è chiamato (era leak attack-surface)', async () => {
    await rpc('tools/list');
    expect(workflowList).not.toHaveBeenCalled();
    expect(workflowListMcpExposed).toHaveBeenCalled();
  });
});

describe('MCP — tools/call', () => {
  it('missing name → error -32602', async () => {
    const r = (await rpc('tools/call', { arguments: {} })) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
  });

  it('tool name non trovato → error -32601 Tool not found', async () => {
    const r = (await rpc('tools/call', { name: 'wf_nope_xxx', arguments: {} })) as {
      error: { code: number; message: string };
    };
    expect(r.error.code).toBe(-32601);
    expect(r.error.message).toContain('Tool not found');
  });

  /**
   * 🚨 AUDIT FIX WE-9 (2026-06-09 HIGH) — REGRESSION GUARD per /tools/call:
   *
   * Pre-fix: tools/call cercava in `workflows.list()` → un workflow enabled
   * MA non mcp_exposed era invocabile da MCP. Post-fix: listMcpExposed.
   */
  it('🚨 [REGRESSION WE-9] workflow enabled MA non mcp_exposed → tools/call ritorna Tool not found', async () => {
    workflowListMcpExposed.mockResolvedValue([]); // nessuno opt-in MCP
    const r = (await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234', // workflow esiste enabled, MA non mcp_exposed
      arguments: {},
    })) as { error: { code: number; message: string } };
    expect(r.error.code).toBe(-32601);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('🚨 [REGRESSION WE-9] TOCTOU: workflow disabilitato tra list e call → 404 (no race exec)', async () => {
    // list ritorna match
    workflowListMcpExposed.mockResolvedValue([
      { id: 'abcd1234-uuid', name: 'My Tool', description: 'desc' },
    ]);
    // Ma re-check isMcpExposed ritorna false (workflow disabilitato nel frattempo)
    workflowIsMcpExposed.mockResolvedValue(false);
    const r = (await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: {},
    })) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
    expect(runExecute).not.toHaveBeenCalled();
  });

  it('workflow fail → isError=true + failed node id + error msg', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-fail',
      status: 'error',
      steps: [
        { nodeId: 'n1', status: 'success' },
        { nodeId: 'n2', status: 'error', error: 'db timeout' },
      ],
    });
    const r = (await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: {},
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain('n2');
    expect(r.result.content[0]!.text).toContain('db timeout');
  });

  it('output stringa JSON object → content.text = JSON pretty (2-space)', async () => {
    const finalOutput = { rows: [{ id: 1 }], count: 1 };
    runExecute.mockResolvedValue({
      runId: 'r-ok',
      status: 'success',
      steps: [{ status: 'success', output: JSON.stringify(finalOutput) }],
    });
    const r = (await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: { input: {} },
    })) as { result: { content: { type: string; text: string }[] } };
    expect(r.result.content[0]!.type).toBe('text');
    expect(JSON.parse(r.result.content[0]!.text)).toEqual(finalOutput);
    // Pretty-print verificato: contiene newlines
    expect(r.result.content[0]!.text).toContain('\n');
  });

  it('output stringa non-JSON → content.text = stringa raw (no JSON wrap)', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-plain',
      status: 'success',
      steps: [{ status: 'success', output: 'plain answer string' }],
    });
    const r = (await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toBe('plain answer string');
  });

  it('triggerInput: arguments.input se presente, else arguments object intero', async () => {
    runExecute.mockResolvedValue({
      runId: 'r',
      status: 'success',
      steps: [{ status: 'success', output: 'x' }],
    });
    await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: { input: { explicit: true } },
    });
    expect(runExecute.mock.calls[0]![0].triggerInput).toEqual({ explicit: true });

    runExecute.mockClear();
    runExecute.mockResolvedValue({
      runId: 'r',
      status: 'success',
      steps: [{ status: 'success', output: 'x' }],
    });
    await rpc('tools/call', {
      name: 'wf_my_tool_abcd1234',
      arguments: { fallback: 'arg' },
    });
    expect(runExecute.mock.calls[0]![0].triggerInput).toEqual({ fallback: 'arg' });
  });

  it('triggerType = "mcp" propagato a RunService.execute', async () => {
    runExecute.mockResolvedValue({
      runId: 'r',
      status: 'success',
      steps: [{ status: 'success', output: '{}' }],
    });
    await rpc('tools/call', { name: 'wf_my_tool_abcd1234', arguments: {} });
    expect(runExecute.mock.calls[0]![0].triggerType).toBe('mcp');
  });
});

describe('MCP — error handling', () => {
  it('exception interna → error -32603 con message', async () => {
    // WE-9 fix: route ora chiama listMcpExposed (non list). Mock il method giusto.
    workflowListMcpExposed.mockRejectedValue(new Error('storage down'));
    const r = (await rpc('tools/list')) as { error: { code: number; message: string } };
    expect(r.error.code).toBe(-32603);
    expect(r.error.message).toBe('storage down');
  });
});
