/**
 * Test llm-gateway — routing condiviso verso il GATEWAY PORTAL (no liara:3003).
 *
 * Bug-bounty: base resolution (FLOWFORGE_LIARA_BASE_URL > LLM_API_BASE > fallback),
 * URL /chat/completions, Bearer license, X-FF-Workspace/Feature, stop, model
 * OMESSO di default (gateway inietta) vs override, parse content+usage, non-2xx →
 * {ok:false} (NO throw), errore di rete → throw.
 *
 * @module services/custom-nodes/llm-gateway.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gatewayBaseUrl, gatewayChatCompletions } from './llm-gateway';

const origFetch = globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  process.env.FLOWFORGE_LIARA_BASE_URL = 'http://gw/api/v1/llm';
  process.env.FLOWFORGE_LICENSE_KEY = 'ZFL-X';
  delete process.env.LLM_API_BASE;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

function ok(content: string, usage = { prompt_tokens: 7, completion_tokens: 3 }): Response {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) } as unknown as Response;
}
const req = (over = {}) => ({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, maxTokens: 100, timeoutMs: 5000, workspaceId: 'ws', ...over });

describe('gatewayBaseUrl', () => {
  it('precedenza: FLOWFORGE_LIARA_BASE_URL > LLM_API_BASE > fallback', () => {
    expect(gatewayBaseUrl({ FLOWFORGE_LIARA_BASE_URL: 'http://a', LLM_API_BASE: 'http://b' } as NodeJS.ProcessEnv)).toBe('http://a');
    expect(gatewayBaseUrl({ LLM_API_BASE: 'http://b' } as NodeJS.ProcessEnv)).toBe('http://b');
    expect(gatewayBaseUrl({} as NodeJS.ProcessEnv)).toBe('http://liara:3003');
  });
});

describe('gatewayChatCompletions', () => {
  it('POST a <base>/chat/completions con Bearer license + X-FF-Workspace; model OMESSO', async () => {
    mockFetch.mockResolvedValue(ok('ciao'));
    const r = await gatewayChatCompletions(req({ workspaceId: 'ws-9' }));
    const [url, init] = mockFetch.mock.calls[0]! as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('http://gw/api/v1/llm/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer ZFL-X');
    expect(init.headers['X-FF-Workspace']).toBe('ws-9');
    const body = JSON.parse(init.body);
    expect(body.model).toBeUndefined();        // il gateway inietta UPSTREAM_MODEL
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(100);
    expect(r).toEqual({ ok: true, status: 200, content: 'ciao', usage: { input: 7, output: 3 } });
  });

  it('stop + feature + modelOverride passati quando presenti', async () => {
    mockFetch.mockResolvedValue(ok('x'));
    await gatewayChatCompletions(req({ stop: ['\n\n'], feature: 'inline-completion', modelOverride: 'custom-model' }));
    const init = mockFetch.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
    expect(init.headers['X-FF-Feature']).toBe('inline-completion');
    const body = JSON.parse(init.body);
    expect(body.stop).toEqual(['\n\n']);
    expect(body.model).toBe('custom-model');
  });

  it("modelOverride 'liara' (pseudo-modello) → OMESSO (gateway inietta il reale)", async () => {
    mockFetch.mockResolvedValue(ok('x'));
    await gatewayChatCompletions(req({ modelOverride: 'liara' }));
    expect(JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).model).toBeUndefined();
  });

  it('non-2xx → { ok:false } SENZA throw (il caller decide)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
    const r = await gatewayChatCompletions(req());
    expect(r).toEqual({ ok: false, status: 503, content: '', usage: { input: 0, output: 0 } });
  });

  it('errore di rete (fetch throw) → propaga (il caller fa fallback/500)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(gatewayChatCompletions(req())).rejects.toThrow('ECONNREFUSED');
  });

  it('usage assente → 0/0; content assente → stringa vuota', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [] }) } as unknown as Response);
    const r = await gatewayChatCompletions(req());
    expect(r).toEqual({ ok: true, status: 200, content: '', usage: { input: 0, output: 0 } });
  });
});
