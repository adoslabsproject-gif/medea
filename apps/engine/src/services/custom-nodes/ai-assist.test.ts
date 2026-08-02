/**
 * Test REAL — ai-assist.ts (prompt template + markdown patch extractor).
 *
 * Coverage:
 *  - extractPatchFromMarkdown estrae 3 fence (ts:executor, ts:definition, ts:schema)
 *  - extractPatchFromMarkdown ignora fence senza marker
 *  - extractPatchFromMarkdown ritorna undefined su markdown senza fence
 *  - extractPatchFromMarkdown preserva l'ordine e l'integrita\` del codice
 *  - callAiAssist con fetch mocked → ritorna text + patch + tokens
 *  - callAiAssist gateway HTTP error → throws
 *  - callAiAssist passa workspace header
 *
 * Non testiamo `buildUserPrompt` direttamente (e\` interno) — coverto via callAiAssist mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { extractPatchFromMarkdown, callAiAssist } from './ai-assist.js';

// Il node ai-assist passa dal GATEWAY PORTAL via fetch RAW (come il workflow
// chat). Mockiamo global fetch per evitare HTTP reale.
const mockFetch = vi.fn();
const origFetch = globalThis.fetch;

beforeEach(() => {
  mockFetch.mockReset();
  process.env.MEDEA_LIARA_BASE_URL = 'http://gw/api/v1/llm';
  process.env.MEDEA_LICENSE_KEY = 'ZFL-TEST';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = origFetch; vi.clearAllMocks(); });

function mockGatewayResponse(content: string, ok = true): Response {
  const body = {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 200 },
  };
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('extractPatchFromMarkdown', () => {
  it('estrae 3 fence ts:executor / ts:definition / ts:schema', () => {
    const md = `Ecco il nodo.

\`\`\`ts:executor
export const executor = async () => ({ ok: true });
\`\`\`

\`\`\`ts:definition
export const definition = { defId: 'x' };
\`\`\`

\`\`\`ts:schema
export const schema = {};
\`\`\``;
    const patch = extractPatchFromMarkdown(md);
    expect(patch).toBeDefined();
    expect(patch!.executor).toContain('export const executor');
    expect(patch!.definition).toContain('defId');
    expect(patch!.schema).toContain('export const schema');
  });

  it('ignora fence generici senza marker (ts senza :file)', () => {
    const md = '```ts\nconst x = 1;\n```';
    expect(extractPatchFromMarkdown(md)).toBeUndefined();
  });

  it('markdown senza fence → undefined', () => {
    expect(extractPatchFromMarkdown('Solo testo, nessun codice.')).toBeUndefined();
  });

  it('estrae solo il file specificato (parziale)', () => {
    const md = '```ts:executor\nconst a = 1;\n```\nE basta.';
    const patch = extractPatchFromMarkdown(md);
    expect(patch?.executor).toBe('const a = 1;');
    expect(patch?.definition).toBeUndefined();
    expect(patch?.schema).toBeUndefined();
  });
});

describe('callAiAssist', () => {
  it('action=generate → fetch chiamato + result decomposed', async () => {
    const md = '```ts:executor\nconst e = 1;\n```\n```ts:definition\nconst d = 1;\n```\n```ts:schema\nconst s = 1;\n```';
    mockFetch.mockResolvedValue(mockGatewayResponse(md));
    const res = await callAiAssist({
      action: 'generate',
      prompt: 'Voglio un nodo che fa cose',
      workspaceId: 'ws-1',
    });
    expect(res.text).toBe(md);
    expect(res.patch?.executor).toContain('const e = 1');
    expect(res.tokens?.input).toBe(50);
    expect(res.tokens?.output).toBe(200);
  });

  it('passa workspaceId come header X-FF-Workspace', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('ok'));
    await callAiAssist({ action: 'explain', workspaceId: 'ws-special', sources: { executor: '', definition: '', schema: '' } });
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as { headers?: Record<string, string> };
    expect(init.headers?.['X-FF-Workspace']).toBe('ws-special');
  });

  it('💬 action=chat: prompt conversazionale (istruzione "applica solo se chiesto" + sorgenti come contesto)', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('Ciao! Questo nodo cerca su Slack.'));
    await callAiAssist({ action: 'chat', workspaceId: 'ws-1', prompt: 'ciao, cosa fa?', sources: { executor: 'EXEC_SRC', definition: 'D', schema: 'S' } });
    const userMsg = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body).messages.at(-1).content as string;
    expect(userMsg).toContain('ciao, cosa fa?');
    expect(userMsg).toContain('EXEC_SRC');           // sorgenti come contesto
    expect(userMsg).toMatch(/conversazional/iu);
    expect(userMsg).toMatch(/SOLO se.*chiede|solo allora/iu); // applica solo su richiesta
  });

  it('💬 chat SENZA codice in risposta → conversazione pura, NESSUNA patch', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('Risponde a "ciao" e ritorna un saluto. Vuoi che aggiunga un campo?'));
    const res = await callAiAssist({ action: 'chat', workspaceId: 'ws-1', prompt: 'spiegami a parole' });
    expect(res.text).toContain('saluto');
    expect(res.patch).toBeUndefined(); // niente fence → niente sovrascrittura dei file
  });

  it('💬 chat CON codice (utente ha chiesto la modifica) → patch applicata', async () => {
    const md = ['Ecco la modifica:', '```ts:executor', 'export const executor = 1;', '```'].join('\n');
    mockFetch.mockResolvedValue(mockGatewayResponse(md));
    const res = await callAiAssist({ action: 'chat', workspaceId: 'ws-1', prompt: 'aggiungi un campo url' });
    expect(res.patch?.executor).toContain('export const executor');
  });

  it('🔌 routing GATEWAY PORTAL: URL /chat/completions + Bearer license + model OMESSO (gateway inietta)', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('ok'));
    await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    const [url, init] = mockFetch.mock.calls[0]! as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('http://gw/api/v1/llm/chat/completions'); // gateway, NON liara:3003/v1
    expect(init.headers.Authorization).toBe('Bearer ZFL-TEST');
    expect(JSON.parse(init.body).model).toBeUndefined(); // gateway inietta UPSTREAM_MODEL
  });

  it('crossSurfaceContext → iniettato come SECONDO system message (Liara "ricorda" le altre schede)', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('ok'));
    await callAiAssist({
      action: 'generate', workspaceId: 'ws-1', prompt: 'crea un nodo',
      crossSurfaceContext: '[CONTESTO DA ALTRE SCHEDE]\n• Workflow editor: monitoraggio prezzi',
    });
    const init = mockFetch.mock.calls[0]![1] as { body: string };
    const sent = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0]!.role).toBe('system'); // SYSTEM_PROMPT
    expect(sent.messages[1]).toEqual({ role: 'system', content: '[CONTESTO DA ALTRE SCHEDE]\n• Workflow editor: monitoraggio prezzi' });
    expect(sent.messages[2]!.role).toBe('user');
  });

  it('senza crossSurfaceContext → nessun system message extra (solo SYSTEM_PROMPT + user)', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('ok'));
    await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    const init = mockFetch.mock.calls[0]![1] as { body: string };
    const sent = JSON.parse(init.body) as { messages: { role: string }[] };
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('HTTP error gateway → throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('gateway down'),
      json: () => Promise.resolve({}),
    } as unknown as Response);
    await expect(callAiAssist({ action: 'explain', workspaceId: 'ws-1' }))
      .rejects.toThrow(/503/u);
  });

  it('response senza usage → tokens undefined', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'no usage' } }] }),
      text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: 'no usage' } }] })),
    } as unknown as Response);
    const res = await callAiAssist({ action: 'fix', workspaceId: 'ws-1' });
    expect(res.tokens).toBeUndefined();
  });

  it('response senza fence patch → patch undefined ma text presente', async () => {
    mockFetch.mockResolvedValue(mockGatewayResponse('Una semplice spiegazione testuale.'));
    const res = await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    expect(res.text).toBe('Una semplice spiegazione testuale.');
    expect(res.patch).toBeUndefined();
  });
});
