/**
 * Test ai-inline.ts — coverage avanzato.
 *
 * Verifica:
 *  - sanitizeCompletion: strip fence ```ts/js
 *  - strip prefix "Here's the completion:"
 *  - strip /* >>> CURSOR <<< * / marker
 *  - dedupe overlap con ultima riga contesto
 *  - callInlineCompletion: success path → completion sanitized + usage
 *  - HTTP error → fallback empty (no throw)
 *  - gateway timeout/abort → fallback empty
 *  - request body shape (model, temperature=0.15, max_tokens=100, stop sequences)
 *  - headers X-FF-Workspace / X-FF-Feature
 *  - empty raw → empty completion
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeCompletion, callInlineCompletion } from './ai-inline.js';

vi.mock('@/lib/logger.js');

// ai-inline passa dal GATEWAY PORTAL via fetch RAW (helper llm-gateway).
const mockFetch = vi.fn();
const origFetch = globalThis.fetch;

describe('sanitizeCompletion', () => {
  it('passthrough plain text', () => {
    expect(sanitizeCompletion('return value;', '')).toBe('return value;');
  });

  it('strip fence ```typescript ... ```', () => {
    expect(sanitizeCompletion('```typescript\nreturn 1;\n```', '')).toBe('return 1;');
  });

  it('strip fence ```ts ... ```', () => {
    expect(sanitizeCompletion('```ts\nfoo();\n```', '')).toBe('foo();');
  });

  it('strip fence ```js ... ```', () => {
    expect(sanitizeCompletion('```js\nvar x = 1;\n```', '')).toBe('var x = 1;');
  });

  it('strip fence senza language', () => {
    expect(sanitizeCompletion('```\nreturn 1;\n```', '')).toBe('return 1;');
  });

  it('strip prefix "Here is the completion:"', () => {
    expect(sanitizeCompletion('Here is the completion: return 1;', '')).toBe('return 1;');
  });

  it('strip prefix "Sure!"', () => {
    expect(sanitizeCompletion('Sure! return 1;', '')).toBe('return 1;');
  });

  it('strip /* >>> CURSOR <<< */ marker leakato', () => {
    expect(sanitizeCompletion('/* >>> CURSOR <<< */\nreturn 1;', '')).toBe('return 1;');
  });

  it('dedupe overlap con ultima riga del contesto', () => {
    const ctx = 'function foo() {\n  if (a) {';
    const raw = 'if (a) {\n    return 1;\n  }';
    expect(sanitizeCompletion(raw, ctx)).toBe('return 1;\n  }');
  });

  it('NO dedupe se ultima riga troppo corta (<5 char)', () => {
    const ctx = 'function f(\n  x';
    const raw = 'x: number';
    expect(sanitizeCompletion(raw, ctx)).toBe('x: number');
  });

  it('trim whitespace finale', () => {
    expect(sanitizeCompletion('return 1;\n\n\n', '')).toBe('return 1;');
  });

  it('empty raw → empty output', () => {
    expect(sanitizeCompletion('', '')).toBe('');
    expect(sanitizeCompletion('   \n\n  ', '')).toBe('');
  });
});

describe('callInlineCompletion', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.MEDEA_LIARA_BASE_URL = 'http://gw/api/v1/llm';
    process.env.MEDEA_LICENSE_KEY = 'ZFL-TEST';
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const baseReq = {
    workspaceId: 'ws_test',
    nodeId: 'cn_abc',
    file: 'executor.ts',
    contextBefore: 'function exec() {',
    cursorLine: 1,
    cursorColumn: 18,
  };

  function mockOk(content: string, usage = { prompt_tokens: 50, completion_tokens: 10 }) {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage }),
    } as unknown as Response);
  }

  it('success path: sanitized completion + usage tokens', async () => {
    mockOk('```ts\nreturn 1;\n```');
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('return 1;');
    expect(out.tokensIn).toBe(50);
    expect(out.tokensOut).toBe(10);
    expect(out.fromCache).toBe(false);
  });

  it('routing GATEWAY: URL /chat/completions + Bearer license + model OMESSO (gateway inietta)', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    const [url, init] = mockFetch.mock.calls[0]! as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://gw/api/v1/llm/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer ZFL-TEST');
    const body = JSON.parse(init.body);
    expect(body.temperature).toBe(0.15);
    expect(body.max_tokens).toBe(100);
    expect(body.model).toBeUndefined(); // niente più liara:3003/model fittizio
  });

  it('stop sequences \\n\\n, \\n```, /* >>>', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(body.stop).toEqual(['\n\n', '\n```', '/* >>>']);
  });

  it('headers: X-FF-Workspace + X-FF-Feature=inline-completion', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    const init = mockFetch.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['X-FF-Workspace']).toBe('ws_test');
    expect(init.headers['X-FF-Feature']).toBe('inline-completion');
  });

  it('messages: system prompt + user prompt che include cursor marker', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('>>> CURSOR <<<');
    expect(body.messages[1].content).toContain('executor.ts');
  });

  it('HTTP 500 → fallback empty completion (no throw)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
  });

  it("gateway unreachable (throw) → fallback empty (no throw all'esterno)", async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
  });

  it('empty content → empty completion', async () => {
    mockOk('', { prompt_tokens: 10, completion_tokens: 0 });
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
    expect(out.tokensIn).toBe(10);
  });

  it('completion contiene markdown spurio → sanitized', async () => {
    mockOk('Sure! Here is the code:\n```ts\nreturn ctx.input;\n```');
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('return ctx.input;');
  });

  it('usage assente → tokens 0/0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'foo' } }] }),
    } as unknown as Response);
    const out = await callInlineCompletion(baseReq);
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
  });

  it('timeout via AbortSignal (8s, più aggressivo di ai-assist 240s)', async () => {
    mockOk('foo');
    await callInlineCompletion(baseReq);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal); // AbortSignal.timeout(8000)
  });
});
