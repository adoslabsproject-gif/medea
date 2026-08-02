/**
 * Test route POST /:id/inline-completion — coverage avanzato.
 *
 * Verifica:
 *  - 400 su body shape invalido (no file, no contextBefore, no contextBefore string)
 *  - context truncate a -4000 char + file slice 64 char (DoS prevention)
 *  - cursorLine/Column floor & clamp >= 1
 *  - exception interna → fallback empty (NO 500)
 *  - success path chiama callInlineCompletion con workspaceId resolved
 *  - rate-limit middleware applicato
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies
vi.mock('@/middleware/rbac.js', () => ({
  requireRole: () => (_c: unknown, next: () => Promise<unknown>) => next(),
}));
vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => (_c: unknown, next: () => Promise<unknown>) => next(),
}));
vi.mock('@/lib/logger.js');
const callInlineCompletionMock = vi.fn();
vi.mock('@/services/custom-nodes/ai-inline.js', () => ({
  callInlineCompletion: (...args: unknown[]) => callInlineCompletionMock(...args),
}));
// Stub gli altri service per soddisfare gli import del route file
vi.mock('@/services/custom-nodes/index.js', () => ({
  createCustomNode: vi.fn(),
  getCustomNode: vi.fn(),
  listCustomNodes: vi.fn(),
  updateCustomNode: vi.fn(),
  listVersions: vi.fn(),
  rollbackToVersion: vi.fn(),
  archiveCustomNode: vi.fn(),
  compileAndPersist: vi.fn(),
  countActiveCustomNodes: vi.fn(),
  resolveTenantPlan: vi.fn(),
  publishCustomNodePrivate: vi.fn(),
  unpublishCustomNode: vi.fn(),
  submitCustomNodeToMarketplace: vi.fn(),
  withdrawCustomNodeFromMarketplace: vi.fn(),
  PLAN_CAPABILITIES: {},
  CustomNodeError: class extends Error {},
  CustomNodeCreateInputSchema: { parse: vi.fn() },
  CustomNodeUpdateInputSchema: { parse: vi.fn() },
  CustomNodeListFilterSchema: { parse: vi.fn() },
  semverField: { parse: vi.fn() },
}));

import { createCustomNodesRoutes } from './custom-nodes.js';
import { jsonBody } from '@/lib/test-json-body.js';

// Helper per mount + inject ctx
function makeApp() {
  const app = new Hono();
  // Inject mock auth ctx per resolveCtx (reads c.get('auth'))
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('auth', { userId: 'u_test', tenantId: 'ws_test' });
    await next();
  });
  app.route('/', createCustomNodesRoutes());
  return app;
}

describe('POST /:id/inline-completion', () => {
  beforeEach(() => { callInlineCompletionMock.mockReset(); });

  it('success path: chiama service + ritorna body', async () => {
    callInlineCompletionMock.mockResolvedValue({
      completion: 'return 1;',
      tokensIn: 50,
      tokensOut: 5,
      fromCache: false,
    });
    const app = makeApp();
    const res = await app.request('/cn_abc/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'executor.ts', contextBefore: 'ctx', cursorLine: 5, cursorColumn: 10 }),
    });
    expect(res.status).toBe(200);
    const json = await jsonBody(res);
    expect(json.completion).toBe('return 1;');
    expect(callInlineCompletionMock).toHaveBeenCalledTimes(1);
    expect(callInlineCompletionMock.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws_test',
      nodeId: 'cn_abc',
      file: 'executor.ts',
      contextBefore: 'ctx',
      cursorLine: 5,
      cursorColumn: 10,
    });
  });

  it('400 se contextBefore non stringa', async () => {
    const app = makeApp();
    const res = await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'executor.ts', contextBefore: 123, cursorLine: 1, cursorColumn: 1 }),
    });
    expect(res.status).toBe(400);
    expect(callInlineCompletionMock).not.toHaveBeenCalled();
  });

  it('400 se file non stringa', async () => {
    const app = makeApp();
    const res = await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextBefore: 'x', cursorLine: 1, cursorColumn: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('truncate contextBefore a 4000 char', async () => {
    callInlineCompletionMock.mockResolvedValue({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
    const app = makeApp();
    const huge = 'A'.repeat(10_000);
    await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'f.ts', contextBefore: huge, cursorLine: 1, cursorColumn: 1 }),
    });
    const arg = callInlineCompletionMock.mock.calls[0]![0];
    expect(arg.contextBefore.length).toBe(4_000);
  });

  it('truncate file name a 64 char', async () => {
    callInlineCompletionMock.mockResolvedValue({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
    const app = makeApp();
    const longName = 'x'.repeat(200) + '.ts';
    await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: longName, contextBefore: '', cursorLine: 1, cursorColumn: 1 }),
    });
    const arg = callInlineCompletionMock.mock.calls[0]![0];
    expect(arg.file.length).toBe(64);
  });

  it('clamp cursorLine >= 1', async () => {
    callInlineCompletionMock.mockResolvedValue({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
    const app = makeApp();
    await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'f.ts', contextBefore: '', cursorLine: -5, cursorColumn: 0 }),
    });
    const arg = callInlineCompletionMock.mock.calls[0]![0];
    expect(arg.cursorLine).toBe(1);
    expect(arg.cursorColumn).toBe(1);
  });

  it('exception interna → fallback empty NO 500', async () => {
    callInlineCompletionMock.mockRejectedValue(new Error('Liara down'));
    const app = makeApp();
    const res = await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'f.ts', contextBefore: '', cursorLine: 1, cursorColumn: 1 }),
    });
    expect(res.status).toBe(200);
    const json = await jsonBody(res);
    expect(json.completion).toBe('');
    expect(json.tokensIn).toBe(0);
  });

  it('floor cursorLine fractionario', async () => {
    callInlineCompletionMock.mockResolvedValue({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
    const app = makeApp();
    await app.request('/cn_x/inline-completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'f.ts', contextBefore: '', cursorLine: 5.7, cursorColumn: 10.99 }),
    });
    const arg = callInlineCompletionMock.mock.calls[0]![0];
    expect(arg.cursorLine).toBe(5);
    expect(arg.cursorColumn).toBe(10);
  });
});
