/**
 * Test 2026-grade — ai-chat route (6 endpoint + listAllSessionsForSuperadmin).
 *
 * Coverage REALE sqlite :memory: + LLM dispatch + intent detection mocked:
 *  - POST /sessions: zod + auth, INSERT con tenant+user, surface default 'generic'
 *  - GET /sessions: 401, lista user-scoped, filter surface
 *  - GET /sessions/:id/messages: 404 se non tuo, payload session+messages
 *  - POST /sessions/:id/messages:
 *    - 🚨 tenant isolation: 404 se session.user_id != auth.userId
 *    - NoLlmProviderError → 503
 *    - dispatchLLM throw → 502
 *    - history salvata user+assistant, attachments_json se presente
 *    - 🚨 auto-title se title null: prime 60 char con elipsis se truncato
 *    - intent detection eseguita SOLO se enableTools !== false
 *    - URL attachment: fetchUrl injected come extraContext
 *    - document attachment base64 decoded inline
 *  - PATCH /sessions/:id: zod 400 title vuoto, 404 cross-user
 *  - DELETE /sessions/:id: 404 cross-user
 *  - listAllSessionsForSuperadmin: filters tenant+user+surface
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => {
  class NoLlmProviderError extends Error { override name = 'NoLlmProviderError'; }
  return {
    db: null as Database.Database | null,
    NoLlmProviderError,
    resolve: vi.fn(),
    dispatchLLM: vi.fn(),
    detectIntents: vi.fn(),
    executeIntents: vi.fn(),
    formatToolResults: vi.fn(),
    buildCatalog: vi.fn(),
    getRetriever: vi.fn(),
    fetchUrl: vi.fn(),
    webSearch: vi.fn(),
  };
});

// P6: la chat usa il retriever ibrido. Default = THROW → tutti i test storici
// esercitano il FALLBACK compatto (comportamento precedente, zero rotture);
// il path retriever è testato esplicitamente sotto.
vi.mock('@/services/catalog-retrieval/index.js', () => ({
  getCatalogRetriever: (ws: string) => m.getRetriever(ws),
  formatCatalogForPrompt: (
    retriever: { categoryMap: () => { category: string; label: string; count: number }[] },
    retrieved: readonly { defId: string; type: string; category: string; shortDesc: string }[],
  ) => [
    'FAMIGLIE DI NODI DISPONIBILI:',
    ...retriever.categoryMap().map((c) => `  • ${c.category} (${String(c.count)})`),
    'NODI PIÙ PERTINENTI ALLA RICHIESTA:',
    ...retrieved.map((n) => `- ${n.defId} (${n.type})`),
  ].join('\n'),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

vi.mock('@/services/llm-resolver.service.js', () => ({
  NoLlmProviderError: m.NoLlmProviderError,
  llmResolver: { resolve: (t: string) => m.resolve(t) },
}));

vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: (...a: unknown[]) => m.dispatchLLM(...a),
}));

vi.mock('@/services/chat-intent.service.js', () => ({
  detectIntents: (c: string) => m.detectIntents(c),
  executeIntents: (i: unknown) => m.executeIntents(i),
  formatToolResultsForPrompt: (r: unknown) => m.formatToolResults(r),
}));

vi.mock('@/services/ai-scaffold/node-catalog.js', () => ({
  buildNodeCatalog: () => m.buildCatalog(),
}));

vi.mock('../services/web-tools.service.js', () => ({
  fetchUrl: (u: string) => m.fetchUrl(u),
  webSearch: (q: string, l: number) => m.webSearch(q, l),
}));

import { createAiChatRoutes, listAllSessionsForSuperadmin } from './ai-chat.js';
import type { AuthContext } from '@/middleware/auth.js';

function setupSchema(): void {
  m.db!.exec(`
    CREATE TABLE ai_chat_sessions (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, surface TEXT,
      title TEXT, workflow_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
      role TEXT, content TEXT, attachments_json TEXT, tokens INTEGER, model TEXT,
      ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

function insertSession(over: Partial<Record<string, unknown>> = {}): string {
  const id = (over.id as string) ?? `s-${Math.random().toString(36).slice(2, 8)}`;
  m.db!.prepare('INSERT INTO ai_chat_sessions (id, tenant_id, user_id, surface, title, workflow_id) VALUES (?,?,?,?,?,?)').run(
    id, over.tenant_id ?? 't1', over.user_id ?? 'u1', over.surface ?? 'generic',
    over.title ?? null, over.workflow_id ?? null,
  );
  return id;
}

function buildApp(auth: Partial<AuthContext> | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) {
      const full: AuthContext = { userId: 'u1', email: 'e@x', tenantId: 't1', role: 'owner', ...auth } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  app.route('/', createAiChatRoutes());
  return app;
}

beforeEach(() => {
  m.db = new Database(':memory:');
  setupSchema();
  m.resolve.mockReset();
  m.dispatchLLM.mockReset();
  m.detectIntents.mockReset();
  m.executeIntents.mockReset();
  m.formatToolResults.mockReset();
  m.buildCatalog.mockReset();
  m.fetchUrl.mockReset();
  m.webSearch.mockReset();
  m.resolve.mockReturnValue({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: undefined });
  m.dispatchLLM.mockResolvedValue('reply text');
  m.detectIntents.mockReturnValue([]);
  m.buildCatalog.mockReturnValue([{ defId: 'http_request', type: 'action', label: 'HTTP Request' }]);
  // Default: retriever GIÙ → i test storici esercitano il fallback compatto.
  m.getRetriever.mockRejectedValue(new Error('retriever down (test default)'));
});

describe('POST /sessions — create', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('happy path: surface default generic, ritorna 201', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { session: { surface: string; userId: string } };
    expect(body.session.surface).toBe('generic');
    expect(body.session.userId).toBe('u1');
  });

  it('surface + title + workflowId propagati', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'help', title: 'Q1', workflowId: 'wf-1' }),
    });
    const body = await res.json() as { session: { surface: string; title: string; workflowId: string } };
    expect(body.session.surface).toBe('help');
    expect(body.session.title).toBe('Q1');
    expect(body.session.workflowId).toBe('wf-1');
  });
});

describe('GET /sessions — list user-scoped', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/sessions');
    expect(res.status).toBe(401);
  });

  it('🚨 user-scoped: solo sessioni del proprio user', async () => {
    insertSession({ tenant_id: 't1', user_id: 'u1', surface: 'help' });
    insertSession({ tenant_id: 't1', user_id: 'u2', surface: 'help' }); // altro user
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/sessions');
    const body = await res.json() as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });

  it('filter surface=help', async () => {
    insertSession({ tenant_id: 't1', user_id: 'u1', surface: 'help' });
    insertSession({ tenant_id: 't1', user_id: 'u1', surface: 'scaffold' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/sessions?surface=help');
    const body = await res.json() as { sessions: { surface: string }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.surface).toBe('help');
  });

  it('🚨 tenant isolation: tA non vede sessioni tB', async () => {
    insertSession({ tenant_id: 'tB', user_id: 'u1' });
    const res = await buildApp({ userId: 'u1', tenantId: 'tA' }).request('/sessions');
    const body = await res.json() as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(0);
  });
});

describe('GET /sessions/:id/messages', () => {
  it('404 se session non esiste', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/sessions/fake/messages');
    expect(res.status).toBe(404);
  });

  it('🚨 404 se session di altro user (no leak)', async () => {
    const sid = insertSession({ user_id: 'u-other' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`);
    expect(res.status).toBe(404);
  });

  it('happy path: session + messages ordinati id ASC', async () => {
    const sid = insertSession();
    m.db!.prepare(`INSERT INTO ai_chat_messages (session_id, role, content) VALUES (?, 'user', 'hi'), (?, 'assistant', 'hello')`).run(sid, sid);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`);
    const body = await res.json() as { messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe('user');
    expect(body.messages[1]!.role).toBe('assistant');
  });
});

describe('POST /sessions/:id/messages — dispatch', () => {
  it('🚨 NoLlmProviderError → 503', async () => {
    const sid = insertSession();
    m.resolve.mockImplementation(() => { throw new m.NoLlmProviderError('no provider'); });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe('no_provider');
  });

  it('🚨 errore generico resolve → THROW (boundary)', async () => {
    const sid = insertSession();
    m.resolve.mockImplementation(() => { throw new Error('boom'); });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(500);
  });

  it('dispatchLLM throw → 502 dispatch_failed', async () => {
    const sid = insertSession();
    m.dispatchLLM.mockRejectedValue(new Error('rate limit'));
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('dispatch_failed');
  });

  it('happy path: salva user+assistant + auto-title', async () => {
    const sid = insertSession({ title: null });
    m.dispatchLLM.mockResolvedValue('Ciao!');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Domanda test breve' }),
    });
    expect(res.status).toBe(200);
    const msgs = m.db!.prepare('SELECT role, content FROM ai_chat_messages WHERE session_id = ? ORDER BY id ASC').all(sid) as { role: string; content: string }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.content).toBe('Ciao!');
    const session = m.db!.prepare('SELECT title FROM ai_chat_sessions WHERE id = ?').get(sid) as { title: string };
    expect(session.title).toBe('Domanda test breve');
  });

  it('🚨 auto-title truncato a 60 char con elipsis', async () => {
    const sid = insertSession({ title: null });
    const longMsg = 'A'.repeat(100);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: longMsg }),
    });
    const session = m.db!.prepare('SELECT title FROM ai_chat_sessions WHERE id = ?').get(sid) as { title: string };
    expect(session.title).toMatch(/^A{60}…$/u);
  });

  it('title pre-esistente NON sovrascritto da auto-title', async () => {
    const sid = insertSession({ title: 'existing' });
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'new question' }),
    });
    const session = m.db!.prepare('SELECT title FROM ai_chat_sessions WHERE id = ?').get(sid) as { title: string };
    expect(session.title).toBe('existing');
  });

  it('intent detection eseguita se enableTools !== false', async () => {
    const sid = insertSession();
    m.detectIntents.mockReturnValue([{ kind: 'web_search', query: 'foo' }]);
    m.executeIntents.mockResolvedValue([{ ok: true, result: 'res' }]);
    m.formatToolResults.mockReturnValue('CTX result');
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'cerca foo' }),
    });
    expect(m.detectIntents).toHaveBeenCalledWith('cerca foo');
    expect(m.executeIntents).toHaveBeenCalled();
  });

  it('enableTools=false → intent detection NON eseguita', async () => {
    const sid = insertSession();
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'cerca foo', enableTools: false }),
    });
    expect(m.detectIntents).not.toHaveBeenCalled();
  });

  it('attachment url: fetchUrl + extracted text iniettato', async () => {
    const sid = insertSession();
    m.fetchUrl.mockResolvedValue({ finalUrl: 'https://x.com', title: 'X', description: 'X site', content: 'page content' });
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'analizza',
        attachments: [{ kind: 'url', name: 'site', url: 'https://x.com' }],
      }),
    });
    expect(m.fetchUrl).toHaveBeenCalledWith('https://x.com');
    // augmentedUserMessage incluso fetched content nel prompt
    const dispatchArgs = m.dispatchLLM.mock.calls[0]!;
    expect(dispatchArgs[4]).toContain('page content');
  });

  it('attachment url throw → injection error message', async () => {
    const sid = insertSession();
    m.fetchUrl.mockRejectedValue(new Error('DNS resolution failed'));
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'check', attachments: [{ kind: 'url', name: 'fail', url: 'https://broken.com' }],
      }),
    });
    const dispatchArgs = m.dispatchLLM.mock.calls[0]!;
    expect(dispatchArgs[4]).toContain('Errore fetch');
  });

  it('attachment document base64 decoded inline (max 20KB)', async () => {
    const sid = insertSession();
    const docContent = Buffer.from('contenuto documento esteso').toString('base64');
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'analizza doc',
        attachments: [{ kind: 'document', name: 'spec.txt', dataBase64: docContent }],
      }),
    });
    const dispatchArgs = m.dispatchLLM.mock.calls[0]!;
    expect(dispatchArgs[4]).toContain('contenuto documento');
  });

  it('zod 400 content > 50000 char', async () => {
    const sid = insertSession();
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(50001) }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 attachments > 10', async () => {
    const sid = insertSession();
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'x',
        attachments: Array.from({ length: 11 }, (_, i) => ({ kind: 'image', name: `a-${i}` })),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('catalog build throw → graceful (chat continua)', async () => {
    const sid = insertSession();
    m.buildCatalog.mockImplementation(() => { throw new Error('catalog broken'); });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(200);
  });

  /**
   * 🚨 BUG REALE 2026-06-12 — "creami un nodo code": il catalogo iniettato
   * era solo defId|type → il LLM cercava "code" nei defId, matchava
   * agent_code_reviewer ma NON action_run_js ("Run JavaScript") → "il nodo
   * code non esiste" + scaffold di un agent SBAGLIATO. Il fix inietta la
   * LABEL (discoverability semantica) + la riga ALIAS n8n-speak.
   */
  /**
   * P6 — path RETRIEVER (la via primaria): mappa famiglie + top-k pertinenti
   * al MESSAGGIO, non più il catalogo intero. Il retriever è interrogato col
   * contenuto del messaggio utente.
   */
  it('🚨 retriever OK → systemPrompt = famiglie + top-k del MESSAGGIO + alias (niente catalogo intero)', async () => {
    const sid = insertSession();
    const retrieve = vi.fn().mockResolvedValue([
      { defId: 'action_run_js', type: 'action', category: 'utility', shortDesc: 'Esegue JS', score: 1 },
    ]);
    m.getRetriever.mockResolvedValue({
      retrieve,
      categoryMap: () => [{ category: 'utility', label: 'Utility', count: 12 }],
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'creami un nodo code' }),
    });
    expect(res.status).toBe(200);
    // Il retriever è interrogato col MESSAGGIO dell'utente (tenant giusto).
    expect(m.getRetriever).toHaveBeenCalledWith('t1');
    expect(retrieve).toHaveBeenCalledWith('creami un nodo code', { k: 18 });
    const systemPrompt = m.dispatchLLM.mock.calls[0]?.[3] as string;
    expect(systemPrompt).toContain('FAMIGLIE DI NODI DISPONIBILI');
    expect(systemPrompt).toContain('- action_run_js (action)');
    expect(systemPrompt).toContain('"code node"/"nodo code"/"function" → action_run_js');
    // NON deve esserci il dump compatto del catalogo intero (era il pre-P6).
    expect(systemPrompt).not.toContain('http_request|action|HTTP Request');
  });

  it('🚨 il systemPrompt inietta defId|type|LABEL + alias "code node" → action_run_js (FALLBACK retriever giù)', async () => {
    const sid = insertSession();
    m.buildCatalog.mockReturnValue([
      { defId: 'action_run_js', type: 'action', label: 'Run JavaScript' },
      { defId: 'agent_code_reviewer', type: 'agent', label: 'Code Reviewer' },
    ]);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'creami un nodo code' }),
    });
    expect(res.status).toBe(200);
    const systemPrompt = m.dispatchLLM.mock.calls[0]?.[3] as string;
    // La label è nel catalogo iniettato (senza, "Run JavaScript" è invisibile).
    expect(systemPrompt).toContain('action_run_js|action|Run JavaScript');
    // E l'alias esplicito guida il modello sul n8n-speak più frequente.
    expect(systemPrompt).toContain('"code node"/"nodo code"/"function" → action_run_js');
  });
});

