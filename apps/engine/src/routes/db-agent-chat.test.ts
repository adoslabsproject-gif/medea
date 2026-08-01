/**
 * Test in-process della route SSE /db-agent/chat — app Hono reale, auth
 * iniettata, LLM STUBBATO (niente modello reale). Verifica streaming dei passi,
 * isolamento tenant (404 anti-enumeration), auth obbligatoria.
 *
 * @module routes/db-agent-chat.test
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Table } from '@flowforge/db-studio-core';
import type { LlmTurn, LlmTurnResult } from '@/services/db-agent/index.js';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { FLOWFORGE_DATA_DIR: '/tmp/ff-db-agent-route-test' },
    connect: vi.fn(), applyMigration: vi.fn(), query: vi.fn(), insert: vi.fn(), introspect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration(a: unknown) { return mockFns.applyMigration(a); }
    async previewMigration() { return ''; }
    async query(s: unknown) { return mockFns.query(s); }
    async insert(t: string, r: unknown) { return mockFns.insert(t, r); }
    async update() { return {}; }
    async delete() { return {}; }
    async introspect() { return mockFns.introspect(); }
  }
  return { ...mockFns, FakeAdapter };
});
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => m.configValue, liaraBaseUrl: () => 'http://liara.local', isLiaraEnabled: () => true }));
vi.mock('@flowforge/db-studio-engine', () => ({ SqliteAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-redis', () => ({ RedisAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));

// Resolver mockato: ci permette di pilotare il provider risolto per il tenant e
// verificare il ROUTING reale (resolver → provider-registry → adapter → fetch),
// SENZA stub di llmTurn. Il fetch globale viene spiato per leggere url/model/header.
const resolveMock = vi.fn();
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: (...a: unknown[]) => resolveMock(...a) },
  NoLlmProviderError: class NoLlmProviderError extends Error {
    httpStatus: 401 | 402 | 403 = 401;
  },
}));

import { DbStudioService } from '@/services/db-studio.service.js';
import { createDbAgentChatRoutes } from './db-agent-chat.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function seedTable(name = 'orders'): Table {
  return { id: name, name, columns: [{ id: `${name}.id`, name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: true } }], indexes: [] };
}
function makeDb(tenantId: string, name: string): string {
  return new DbStudioService().create({ tenantId, name, description: 's', connection: { engine: 'sqlite', embedded: true }, tables: [seedTable()], relations: [] }).id;
}

/** App con auth iniettata + llmTurn scriptato. */
function buildApp(authCtx: { userId?: string; tenantId: string; role: string }, script: LlmTurnResult[]): Hono {
  const queue = [...script];
  const llmTurn: LlmTurn = () => {
    const next = queue.shift();
    if (!next) throw new Error('script LLM esaurito');
    return Promise.resolve(next);
  };
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx as never); await next(); });
  app.route('/db-agent', createDbAgentChatRoutes({ llmTurnFor: () => llmTurn }));
  return app;
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request('/db-agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) { if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset(); }
  m.connect.mockResolvedValue(undefined);
  m.introspect.mockResolvedValue([seedTable()]);
  m.query.mockResolvedValue([{ id: 1 }]);
});

describe('POST /db-agent/chat', () => {
  it('happy path: SSE con step (tool) + done (messaggio finale)', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    const app = buildApp({ userId: 'u1', tenantId: TENANT_A, role: 'editor' }, [
      { kind: 'tools', toolCalls: [{ id: 'c1', name: 'list_databases', args: {} }] },
      { kind: 'final', text: 'Ecco i tuoi database.' },
    ]);
    const res = await post(app, { databaseId: dbA, userMessage: 'che db ho?' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: step');
    expect(text).toContain('list_databases');
    expect(text).toContain('event: done');
    expect(text).toContain('Ecco i tuoi database.');
  });

  it('🚨 401 senza auth.userId', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    const app = buildApp({ tenantId: TENANT_A, role: 'editor' }, [{ kind: 'final', text: 'x' }]);
    const res = await post(app, { databaseId: dbA, userMessage: 'ciao' });
    expect(res.status).toBe(401);
  });

  it('🚨 404 su DB di un altro tenant (anti-enumeration), LLM mai invocato', async () => {
    const dbB = makeDb(TENANT_B, 'secret');
    let llmCalled = false;
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { userId: 'u1', tenantId: TENANT_A, role: 'editor' } as never); await next(); });
    app.route('/db-agent', createDbAgentChatRoutes({ llmTurnFor: () => () => { llmCalled = true; return Promise.resolve({ kind: 'final', text: 'x' }); } }));
    const res = await post(app, { databaseId: dbB, userMessage: 'leggi il db altrui' });
    expect(res.status).toBe(404);
    expect(llmCalled).toBe(false);
  });

  it('validazione: userMessage vuoto → 400', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    const app = buildApp({ userId: 'u1', tenantId: TENANT_A, role: 'editor' }, [{ kind: 'final', text: 'x' }]);
    const res = await post(app, { databaseId: dbA, userMessage: '' });
    expect(res.status).toBe(400);
  });

  it('🌐 modalità GLOBALE: senza databaseId → 200, niente 404, Liara può list/create', async () => {
    makeDb(TENANT_A, 'crm'); // un DB esiste nel workspace
    const app = buildApp({ userId: 'u1', tenantId: TENANT_A, role: 'editor' }, [
      { kind: 'tools', toolCalls: [{ id: 'c1', name: 'list_databases', args: {} }] },
      { kind: 'final', text: 'Hai 1 database: crm.' },
    ]);
    const res = await post(app, { userMessage: 'che database ho?' }); // NESSUN databaseId
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('list_databases');
    expect(text).toContain('event: done');
    expect(text).toContain('Hai 1 database: crm.');
  });

  it('🌐 modalità GLOBALE a workspace VUOTO → funziona (Liara crea il primo DB)', async () => {
    const app = buildApp({ userId: 'u1', tenantId: 'tenant-empty', role: 'editor' }, [
      { kind: 'tools', toolCalls: [{ id: 'c1', name: 'create_database', args: { name: 'nuovo' } }] },
      { kind: 'final', text: 'Database "nuovo" creato.' },
    ]);
    const res = await post(app, { userMessage: 'creami un database chiamato nuovo' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('create_database');
    expect(text).toContain('event: done');
  });

  it('🚨 modalità DATABASE: databaseId presente ma inesistente → 404 (anti-enum invariato)', async () => {
    const app = buildApp({ userId: 'u1', tenantId: TENANT_A, role: 'editor' }, [{ kind: 'final', text: 'x' }]);
    const res = await post(app, { databaseId: 'does-not-exist', userMessage: 'ciao' });
    expect(res.status).toBe(404);
  });

  it('un tool che fallisce (cross-tenant nel mezzo) → step ok:false ri-alimentato, done comunque', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    const dbB = makeDb(TENANT_B, 'secret');
    const app = buildApp({ userId: 'u1', tenantId: TENANT_A, role: 'editor' }, [
      { kind: 'tools', toolCalls: [{ id: 'c1', name: 'read_db_schema', args: { databaseId: dbB } }] },
      { kind: 'final', text: 'Non accessibile.' },
    ]);
    const res = await post(app, { databaseId: dbA, userMessage: 'leggi B' });
    const text = await res.text();
    expect(text).toContain('TENANT_SCOPE');
    expect(text).toContain('event: done');
  });
});

