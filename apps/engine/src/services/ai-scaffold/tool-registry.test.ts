/**
 * Test 2026-grade — tool-registry.ts (AI agent tool dispatch).
 *
 * 🚨 AI MOAT-CRITICAL: registry pattern industry-standard (Vercel AI SDK,
 * Anthropic tool_use, OpenAI function calling). Test reali no mock.
 *
 * Coverage:
 *  - defineTool helper preserva types
 *  - register: idempotency guard (duplicate → throw fail-fast)
 *  - get / names / all introspection
 *  - execute dispatcher: tool sconosciuto → ok:false, Zod validate fail → ok:false
 *    handler async throws → caught → ok:false
 *  - toAnthropicToolsSpec / toOpenAIToolsSpec serializers
 *  - 🚨 zodToJsonSchema: object con required/optional, primitives,
 *    array, record, fallback
 *  - EmptyArgs (z.object({}) helper)
 *
 * NOTA: il toolRegistry esportato è un SINGLETON. Per testarlo senza
 * pollute state, useremo invece la classe interna istanziata localmente
 * — ricavata via reflection sul singleton (oppure replica della classe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  defineTool, EmptyArgs, toolRegistry, toAnthropicToolsSpec, toOpenAIToolsSpec,
  type ToolResult,
} from './tool-registry.js';

// Cleanup il singleton tra test
beforeEach(() => {
  // Reset tools map via reflection (no public reset method nel modulo)
  (toolRegistry as unknown as { tools: Map<string, unknown> }).tools.clear();
});

describe('defineTool', () => {
  it('helper returns the def unchanged (type-inference helper only)', () => {
    const tool = defineTool({
      name: 'noop',
      description: 'a tool',
      schema: z.object({ x: z.string() }),
      handler: (_session, args) => ({ ok: true, data: args.x }),
    });
    expect(tool.name).toBe('noop');
  });
});

describe('register / get / names / all', () => {
  it('register + get O(1) lookup', () => {
    toolRegistry.register({
      name: 't1', description: 'desc',
      schema: z.object({}),
      handler: () => ({ ok: true, data: null }),
    });
    expect(toolRegistry.get('t1')?.name).toBe('t1');
  });

  it('get inesistente → undefined', () => {
    expect(toolRegistry.get('ghost')).toBeUndefined();
  });

  it('names ritorna lista sorted', () => {
    toolRegistry.register({ name: 'b_tool', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    toolRegistry.register({ name: 'a_tool', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    toolRegistry.register({ name: 'c_tool', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    expect(toolRegistry.names()).toEqual(['a_tool', 'b_tool', 'c_tool']);
  });

  it('🚨 register duplicate → throw fail-fast al boot', () => {
    toolRegistry.register({ name: 't', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    expect(() => {
      toolRegistry.register({ name: 't', description: 'd2', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    }).toThrow(/duplicate registration/u);
  });

  it('all snapshot delle ToolDefinition (per LLM catalog)', () => {
    toolRegistry.register({ name: 't1', description: 'd1', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    toolRegistry.register({ name: 't2', description: 'd2', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    expect(toolRegistry.all()).toHaveLength(2);
  });
});

describe('🚨 execute() dispatcher', () => {
  const session = {} as never; // ScaffoldSession opaco — handler non lo usa nei test

  it('🚨 tool sconosciuto → ok:false con elenco available', async () => {
    toolRegistry.register({ name: 'real', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    const res = await toolRegistry.execute(session, 'ghost', {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('Tool sconosciuto');
    expect((res as { error: string }).error).toContain('real');
  });

  it('🚨 Zod validate fail → ok:false con issues human-readable', async () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({ name: z.string().min(3) }),
      handler: () => ({ ok: true, data: null }),
    });
    const res = await toolRegistry.execute(session, 't', { name: 'a' });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('Args invalidi');
    expect((res as { error: string }).error).toContain('name');
  });

  it('happy: schema valid → handler chiamato + ok:true', async () => {
    toolRegistry.register({
      name: 'echo', description: 'echoes input',
      schema: z.object({ msg: z.string() }),
      handler: (_s, args) => ({ ok: true, data: { echoed: args.msg } }),
    });
    const res = await toolRegistry.execute(session, 'echo', { msg: 'hi' });
    expect(res.ok).toBe(true);
    expect((res as { data: { echoed: string } }).data.echoed).toBe('hi');
  });

  it('🚨 handler throws → caught + ok:false (no crash dispatcher)', async () => {
    toolRegistry.register({
      name: 'bomb', description: 'd',
      schema: EmptyArgs,
      handler: () => { throw new Error('boom inside handler'); },
    });
    const res = await toolRegistry.execute(session, 'bomb', {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('boom inside handler');
  });

  it('🚨 handler async throws → caught', async () => {
    toolRegistry.register({
      name: 'async-bomb', description: 'd',
      schema: EmptyArgs,
      handler: async () => { await Promise.resolve(); throw new Error('async boom'); },
    });
    const res = await toolRegistry.execute(session, 'async-bomb', {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('async boom');
  });

  it('🚨 handler throws non-Error → coerced via String()', async () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: EmptyArgs,
      handler: () => { throw 'plain string'; },
    });
    const res = await toolRegistry.execute(session, 't', {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('plain string');
  });

  it('handler async ritorna direttamente ToolResult', async () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: EmptyArgs,
      handler: async () => { await Promise.resolve(); return { ok: true, data: 42 } as ToolResult<number>; },
    });
    const res = await toolRegistry.execute(session, 't', {});
    expect(res.ok).toBe(true);
  });
});

describe('🚨 toAnthropicToolsSpec — Anthropic Messages API tools[]', () => {
  it('shape: { name, description, input_schema } per ogni tool', () => {
    toolRegistry.register({
      name: 'list_db', description: 'List databases.',
      schema: z.object({ owner: z.string().optional() }),
      handler: () => ({ ok: true, data: [] }),
    });
    const spec = toAnthropicToolsSpec();
    expect(spec).toHaveLength(1);
    expect(spec[0]?.name).toBe('list_db');
    expect(spec[0]?.description).toBe('List databases.');
    expect(spec[0]?.input_schema).toHaveProperty('type', 'object');
  });

  it('multiple tools tutti serializzati', () => {
    toolRegistry.register({ name: 'a', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    toolRegistry.register({ name: 'b', description: 'd', schema: EmptyArgs, handler: () => ({ ok: true, data: null }) });
    expect(toAnthropicToolsSpec()).toHaveLength(2);
  });
});

describe('🚨 toOpenAIToolsSpec — OpenAI Chat Completions tools[]', () => {
  it('shape: { type: "function", function: { name, description, parameters } }', () => {
    toolRegistry.register({
      name: 'fn1', description: 'desc',
      schema: z.object({ x: z.string() }),
      handler: () => ({ ok: true, data: null }),
    });
    const spec = toOpenAIToolsSpec();
    expect(spec[0]?.type).toBe('function');
    expect(spec[0]?.function.name).toBe('fn1');
    expect(spec[0]?.function.parameters).toHaveProperty('type', 'object');
  });
});

describe('🚨 zodToJsonSchema — inlined Zod→JSON converter', () => {
  it('z.object con required + optional → properties + required[]', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({
        name: z.string(),
        age: z.number().optional(),
        active: z.boolean(),
      }),
      handler: () => ({ ok: true, data: null }),
    });
    const spec = toAnthropicToolsSpec();
    const schema = spec[0]?.input_schema as {
      type: string; properties: Record<string, unknown>; required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('name');
    expect(schema.properties).toHaveProperty('age');
    expect(schema.properties).toHaveProperty('active');
    expect(schema.required).toEqual(['name', 'active']);
    expect(schema.required).not.toContain('age');
  });

  it('primitivi: string/number/boolean/array', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({
        s: z.string(),
        n: z.number(),
        b: z.boolean(),
        arr: z.array(z.string()),
      }),
      handler: () => ({ ok: true, data: null }),
    });
    const spec = toAnthropicToolsSpec();
    const props = (spec[0]?.input_schema as { properties: Record<string, { type: string }> }).properties;
    expect(props.s?.type).toBe('string');
    expect(props.n?.type).toBe('number');
    expect(props.b?.type).toBe('boolean');
    expect(props.arr?.type).toBe('array');
  });

  it('🚨 array → items typed', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({ items: z.array(z.number()) }),
      handler: () => ({ ok: true, data: null }),
    });
    const props = (toAnthropicToolsSpec()[0]?.input_schema as { properties: { items: { items: { type: string } } } }).properties;
    expect(props.items.items.type).toBe('number');
  });

  it('z.record → object with additionalProperties=true', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({ data: z.record(z.string(), z.unknown()) }),
      handler: () => ({ ok: true, data: null }),
    });
    const props = (toAnthropicToolsSpec()[0]?.input_schema as { properties: { data: { type: string; additionalProperties: boolean } } }).properties;
    expect(props.data.type).toBe('object');
    expect(props.data.additionalProperties).toBe(true);
  });

  it('🚨 additionalProperties=false sul top-level object (strict shape)', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({ x: z.string() }),
      handler: () => ({ ok: true, data: null }),
    });
    const spec = toAnthropicToolsSpec();
    expect((spec[0]?.input_schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('z.object({}) (EmptyArgs) → no required, properties={}', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: EmptyArgs,
      handler: () => ({ ok: true, data: null }),
    });
    const spec = toAnthropicToolsSpec();
    const schema = spec[0]?.input_schema as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined(); // no required[] quando vuoto
  });

  it('fallback safe per type sconosciuti → "string"', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({ d: z.date() }), // ZodDate non handled → fallback
      handler: () => ({ ok: true, data: null }),
    });
    const props = (toAnthropicToolsSpec()[0]?.input_schema as { properties: { d: { type: string } } }).properties;
    expect(props.d.type).toBe('string');
  });

  it('z.default() field treated as optional (no in required)', () => {
    toolRegistry.register({
      name: 't', description: 'd',
      schema: z.object({
        name: z.string(),
        page: z.number().default(1),
      }),
      handler: () => ({ ok: true, data: null }),
    });
    const schema = toAnthropicToolsSpec()[0]?.input_schema as { required: string[] };
    expect(schema.required).toEqual(['name']);
    expect(schema.required).not.toContain('page');
  });
});

describe('EmptyArgs helper', () => {
  it('è un z.object({}) parseabile vuoto', () => {
    const r = EmptyArgs.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accetta extra fields ma li ignora (Zod default behavior)', () => {
    const r = EmptyArgs.safeParse({ extra: 'value' });
    expect(r.success).toBe(true);
  });
});
