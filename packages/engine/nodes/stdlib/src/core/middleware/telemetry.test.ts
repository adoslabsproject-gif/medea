/**
 * Test 2026-grade — withTelemetry middleware (OTel span wrapper).
 *
 * 🚨 OBSERVABILITY: ogni nodo executor span tagged con flowforge.{tenant,run,node,def}_id.
 *    Bug = trace incompleti → debugging incident impossibile.
 *
 * 🚨 ATTRS PRIORITY: dynamic > static > defaults (defaults overridable da custom).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { withSpanMock } = vi.hoisted(() => ({
  withSpanMock: vi.fn(async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../telemetry.js', () => ({
  withSpan: withSpanMock,
}));

const { withTelemetry } = await import('./telemetry.js');
import type { NodeExecutor, NodeExecutionContext } from '../../types.js';

beforeEach(() => {
  vi.clearAllMocks();
  withSpanMock.mockImplementation(async (_name, _attrs, fn) => fn());
});

const baseCtx: NodeExecutionContext = {
  tenantId: 'tenant-X',
  workflowId: 'wf-1',
  runId: 'run-42',
  nodeId: 'node-7',
  defId: 'action_http',
  secrets: {},
};

function makeInner(out: unknown = { ok: true }): NodeExecutor {
  return vi.fn().mockResolvedValue({ output: out, durationMs: 5 });
}

describe('🚨 default spanName + attrs flowforge.*', () => {
  it('🚨 spanName default "node.exec"', async () => {
    const wrapped = withTelemetry()(makeInner());
    await wrapped({}, {}, baseCtx);
    expect(withSpanMock).toHaveBeenCalledWith('node.exec', expect.any(Object), expect.any(Function));
  });

  it('🚨 attrs include flowforge.tenant_id + run_id + node_id + def_id', async () => {
    const wrapped = withTelemetry()(makeInner());
    await wrapped({}, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['flowforge.tenant_id']).toBe('tenant-X');
    expect(attrs['flowforge.run_id']).toBe('run-42');
    expect(attrs['flowforge.node_id']).toBe('node-7');
    expect(attrs['flowforge.def_id']).toBe('action_http');
  });

  it('🚨 ctx.defId undefined → flowforge.def_id NOT in attrs (NO undefined leak)', async () => {
    const ctx = { ...baseCtx };
    delete (ctx as { defId?: string }).defId;
    const wrapped = withTelemetry()(makeInner());
    await wrapped({}, {}, ctx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs).not.toHaveProperty('flowforge.def_id');
  });
});

describe('🚨 custom spanName + static attrs', () => {
  it('🚨 spanName custom', async () => {
    const wrapped = withTelemetry({ spanName: 'node.http.request' })(makeInner());
    await wrapped({}, {}, baseCtx);
    expect(withSpanMock).toHaveBeenCalledWith('node.http.request', expect.any(Object), expect.any(Function));
  });

  it('🚨 static attrs merged dopo defaults', async () => {
    const wrapped = withTelemetry({
      attrs: { 'http.method': 'POST', 'http.host': 'api.example.com' },
    })(makeInner());
    await wrapped({}, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['http.method']).toBe('POST');
    expect(attrs['http.host']).toBe('api.example.com');
    // Defaults preserved
    expect(attrs['flowforge.tenant_id']).toBe('tenant-X');
  });

  it('🚨 static attrs sovrascrivono defaults (custom > default)', async () => {
    const wrapped = withTelemetry({
      attrs: { 'flowforge.tenant_id': 'OVERRIDDEN' },
    })(makeInner());
    await wrapped({}, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['flowforge.tenant_id']).toBe('OVERRIDDEN');
  });
});

describe('🚨 dynamicAttrs per-call', () => {
  it('🚨 dynamicAttrs computati con (config, ctx)', async () => {
    const wrapped = withTelemetry({
      dynamicAttrs: (config, ctx) => ({
        'http.url': (config as { url: string }).url,
        'tenant.label': ctx.tenantId.toUpperCase(),
      }),
    })(makeInner());
    await wrapped({ url: 'https://api.x.com/v1/users' }, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['http.url']).toBe('https://api.x.com/v1/users');
    expect(attrs['tenant.label']).toBe('TENANT-X');
  });

  it('🚨 dynamicAttrs sovrascrivono static (dynamic > static > default)', async () => {
    const wrapped = withTelemetry({
      attrs: { 'http.method': 'GET' },
      dynamicAttrs: () => ({ 'http.method': 'POST' }),
    })(makeInner());
    await wrapped({}, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['http.method']).toBe('POST');
  });

  it('🚨 dynamicAttrs vuoto {} → no-op (defaults preserved)', async () => {
    const wrapped = withTelemetry({
      dynamicAttrs: () => ({}),
    })(makeInner());
    await wrapped({}, {}, baseCtx);
    const attrs = withSpanMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['flowforge.tenant_id']).toBe('tenant-X');
  });
});

describe('🚨 inner executor result propagation', () => {
  it('🚨 result inner ritornato AS-IS', async () => {
    const inner = makeInner({ data: [1, 2, 3] });
    const wrapped = withTelemetry()(inner);
    const result = await wrapped({}, {}, baseCtx);
    expect(result.output).toEqual({ data: [1, 2, 3] });
  });

  it('🚨 inner THROW → propagato (withSpan deve catturare per Otel span error)', async () => {
    // Verifica behavior pure: span è il responsabile della cattura error.
    // Mocked withSpan delega fn() — se fn throw, withSpan re-throw.
    withSpanMock.mockImplementationOnce(async (_n, _a, fn) => fn());
    const failingInner: NodeExecutor = async () => { throw new Error('exec failed'); };
    const wrapped = withTelemetry()(failingInner);
    await expect(wrapped({}, {}, baseCtx)).rejects.toThrow('exec failed');
  });

  it('🚨 input arg propagato a inner', async () => {
    const seen: { inp?: unknown } = {};
    const inner: NodeExecutor = async (_cfg, inp) => {
      seen.inp = inp;
      return { output: null, durationMs: 0 };
    };
    const wrapped = withTelemetry()(inner);
    await wrapped({}, { data: 'payload' }, baseCtx);
    expect(seen.inp).toEqual({ data: 'payload' });
  });
});
