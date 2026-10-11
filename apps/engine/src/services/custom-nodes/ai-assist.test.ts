/**
 * Test REAL — ai-assist.ts (prompt template + markdown patch extractor).
 *
 * Coverage:
 *  - extractPatchFromMarkdown estrae 3 fence (ts:executor, ts:definition, ts:schema)
 *  - extractPatchFromMarkdown ignora fence senza marker
 *  - extractPatchFromMarkdown ritorna undefined su markdown senza fence
 *  - extractPatchFromMarkdown preserva l'ordine e l'integrita\` del codice
 *  - callAiAssist → ritorna text + patch + tokens
 *  - callAiAssist: un errore del provider → throws
 *  - callAiAssist chiede la risposta per il tenant giusto
 *
 * Non testiamo `buildUserPrompt` direttamente (e\` interno) — coverto via callAiAssist mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// L'ai-assist chiede la risposta al provider del tenant tramite `tenant-llm`:
// qui lo si sostituisce, e si guarda cosa gli viene chiesto. Come quella
// richiesta diventa una chiamata HTTP lo verifica `tenant-llm.test.ts`.
const { tenantChatCompletion } = vi.hoisted(() => ({ tenantChatCompletion: vi.fn() }));
vi.mock('./tenant-llm.js', () => ({ tenantChatCompletion }));

import { extractPatchFromMarkdown, callAiAssist } from './ai-assist.js';

beforeEach(() => {
  tenantChatCompletion.mockReset();
});

/** Il provider risponde con questo testo. */
function risponde(content: string, usage = { input: 50, output: 200 }): void {
  tenantChatCompletion.mockResolvedValue({ content, usage, provider: 'openai' });
}

/** Quello che è stato chiesto al provider. */
function chiesto(): {
  messages: { role: string; content: string }[];
  workspaceId: string;
  timeoutMs: number;
  maxTokens: number;
} {
  return tenantChatCompletion.mock.calls[0]![0] as ReturnType<typeof chiesto>;
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
  it('action=generate → provider interpellato + result decomposed', async () => {
    const md =
      '```ts:executor\nconst e = 1;\n```\n```ts:definition\nconst d = 1;\n```\n```ts:schema\nconst s = 1;\n```';
    risponde(md);
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

  it('chiede la risposta per il tenant che ha fatto la richiesta', async () => {
    // Dal tenant si risale al provider e alla chiave: sbagliarlo vorrebbe dire
    // spendere la chiave di un altro.
    risponde('ok');
    await callAiAssist({
      action: 'explain',
      workspaceId: 'ws-special',
      sources: { executor: '', definition: '', schema: '' },
    });
    expect(chiesto().workspaceId).toBe('ws-special');
  });

  it('💬 action=chat: prompt conversazionale (istruzione "applica solo se chiesto" + sorgenti come contesto)', async () => {
    risponde('Ciao! Questo nodo cerca su Slack.');
    await callAiAssist({
      action: 'chat',
      workspaceId: 'ws-1',
      prompt: 'ciao, cosa fa?',
      sources: { executor: 'EXEC_SRC', definition: 'D', schema: 'S' },
    });
    const userMsg = chiesto().messages.at(-1)!.content;
    expect(userMsg).toContain('ciao, cosa fa?');
    expect(userMsg).toContain('EXEC_SRC'); // sorgenti come contesto
    expect(userMsg).toMatch(/conversazional/iu);
    expect(userMsg).toMatch(/SOLO se.*chiede|solo allora/iu); // applica solo su richiesta
  });

  it('💬 chat SENZA codice in risposta → conversazione pura, NESSUNA patch', async () => {
    risponde('Risponde a "ciao" e ritorna un saluto. Vuoi che aggiunga un campo?');
    const res = await callAiAssist({
      action: 'chat',
      workspaceId: 'ws-1',
      prompt: 'spiegami a parole',
    });
    expect(res.text).toContain('saluto');
    expect(res.patch).toBeUndefined(); // niente fence → niente sovrascrittura dei file
  });

  it('💬 chat CON codice (utente ha chiesto la modifica) → patch applicata', async () => {
    const md = ['Ecco la modifica:', '```ts:executor', 'export const executor = 1;', '```'].join(
      '\n',
    );
    risponde(md);
    const res = await callAiAssist({
      action: 'chat',
      workspaceId: 'ws-1',
      prompt: 'aggiungi un campo url',
    });
    expect(res.patch?.executor).toContain('export const executor');
  });

  it('dà al provider quattro minuti e 2048 token: spiegare sorgenti interi è lungo', async () => {
    risponde('ok');
    await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    expect(chiesto().timeoutMs).toBe(240_000);
    expect(chiesto().maxTokens).toBe(2048);
  });

  it('crossSurfaceContext → iniettato come SECONDO system message (l’assistente "ricorda" le altre schede)', async () => {
    risponde('ok');
    await callAiAssist({
      action: 'generate',
      workspaceId: 'ws-1',
      prompt: 'crea un nodo',
      crossSurfaceContext: '[CONTESTO DA ALTRE SCHEDE]\n• Workflow editor: monitoraggio prezzi',
    });
    const sent = chiesto();
    expect(sent.messages[0]!.role).toBe('system'); // SYSTEM_PROMPT
    expect(sent.messages[1]).toEqual({
      role: 'system',
      content: '[CONTESTO DA ALTRE SCHEDE]\n• Workflow editor: monitoraggio prezzi',
    });
    expect(sent.messages[2]!.role).toBe('user');
  });

  it('senza crossSurfaceContext → nessun system message extra (solo SYSTEM_PROMPT + user)', async () => {
    risponde('ok');
    await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    expect(chiesto().messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('un errore del provider → throws, con la sua causa', async () => {
    tenantChatCompletion.mockRejectedValue(new Error('OpenAI 503: down'));
    await expect(callAiAssist({ action: 'explain', workspaceId: 'ws-1' })).rejects.toThrow(/503/u);
  });

  it('🚨 nessun provider configurato → throws col messaggio che dice dove configurarlo', async () => {
    tenantChatCompletion.mockRejectedValue(
      new Error('Nessun provider LLM configurato. Vai in Settings → AI Providers…'),
    );
    await expect(callAiAssist({ action: 'explain', workspaceId: 'ws-1' })).rejects.toThrow(
      /Settings → AI Providers/u,
    );
  });

  it('nessun token consumato → tokens undefined', async () => {
    risponde('no usage', { input: 0, output: 0 });
    const res = await callAiAssist({ action: 'fix', workspaceId: 'ws-1' });
    expect(res.tokens).toBeUndefined();
  });

  it('response senza fence patch → patch undefined ma text presente', async () => {
    risponde('Una semplice spiegazione testuale.');
    const res = await callAiAssist({ action: 'explain', workspaceId: 'ws-1' });
    expect(res.text).toBe('Una semplice spiegazione testuale.');
    expect(res.patch).toBeUndefined();
  });
});