/**
 * ROUTING REALE provider → endpoint, via UNICA fonte (provider-registry).
 * Niente stub di llmTurn: il loop chiama il fetch globale, che spiamo. Prova che
 * i provider esterni (gemini/grok/deepseek/openrouter…) ORA sono instradati
 * correttamente nel tool-calling, dove prima finivano tutti su Liara.
 */
describe('POST /db-agent/chat — routing provider (provider-registry SSOT)', () => {
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  /** App che usa il ramo resolver reale (nessun llmTurnFor). */
  function liveApp(): Hono {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { userId: 'u1', tenantId: TENANT_A, role: 'editor' } as never); await next(); });
    app.route('/db-agent', createDbAgentChatRoutes());
    return app;
  }
  /** Risposta LLM "final" (nessun tool) → il loop termina dopo 1 fetch. */
  function finalOnce(): void {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'fatto' } }] }) });
  }
  function firstCall(): { url: string; headers: Record<string, string>; body: { model?: string } } {
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, headers: opts.headers as Record<string, string>, body: JSON.parse(opts.body as string) as { model?: string } };
  }

  beforeEach(() => { globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch; fetchMock.mockReset(); resolveMock.mockReset(); });
  afterAll(() => { globalThis.fetch = realFetch; });

  it('grok → POST https://api.x.ai/... + model default grok-2-latest + Bearer key', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'grok', apiKey: 'xai-123', model: '' });
    finalOnce();
    const res = await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    expect(res.status).toBe(200);
    const call = firstCall();
    expect(call.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(call.body.model).toBe('grok-2-latest');
    expect(call.headers.Authorization).toBe('Bearer xai-123');
  });

  it('deepseek → api.deepseek.com + deepseek-chat (prima finiva su Liara: BUG fixato)', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'deepseek', apiKey: 'ds-key', model: '' });
    finalOnce();
    await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    const call = firstCall();
    expect(call.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.body.model).toBe('deepseek-chat');
  });

  it('gemini → endpoint OpenAI-compat di Google (tool-calling), NON generateContent', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'gemini', apiKey: 'AIza-x', model: '' });
    finalOnce();
    await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    const call = firstCall();
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(call.url).not.toContain('generateContent');
    expect(call.headers.Authorization).toBe('Bearer AIza-x');
  });

  it('openrouter → attribution headers X-Title/HTTP-Referer + model esplicito passato', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'openrouter', apiKey: 'or-key', model: 'openai/gpt-4o' });
    finalOnce();
    await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    const call = firstCall();
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers['X-Title']).toBe('FlowForge');
    expect(call.body.model).toBe('openai/gpt-4o');
  });

  it('🚨 liara → gateway portal + LICENSE KEY come Bearer (il gateway la ESIGE; apiKey tenant vuota)', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    const prev = process.env.FLOWFORGE_LICENSE_KEY;
    process.env.FLOWFORGE_LICENSE_KEY = 'LIC-xyz';
    try {
      resolveMock.mockReturnValue({ provider: 'liara', apiKey: '', model: '' });
      finalOnce();
      await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
      const call = firstCall();
      expect(call.url).toBe('http://liara.local/chat/completions');
      expect(call.headers.Authorization).toBe('Bearer LIC-xyz'); // non più assente: era il bug del 400
    } finally {
      if (prev === undefined) delete process.env.FLOWFORGE_LICENSE_KEY; else process.env.FLOWFORGE_LICENSE_KEY = prev;
    }
  });

  it('🚨 anthropic → 400 PRIMA di qualsiasi fetch (non tool-compat, niente instradamento errato)', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'anthropic', apiKey: 'sk-ant', model: '' });
    const res = await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/tool-calling/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🚨 provider a pagamento senza key → 401, nessun fetch', async () => {
    const dbA = makeDb(TENANT_A, 'app');
    resolveMock.mockReturnValue({ provider: 'openai', apiKey: '', model: '' });
    const res = await post(liveApp(), { databaseId: dbA, userMessage: 'ciao' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
