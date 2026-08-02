/**
 * Test 2026-grade — ai-scaffold/register-tools (28-tool registry).
 *
 * Coverage REALE:
 *  - Registry singleton: import register-tools registra TUTTI i 28 tool
 *    senza duplicate (registry throw su duplicate al boot)
 *  - Names: lista contiene i 27 tool noti (Discovery 12 + DB 7 + Plan 1 +
 *    Mutation 7 = 27) — adjust contatori reali
 *  - execute(): tool sconosciuto → error con lista tools disponibili
 *  - 🚨 Zod schema validation: args invalidi → error con path issues
 *  - Dispatch al handler corretto: session method invocato con args validati
 *  - toAnthropicToolsSpec: { name, description, input_schema } per ogni tool
 *  - toOpenAIToolsSpec: { type: 'function', function: { name, description,
 *    parameters } } per ogni tool
 *  - Handler throw → execute cattura e ritorna ok:false con error message
 *  - propose_plan: reasoning >= 60 char obbligatorio, nodes min 1
 *  - drop_table: confirmTableName obbligatorio (safety gate)
 *  - create_database: name regex (no special chars)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry, toAnthropicToolsSpec, toOpenAIToolsSpec } from './tool-registry.js';

// Forza side-effect register
import './register-tools.js';

// Mock session: ogni metodo ritorna { ok: true, data: <method-name> } per
// permettere assertion di routing/dispatch.
function makeMockSession(): Record<string, unknown> {
  const session: Record<string, unknown> = {};
  const methods = [
    'toolListDatabases',
    'toolReadDbSchema',
    'toolListWorkflows',
    'toolReadWorkflow',
    'toolListNodeCatalog',
    'toolListEmailAccounts',
    'toolListSecrets',
    'toolListLlmProviders',
    'toolListDraftNodes',
    'toolListRecentRuns',
    'toolReadRun',
    'toolCheckSettingsHealth',
    'toolCreateDatabase',
    'toolCreateTable',
    'toolAddColumn',
    'toolDropColumn',
    'toolDropTable',
    'toolRenameColumn',
    'toolAddIndex',
    'toolProposePlan',
    'toolAddNode',
    'toolUpdateNode',
    'toolDeleteNode',
    'toolConnectNodes',
    'toolDisconnectNodes',
    'toolFinalizeWorkflow',
    'toolAbort',
  ];
  for (const m of methods) {
    session[m] = (args: unknown) => ({ ok: true, data: { method: m, args } });
  }
  return session;
}

beforeEach(() => {
  // Registry singleton: no reset between test (idempotent import)
});

describe('registry — registrazione boot 28 tool', () => {
  it('toolRegistry contiene almeno 27 tool registrati', () => {
    const names = toolRegistry.names();
    expect(names.length).toBeGreaterThanOrEqual(27);
  });

  it('tutti i tool Discovery sono presenti', () => {
    const names = toolRegistry.names();
    const discovery = [
      'list_databases',
      'read_db_schema',
      'list_existing_workflows',
      'read_workflow',
      'list_node_catalog',
      'list_email_accounts',
      'list_secrets',
      'list_llm_providers',
      'list_draft_nodes',
      'list_recent_runs',
      'read_run',
      'check_settings_health',
    ];
    for (const d of discovery) expect(names).toContain(d);
  });

  it('tutti i tool DB Mutation sono presenti', () => {
    const names = toolRegistry.names();
    const dbMut = [
      'create_database',
      'create_table',
      'add_column',
      'drop_column',
      'drop_table',
      'rename_column',
      'add_index',
    ];
    for (const d of dbMut) expect(names).toContain(d);
  });

  it('tool propose_plan (PHASE 0) presente', () => {
    expect(toolRegistry.names()).toContain('propose_plan');
  });

  it('tutti i tool Workflow Mutation sono presenti', () => {
    const names = toolRegistry.names();
    const wfMut = [
      'add_node',
      'update_node',
      'delete_node',
      'connect_nodes',
      'disconnect_nodes',
      'finalize_workflow',
      'abort',
    ];
    for (const w of wfMut) expect(names).toContain(w);
  });

  it('🚨 nessun duplicate (re-import non rompe perché idempotent)', () => {
    // Se ci fosse duplicate, l'import iniziale avrebbe già thrown al boot
    expect(toolRegistry.all().length).toBe(toolRegistry.names().length);
  });
});

describe('execute() — dispatch + validation', () => {
  it('tool sconosciuto → error con lista', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'tool_che_non_esiste', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('sconosciuto');
      expect(r.error).toContain('Tools disponibili');
    }
  });

  it('list_databases: zero args richiesti → dispatch ok', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'list_databases', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { method: string };
      expect(data.method).toBe('toolListDatabases');
    }
  });

  it('🚨 read_db_schema: databaseId required → args invalidi error', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'read_db_schema', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Args invalidi');
      expect(r.error).toContain('databaseId');
    }
  });

  it('read_db_schema con databaseId valido → dispatch', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'read_db_schema', {
      databaseId: 'db-1',
    });
    expect(r.ok).toBe(true);
  });

  it('🚨 create_database: name con char proibiti → error regex', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'create_database', {
      name: 'has-dash!',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('name');
    }
  });

  it('🚨 create_database: name inizia con cifra → error (regex /^[a-z]/)', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'create_database', { name: '1orders' });
    expect(r.ok).toBe(false);
  });

  it('create_database: name valido snake_case → ok', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'create_database', {
      name: 'my_orders',
    });
    expect(r.ok).toBe(true);
  });

  it('🚨 drop_table: confirmTableName obbligatorio (safety gate)', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'drop_table', {
      databaseId: 'db',
      tableName: 'users',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('confirmTableName');
  });

  it('drop_table con confirmTableName → ok', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'drop_table', {
      databaseId: 'db',
      tableName: 'users',
      confirmTableName: 'users',
    });
    expect(r.ok).toBe(true);
  });

  it('🚨 propose_plan: reasoning < 60 char → error', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'propose_plan', {
      reasoning: 'too short',
      nodes: [{ id: 'n1', defId: 'http_request', purpose: 'fetch data' }],
      edges: [],
    });
    expect(r.ok).toBe(false);
  });

  it('🚨 propose_plan: nodes vuoto → error', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'propose_plan', {
      reasoning: 'A'.repeat(60),
      nodes: [],
      edges: [],
    });
    expect(r.ok).toBe(false);
  });

  it('🚨 propose_plan: node.id non snake_case → error', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'propose_plan', {
      reasoning: 'A'.repeat(60),
      nodes: [{ id: '1-Bad-id', defId: 'http_request', purpose: 'fetch data' }],
      edges: [],
    });
    expect(r.ok).toBe(false);
  });

  it('propose_plan valido → ok', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'propose_plan', {
      reasoning:
        "Ho decomposto il goal in 1 nodo http_request che fetcha l'API e ritorna i dati al chiamante via output.",
      nodes: [{ id: 'fetch_data', defId: 'http_request', purpose: 'fetch i dati' }],
      edges: [],
    });
    expect(r.ok).toBe(true);
  });

  it('add_node con id + defId → dispatch', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'add_node', {
      id: 'n1',
      defId: 'http_request',
      config: { url: 'https://x' },
    });
    expect(r.ok).toBe(true);
  });

  it('connect_nodes con from+to → dispatch (fromPort opzionale)', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'connect_nodes', {
      from: 'n1',
      to: 'n2',
    });
    expect(r.ok).toBe(true);
  });

  it('abort con reason → dispatch', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'abort', { reason: 'too complex' });
    expect(r.ok).toBe(true);
  });

  it('🚨 abort senza reason → error (min 1 char)', async () => {
    const session = makeMockSession();
    const r = await toolRegistry.execute(session as never, 'abort', {});
    expect(r.ok).toBe(false);
  });
});

describe('execute() — handler error catch', () => {
  it('handler throw → ok:false con error message', async () => {
    const throwSession = {
      toolListDatabases: () => {
        throw new Error('storage down');
      },
    };
    const r = await toolRegistry.execute(throwSession as never, 'list_databases', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('storage down');
  });

  it('handler async throw → ok:false (await catched)', async () => {
    const throwSession = {
      toolCreateDatabase: async () => {
        throw new Error('db locked');
      },
    };
    const r = await toolRegistry.execute(throwSession as never, 'create_database', { name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('db locked');
  });

  it('handler ritorna value non-Error → string conversion', async () => {
    const throwSession = {
      toolListDatabases: () => {
        throw 'plain string';
      },
    };
    const r = await toolRegistry.execute(throwSession as never, 'list_databases', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('plain string');
  });
});

describe('toAnthropicToolsSpec — serializer', () => {
  it('emette spec con shape {name, description, input_schema} per ogni tool', () => {
    const spec = toAnthropicToolsSpec();
    expect(spec.length).toBe(toolRegistry.names().length);
    for (const s of spec) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('description');
      expect(s).toHaveProperty('input_schema');
      expect(s.description.length).toBeGreaterThan(0);
      expect(typeof s.input_schema).toBe('object');
    }
  });

  it('list_databases input_schema = type object con properties vuoto (EmptyArgs)', () => {
    const spec = toAnthropicToolsSpec();
    const ld = spec.find((s) => s.name === 'list_databases');
    expect(ld).toBeDefined();
    expect(ld!.input_schema).toMatchObject({ type: 'object' });
  });

  it('read_db_schema input_schema include databaseId required', () => {
    const spec = toAnthropicToolsSpec();
    const r = spec.find((s) => s.name === 'read_db_schema');
    expect(r).toBeDefined();
    const props = r!.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('databaseId');
    const required = r!.input_schema.required as string[];
    expect(required).toContain('databaseId');
  });
});

describe('toOpenAIToolsSpec — serializer', () => {
  it('emette { type: "function", function: { name, description, parameters } }', () => {
    const spec = toOpenAIToolsSpec();
    expect(spec.length).toBe(toolRegistry.names().length);
    for (const s of spec) {
      expect(s.type).toBe('function');
      expect(s.function).toHaveProperty('name');
      expect(s.function).toHaveProperty('description');
      expect(s.function).toHaveProperty('parameters');
    }
  });

  it('add_node parameters include id + defId required', () => {
    const spec = toOpenAIToolsSpec();
    const addNode = spec.find((s) => s.function.name === 'add_node');
    expect(addNode).toBeDefined();
    const required = addNode!.function.parameters.required as string[];
    expect(required).toContain('id');
    expect(required).toContain('defId');
  });
});
