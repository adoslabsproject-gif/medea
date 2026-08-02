/**
 * Tests per invoke route — POST /workflows/:id/invoke + safeParseJson contract.
 *
 * Invarianti CRITICALI:
 *  - Body non-JSON → 400 con error string
 *  - Workflow non trovato → 404
 *  - status !== 'success' → 422 con runId + failedNodeId + error
 *  - result = safeParseJson(last step.output) — step.output e` SEMPRE stringa
 *    JSON dal workflow-engine, deve essere riconvertito in object
 *  - successSteps filter: solo step status=success contribuiscono al "last"
 *  - empty steps → result = null (no crash)
 *  - last.output stringa non-JSON → result = stringa as-is
 *  - exception in runs.execute → 500 con error message
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createInvokeRoutes } from './invoke.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';

const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn() } as unknown as IEventBus;

let workflowGet: ReturnType<typeof vi.fn>;
let runExecute: ReturnType<typeof vi.fn>;

beforeEach(() => {
  workflowGet = vi.fn(async (id: string) =>
    id === 'wf-1' ? { id, tenantId: 'default', enabled: true } : null,
  );
  runExecute = vi.fn();
  vi.spyOn(WorkflowService.prototype, 'get').mockImplementation(workflowGet as never);
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
  root.route('/', createInvokeRoutes(eventBus));
  return root;
}

describe('POST /workflows/:id/invoke — input validation', () => {
  it('body non-JSON → 400 con error string', async () => {
    const res = await makeApp().request('/workflows/wf-1/invoke', {
      method: 'POST',
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Body must be valid JSON');
  });

  it('body vuoto → triggerInput null, workflow trovato → 200', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-empty',
      status: 'success',
      totalDurationMs: 5,
      steps: [{ status: 'success', output: JSON.stringify({ ok: true }) }],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '' });
    expect(res.status).toBe(200);
    const args = runExecute.mock.calls[0]![0] as { triggerInput?: unknown };
    expect(args.triggerInput).toBeUndefined();
  });

  it('workflow inesistente → 404', async () => {
    const res = await makeApp().request('/workflows/nope/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('🚨 [REGRESSION WE-16] workflow disabilitato → 409 WORKFLOW_DISABLED, runs.execute NON chiamato', async () => {
    workflowGet.mockImplementation(async (id: string) =>
      id === 'wf-1' ? { id, tenantId: 'default', enabled: false } : null,
    );
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('WORKFLOW_DISABLED');
    expect(body.message).toMatch(/disabled/i);
    expect(runExecute).not.toHaveBeenCalled();
  });
});

describe('POST /workflows/:id/invoke — error paths', () => {
  it('status != success → 422 con runId + failedNodeId + error', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-fail',
      status: 'error',
      steps: [
        { nodeId: 'n1', status: 'success' },
        { nodeId: 'n2', status: 'error', error: 'connection refused' },
      ],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { runId: string; failedNodeId: string; error: string };
    expect(body.runId).toBe('r-fail');
    expect(body.failedNodeId).toBe('n2');
    expect(body.error).toBe('connection refused');
  });

  it('runs.execute throw → 500 con error message', async () => {
    runExecute.mockRejectedValue(new Error('boom'));
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('boom');
  });
});

describe('POST /workflows/:id/invoke — safeParseJson on step.output', () => {
  it('step.output stringa JSON → result object deserializzato', async () => {
    const finalOutput = { emails: [{ email: 'a@b.it' }], count: 1 };
    runExecute.mockResolvedValue({
      runId: 'r-stringified',
      status: 'success',
      totalDurationMs: 12,
      steps: [
        { status: 'success', output: JSON.stringify({ step1: true }) },
        { status: 'success', output: JSON.stringify(finalOutput) },
      ],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toEqual(finalOutput);
    expect(typeof body.result).toBe('object');
  });

  it('step.output stringa non-JSON → result stringa as-is', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-plain',
      status: 'success',
      totalDurationMs: 1,
      steps: [{ status: 'success', output: 'plain text not json' }],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toBe('plain text not json');
  });

  it('successSteps vuoto (tutti error/skip) → result = null', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-no-success',
      status: 'success',
      totalDurationMs: 0,
      steps: [{ status: 'skipped' }, { status: 'skipped' }],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toBeNull();
  });

  it('successSteps filter: prende ultimo SUCCESS, ignora error finale', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-mixed',
      status: 'success',
      totalDurationMs: 8,
      steps: [
        { status: 'success', output: JSON.stringify({ first: true }) },
        { status: 'success', output: JSON.stringify({ second: true }) },
        // hypothetical step error after — non dovrebbe entrare in last
        { status: 'error', output: 'ignored' },
      ],
    });
    const res = await makeApp().request('/workflows/wf-1/invoke', { method: 'POST', body: '{}' });
    const body = (await res.json()) as { result: { second: boolean } };
    expect(body.result).toEqual({ second: true });
  });
});

describe('POST /workflows/:id/invoke — triggerInput propagation', () => {
  it('body JSON object → propagato come triggerInput a RunService.execute', async () => {
    runExecute.mockResolvedValue({
      runId: 'r-1',
      status: 'success',
      totalDurationMs: 1,
      steps: [{ status: 'success', output: JSON.stringify({ ok: true }) }],
    });
    await makeApp().request('/workflows/wf-1/invoke', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar', n: 42 }),
    });
    const args = runExecute.mock.calls[0]![0] as { triggerInput: unknown; triggerType: string };
    expect(args.triggerInput).toEqual({ foo: 'bar', n: 42 });
    expect(args.triggerType).toBe('invoke');
  });
});
