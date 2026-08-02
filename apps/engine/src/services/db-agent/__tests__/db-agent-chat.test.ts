/**
 * Test 2026-grade — loop chat agentico del DB-agent (Fetta 2).
 *
 * L'LLM è una dipendenza iniettata e SCRIPTATA (coda di turni): il loop è
 * l'unità sotto test, l'esecuzione dei tool è REALE (executeDbAgentTool su
 * SQLite :memory'). Bug-bounty: tenant nei tool, anti-loop (max iter), tool
 * ignoto/distruttivo gestiti come messaggi al modello, eccezione del modello
 * propagata, ordine/quantità degli step.
 *
 * @module services/db-agent/__tests__/db-agent-chat
 */
import type * as DbStudioEngineNS from '@medea/engine-db-studio-engine';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Table } from '@medea/engine-db-studio-core';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { MEDEA_DATA_DIR: '/tmp/ff-db-agent-chat-test' },
    connect: vi.fn(),
    applyMigration: vi.fn(),
    previewMigration: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    introspect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration(a: unknown) { return mockFns.applyMigration(a); }
    async previewMigration(a: unknown) { return mockFns.previewMigration(a); }
    async query(s: unknown) { return mockFns.query(s); }
    async insert(t: string, r: unknown) { return mockFns.insert(t, r); }
    async update() { return { changes: 0 }; }
    async delete() { return { changes: 0 }; }
    async introspect() { return mockFns.introspect(); }
  }
  return { ...mockFns, FakeAdapter };
});

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => m.configValue }));
vi.mock('@medea/engine-db-studio-engine', async (importOriginal) => {
  const real = await importOriginal<typeof DbStudioEngineNS>();
  return { ...real, SqliteAdapter: m.FakeAdapter };
});
vi.mock('@medea/engine-db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-redis', () => ({ RedisAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));

import { DbStudioService } from '@/services/db-studio.service.js';
import { createDbAgentContext, runDbAgentChat } from '../index.js';
import type { DbAgentContext, LlmTurn, LlmTurnResult, LlmTurnInput } from '../index.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function seedTable(name = 'orders'): Table {
  return { id: name, name, columns: [{ id: `${name}.id`, name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: true } }], indexes: [] };
}
function makeDb(svc: DbStudioService, tenantId: string, name: string, tables: Table[] = []): string {
  return svc.create({ tenantId, name, description: 'seed', connection: { engine: 'sqlite', embedded: true }, tables, relations: [] }).id;
}

/** LLM scriptato: consuma una coda di LlmTurnResult; registra gli input ricevuti. */
function scriptedLlm(script: LlmTurnResult[]): { llmTurn: LlmTurn; inputs: LlmTurnInput[] } {
  const inputs: LlmTurnInput[] = [];
  const queue = [...script];
  const llmTurn: LlmTurn = (input) => {
    inputs.push(input);
    const next = queue.shift();
    if (!next) throw new Error('script LLM esaurito (il loop ha chiesto un turno in più del previsto)');
    return Promise.resolve(next);
  };
  return { llmTurn, inputs };
}

let svc: DbStudioService;
let ctxA: DbAgentContext;
let dbA: string;
const prompt = { schemaContext: 'orders(id)' };

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) {
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset();
  }
  m.connect.mockResolvedValue(undefined);
  m.applyMigration.mockResolvedValue({ sql: '-- ok', affectedTables: ['customers'] });
  m.previewMigration.mockResolvedValue('CREATE TABLE customers (id integer);');
  m.introspect.mockResolvedValue([seedTable()]);
  m.query.mockResolvedValue([{ id: 1 }]);
  svc = new DbStudioService();
  ctxA = createDbAgentContext(TENANT_A, svc);
  dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
});

describe('runDbAgentChat — orchestrazione base', () => {
  it('risposta finale immediata (nessun tool) → message, 1 iterazione, 0 step', async () => {
    const { llmTurn, inputs } = scriptedLlm([{ kind: 'final', text: 'Ciao! Come posso aiutarti col DB?' }]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'ciao', prompt, llmTurn });
    expect(r).toMatchObject({ message: 'Ciao! Come posso aiutarti col DB?', iterations: 1, stoppedReason: 'final' });
    expect(r.steps).toHaveLength(0);
    // il system prompt contiene lo schema + i tool sono passati
    expect(inputs[0]!.system).toContain('orders(id)');
    expect(inputs[0]!.tools.map((t) => t.name)).toContain('create_table');
  });

  it('un tool poi finale: esegue il tool (REALE) e ri-alimenta il risultato al modello', async () => {
    const { llmTurn, inputs } = scriptedLlm([
      { kind: 'tools', toolCalls: [{ id: 'c1', name: 'create_table', args: { databaseId: dbA, name: 'customers', columns: [{ name: 'id', type: 'integer' }] } }] },
      { kind: 'final', text: 'Tabella customers creata.' },
    ]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'crea customers', prompt, llmTurn });
    expect(r.stoppedReason).toBe('final');
    expect(r.iterations).toBe(2);
    expect(r.steps).toEqual([{ tool: 'create_table', ok: true, destructive: false }]);
    expect(m.applyMigration).toHaveBeenCalledTimes(1);
    // Al 2° turno il modello riceve il messaggio role=tool con il risultato.
    const toolMsg = inputs[1]!.messages.find((mm) => mm.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(toolMsg?.content).toContain('"ok":true');
  });

  it('più tool nello stesso turno → eseguiti in ordine, step registrati in ordine', async () => {
    const { llmTurn } = scriptedLlm([
      { kind: 'tools', toolCalls: [
        { id: 'a', name: 'read_db_schema', args: { databaseId: dbA } },
        { id: 'b', name: 'run_select', args: { databaseId: dbA, table: 'orders' } },
      ] },
      { kind: 'final', text: 'fatto' },
    ]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'leggi', prompt, llmTurn });
    expect(r.steps.map((s) => s.tool)).toEqual(['read_db_schema', 'run_select']);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });
});