describe('PATCH /sessions/:id — rename', () => {
  it('401 con body valido (zod passa, fallisce su auth check)', async () => {
    const res = await buildApp(null).request('/sessions/x', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'valid' }),
    });
    expect(res.status).toBe(401);
  });

  it('zod 400 title vuoto', async () => {
    const sid = insertSession();
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('happy path: title update', async () => {
    const sid = insertSession({ title: 'old' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    });
    expect(res.status).toBe(200);
    const t = (m.db!.prepare('SELECT title FROM ai_chat_sessions WHERE id = ?').get(sid) as { title: string }).title;
    expect(t).toBe('new');
  });

  it('🚨 404 cross-user', async () => {
    const sid = insertSession({ user_id: 'u-other' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /sessions/:id — GDPR delete', () => {
  it('401', async () => {
    const res = await buildApp(null).request('/sessions/x', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('happy path → row sparita', async () => {
    const sid = insertSession();
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const count = (m.db!.prepare('SELECT COUNT(*) AS c FROM ai_chat_sessions WHERE id = ?').get(sid) as { c: number }).c;
    expect(count).toBe(0);
  });

  it('🚨 404 cross-user (no leak)', async () => {
    const sid = insertSession({ user_id: 'u-other' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(`/sessions/${sid}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('listAllSessionsForSuperadmin — admin cross-tenant', () => {
  it('no filter: tutte le sessioni di tutti i tenant', () => {
    insertSession({ tenant_id: 'tA', user_id: 'u1' });
    insertSession({ tenant_id: 'tB', user_id: 'u2' });
    const list = listAllSessionsForSuperadmin({});
    expect(list).toHaveLength(2);
  });

  it('filter tenantId', () => {
    insertSession({ tenant_id: 'tA' });
    insertSession({ tenant_id: 'tB' });
    expect(listAllSessionsForSuperadmin({ tenantId: 'tA' })).toHaveLength(1);
  });

  it('filter userId', () => {
    insertSession({ user_id: 'u1' });
    insertSession({ user_id: 'u2' });
    expect(listAllSessionsForSuperadmin({ userId: 'u1' })).toHaveLength(1);
  });

  it('filter surface', () => {
    insertSession({ surface: 'help' });
    insertSession({ surface: 'scaffold' });
    expect(listAllSessionsForSuperadmin({ surface: 'help' })).toHaveLength(1);
  });
});
