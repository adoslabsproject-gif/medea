/**
 * Test ai-inline.ts — coverage avanzato.
 *
 * Verifica:
 *  - sanitizeCompletion: strip fence ```ts/js
 *  - strip prefix "Here's the completion:"
 *  - strip /* >>> CURSOR <<< * / marker
 *  - dedupe overlap con ultima riga contesto
 *  - callInlineCompletion: success path → completion sanitized + usage
 *  - errore del provider / nessun provider → fallback empty (no throw)
 *  - cosa viene chiesto (temperature=0.15, maxTokens=100, stop sequences, 8s)
 *  - empty raw → empty completion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger.js');

// ai-inline chiede la risposta al provider del tenant tramite `tenant-llm`:
// qui lo si sostituisce e si guarda cosa gli viene chiesto.
const { tenantChatCompletion } = vi.hoisted(() => ({ tenantChatCompletion: vi.fn() }));
vi.mock('./tenant-llm.js', () => ({ tenantChatCompletion }));

import { sanitizeCompletion, callInlineCompletion } from './ai-inline.js';

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
    tenantChatCompletion.mockReset();
  });

  const baseReq = {
    workspaceId: 'ws_test',
    nodeId: 'cn_abc',
    file: 'executor.ts',
    contextBefore: 'function exec() {',
    cursorLine: 1,
    cursorColumn: 18,
  };

  function mockOk(content: string, usage = { input: 50, output: 10 }) {
    tenantChatCompletion.mockResolvedValue({ content, usage, provider: 'openai' });
  }

  /** Quello che è stato chiesto al provider. */
  function chiesto(): {
    messages: { role: string; content: string }[];
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    workspaceId: string;
    stop?: string[];
  } {
    return tenantChatCompletion.mock.calls[0]![0] as ReturnType<typeof chiesto>;
  }

  it('success path: sanitized completion + usage tokens', async () => {
    mockOk('```ts\nreturn 1;\n```');
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('return 1;');
    expect(out.tokensIn).toBe(50);
    expect(out.tokensOut).toBe(10);
    expect(out.fromCache).toBe(false);
  });

  it('chiede poco e in fretta: temperature 0.15, 100 token, 8 secondi, per il tenant giusto', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    expect(chiesto().temperature).toBe(0.15);
    expect(chiesto().maxTokens).toBe(100);
    expect(chiesto().timeoutMs).toBe(8_000);
    expect(chiesto().workspaceId).toBe('ws_test');
  });

  it('stop sequences \\n\\n, \\n```, /* >>>', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    expect(chiesto().stop).toEqual(['\n\n', '\n```', '/* >>>']);
  });

  it('messages: system prompt + user prompt che include cursor marker', async () => {
    mockOk('done');
    await callInlineCompletion(baseReq);
    const { messages } = chiesto();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('>>> CURSOR <<<');
    expect(messages[1]!.content).toContain('executor.ts');
  });

  it('errore del provider → fallback empty completion (no throw)', async () => {
    tenantChatCompletion.mockRejectedValue(new Error('OpenAI 500: boom'));
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
  });

  it("provider irraggiungibile (throw) → fallback empty (no throw all'esterno)", async () => {
    tenantChatCompletion.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
  });

  it('🚨 nessun provider configurato → nessun suggerimento, mai un errore mentre si scrive', async () => {
    tenantChatCompletion.mockRejectedValue(new Error('Nessun provider LLM configurato.'));
    const out = await callInlineCompletion(baseReq);
    expect(out).toEqual({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
  });

  it('empty content → empty completion', async () => {
    mockOk('', { input: 10, output: 0 });
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('');
    expect(out.tokensIn).toBe(10);
  });

  it('completion contiene markdown spurio → sanitized', async () => {
    mockOk('Sure! Here is the code:\n```ts\nreturn ctx.input;\n```');
    const out = await callInlineCompletion(baseReq);
    expect(out.completion).toBe('return ctx.input;');
  });

  it('nessun token consumato → tokens 0/0', async () => {
    mockOk('foo', { input: 0, output: 0 });
    const out = await callInlineCompletion(baseReq);
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
  });
});