describe('🚨 sicurezza & robustezza del loop', () => {
  it('tool su DB di altro tenant → step ok:false code TENANT_SCOPE, risultato ri-alimentato (loop non crasha)', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret', [seedTable()]);
    const { llmTurn, inputs } = scriptedLlm([
      { kind: 'tools', toolCalls: [{ id: 'x', name: 'read_db_schema', args: { databaseId: dbB } }] },
      { kind: 'final', text: 'Non riesco ad accedere a quel database.' },
    ]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'leggi il db altrui', prompt, llmTurn });
    expect(r.steps).toEqual([{ tool: 'read_db_schema', ok: false, code: 'TENANT_SCOPE', destructive: false }]);
    const toolMsg = inputs[1]!.messages.find((mm) => mm.role === 'tool');
    expect(toolMsg?.content).toContain('TENANT_SCOPE');
  });

  it('tool distruttivo senza conferma → step ok:false CONFIRMATION_REQUIRED + destructive:true', async () => {
    const { llmTurn } = scriptedLlm([
      { kind: 'tools', toolCalls: [{ id: 'd', name: 'drop_table', args: { databaseId: dbA, tableName: 'orders', confirmTableName: 'nope' } }] },
      { kind: 'final', text: 'Serve conferma.' },
    ]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'cancella orders', prompt, llmTurn });
    expect(r.steps[0]).toEqual({ tool: 'drop_table', ok: false, code: 'CONFIRMATION_REQUIRED', destructive: true });
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('tool inesistente inventato dal modello → UNKNOWN_TOOL, loop prosegue', async () => {
    const { llmTurn } = scriptedLlm([
      { kind: 'tools', toolCalls: [{ id: 'z', name: 'rm_rf', args: {} }] },
      { kind: 'final', text: 'ok' },
    ]);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'fai danni', prompt, llmTurn });
    expect(r.steps[0]).toMatchObject({ tool: 'rm_rf', ok: false, code: 'UNKNOWN_TOOL' });
  });

  it('🔁 anti-loop: un modello che non finalizza MAI si ferma a maxIterations (no loop infinito)', async () => {
    // Coda infinita di richieste tool: ogni turno chiede ancora un tool.
    const llmTurn: LlmTurn = () => Promise.resolve({ kind: 'tools', toolCalls: [{ id: 'i', name: 'list_databases', args: {} }] } as LlmTurnResult);
    const r = await runDbAgentChat({ ctx: ctxA, userMessage: 'gira a vuoto', prompt, llmTurn, maxIterations: 4 });
    expect(r.stoppedReason).toBe('max_iterations');
    expect(r.iterations).toBe(4);
    expect(r.steps).toHaveLength(4); // un tool per iterazione, esattamente maxIterations
  });

  it('eccezione del MODELLO (llmTurn throw) è propagata (guasto infra, non esito tool)', async () => {
    const llmTurn: LlmTurn = () => Promise.reject(new Error('LLM provider 503'));
    await expect(runDbAgentChat({ ctx: ctxA, userMessage: 'x', prompt, llmTurn })).rejects.toThrow('LLM provider 503');
  });

  it('history precedente è inclusa prima del nuovo messaggio utente', async () => {
    const { llmTurn, inputs } = scriptedLlm([{ kind: 'final', text: 'ok' }]);
    await runDbAgentChat({
      ctx: ctxA, userMessage: 'e adesso?', prompt, llmTurn,
      history: [{ role: 'user', content: 'prima domanda' }, { role: 'assistant', content: 'prima risposta' }],
    });
    const roles = inputs[0]!.messages.map((mm) => `${mm.role}:${mm.content}`);
    expect(roles).toEqual(['user:prima domanda', 'assistant:prima risposta', 'user:e adesso?']);
  });
});
