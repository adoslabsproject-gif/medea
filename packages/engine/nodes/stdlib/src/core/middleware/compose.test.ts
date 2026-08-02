/**
 * Test 2026-grade — compose + wrap (Koa-style middleware pipeline).
 *
 * 🚨 ONION EXECUTION: a-before → b-before → c-before → exec → c-after → b-after → a-after.
 *
 * 🚨 EMPTY pipeline → executor passed-through unchanged.
 *
 * 🚨 wrap = compose + apply in one call (convenience).
 */
import { describe, it, expect, vi } from 'vitest';
import { compose, wrap } from './compose.js';
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from '../../types.js';

const ctx: NodeExecutionContext = {
  tenantId: 't',
  workflowId: 'w',
  runId: 'r',
  nodeId: 'n',
  secrets: {},
};

function makeExecutor(label: string, trace: string[]): NodeExecutor {
  return async () => {
    trace.push(`exec:${label}`);
    return { output: label, durationMs: 1 } satisfies NodeExecutionResult;
  };
}

describe('🚨 compose — onion execution order', () => {
  it('🚨 empty pipeline → executor unchanged (identity wrap)', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('inner', trace);
    const wrapped = compose([])(exec);
    const result = await wrapped({}, {}, ctx);
    expect(result.output).toBe('inner');
    expect(trace).toEqual(['exec:inner']);
  });

  it('🚨 1 middleware: before → exec → after', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('inner', trace);
    const mw =
      (next: NodeExecutor): NodeExecutor =>
      async (cfg, inp, c) => {
        trace.push('a:before');
        const r = await next(cfg, inp, c);
        trace.push('a:after');
        return r;
      };
    await compose([mw])(exec)({}, {}, ctx);
    expect(trace).toEqual(['a:before', 'exec:inner', 'a:after']);
  });

  it('🚨 3 middleware: left-to-right onion (a out, c in)', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('core', trace);
    const mk =
      (name: string) =>
      (next: NodeExecutor): NodeExecutor =>
      async (cfg, inp, c) => {
        trace.push(`${name}:before`);
        const r = await next(cfg, inp, c);
        trace.push(`${name}:after`);
        return r;
      };
    await compose([mk('a'), mk('b'), mk('c')])(exec)({}, {}, ctx);
    expect(trace).toEqual([
      'a:before',
      'b:before',
      'c:before',
      'exec:core',
      'c:after',
      'b:after',
      'a:after',
    ]);
  });

  it('🚨 middleware can short-circuit (no next() call)', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('inner', trace);
    const blockerMw =
      (_next: NodeExecutor): NodeExecutor =>
      async () => {
        trace.push('blocked');
        return { output: 'short-circuit', durationMs: 0 } satisfies NodeExecutionResult;
      };
    const result = await compose([blockerMw])(exec)({}, {}, ctx);
    expect(result.output).toBe('short-circuit');
    expect(trace).toEqual(['blocked']);
    expect(trace).not.toContain('exec:inner');
  });

  it('🚨 middleware errors propagate', async () => {
    const exec = makeExecutor('inner', []);
    const errMw =
      (_next: NodeExecutor): NodeExecutor =>
      async () => {
        throw new Error('mw blocked');
      };
    await expect(compose([errMw])(exec)({}, {}, ctx)).rejects.toThrow('mw blocked');
  });

  it('🚨 sparse undefined middleware (es. [a, undefined, c]) → skip undefined', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('e', trace);
    const mw =
      (name: string) =>
      (next: NodeExecutor): NodeExecutor =>
      async (cfg, inp, c) => {
        trace.push(name);
        return next(cfg, inp, c);
      };
    // Source: `if (mw) wrapped = mw(wrapped)` → undefined skip-safe
    const middlewares = [mw('a'), undefined, mw('c')] as unknown as Parameters<typeof compose>[0];
    await compose(middlewares)(exec)({}, {}, ctx);
    expect(trace).toEqual(['a', 'c', 'exec:e']);
  });
});

describe('🚨 wrap — convenience helper', () => {
  it('🚨 wrap = compose + apply (1 call)', async () => {
    const trace: string[] = [];
    const exec = makeExecutor('core', trace);
    const mw =
      (name: string) =>
      (next: NodeExecutor): NodeExecutor =>
      async (cfg, inp, c) => {
        trace.push(name);
        return next(cfg, inp, c);
      };
    const wrapped = wrap(exec, [mw('outer'), mw('inner')]);
    await wrapped({}, {}, ctx);
    expect(trace).toEqual(['outer', 'inner', 'exec:core']);
  });

  it('🚨 wrap empty array → executor unchanged', async () => {
    const exec = makeExecutor('e', []);
    const wrapped = wrap(exec, []);
    const result = await wrapped({}, {}, ctx);
    expect(result.output).toBe('e');
  });
});

describe('🚨 compose — context/config/input passed-through', () => {
  it('🚨 cfg/inp/ctx propagano fino al inner executor', async () => {
    const seen: { cfg?: unknown; inp?: unknown; ctxRef?: NodeExecutionContext } = {};
    const exec: NodeExecutor = async (cfg, inp, c) => {
      seen.cfg = cfg;
      seen.inp = inp;
      seen.ctxRef = c;
      return { output: null, durationMs: 0 };
    };
    const passthroughMw =
      (next: NodeExecutor): NodeExecutor =>
      async (cfg, inp, c) =>
        next(cfg, inp, c);
    const cfg = { key: 'value' };
    const inp = [1, 2, 3];
    await compose([passthroughMw])(exec)(cfg, inp, ctx);
    expect(seen.cfg).toBe(cfg);
    expect(seen.inp).toBe(inp);
    expect(seen.ctxRef).toBe(ctx);
  });

  it('🚨 middleware può modificare cfg downstream', async () => {
    const seen: { cfg?: Record<string, unknown> } = {};
    const exec: NodeExecutor = async (cfg) => {
      seen.cfg = cfg;
      return { output: null, durationMs: 0 };
    };
    const enrichMw: ReturnType<typeof vi.fn> = vi.fn(
      (next: NodeExecutor): NodeExecutor =>
        async (cfg, inp, c) =>
          next({ ...cfg, injected: true }, inp, c),
    );
    await compose([enrichMw])(exec)({ original: true }, {}, ctx);
    expect(seen.cfg).toEqual({ original: true, injected: true });
  });
});
