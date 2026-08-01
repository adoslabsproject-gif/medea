/**
 * Test 2026-grade — AI Scaffold discovery tools (read-only, tenant-scoped).
 *
 * SECRECY: list_secrets ritorna SOLO names, valori MAI esposti.
 * LLM PROVIDER: isDefault flag agent-grade per agent_* wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildNodeCatalogMock = vi.fn();
vi.mock('@/services/ai-scaffold/node-catalog.js', () => ({
  buildNodeCatalog: buildNodeCatalogMock,
}));

const wfListMock = vi.fn();
const wfGetMock = vi.fn();
class WorkflowServiceMock {
  list = wfListMock;
  get = wfGetMock;
}
vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: WorkflowServiceMock }));

const emailListMock = vi.fn((): unknown[] => []);
class SystemEmailAccountsServiceMock { list = emailListMock; }
vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: SystemEmailAccountsServiceMock,
}));

const credListMock = vi.fn((): unknown[] => []);
class CredentialsServiceMock { list = credListMock; }
vi.mock('@/services/credentials.service.js', () => ({
  CredentialsService: CredentialsServiceMock,
}));

const llmListMock = vi.fn((): unknown[] => []);
class LlmProvidersServiceMock { list = llmListMock; }
vi.mock('@/services/llm-providers.service.js', () => ({
  LlmProvidersService: LlmProvidersServiceMock,
}));

const resolveDefaultProviderMock = vi.fn();
vi.mock('@/services/tenant-ai-preferences.service.js', () => ({
  tenantAiPreferences: { resolveDefaultProvider: resolveDefaultProviderMock },
}));

const dbStudioListMock = vi.fn();
const baseSession: any = {
  tenantId: 't-1',
  dbStudio: { list: dbStudioListMock },
  draft: { nodes: [], edges: [] },
};

const {
  listDatabasesHandler, readDbSchemaHandler, listWorkflowsHandler,
  readWorkflowHandler, listNodeCatalogHandler, listEmailAccountsHandler,
  listSecretsHandler, listLlmProvidersHandler, listDraftNodesHandler,
} = await import('./discovery.js');

beforeEach(() => { vi.clearAllMocks(); });

describe('🚨 listDatabasesHandler', () => {
  it('🚨 happy: dbs mapped + tableCount', () => {
    dbStudioListMock.mockReturnValueOnce([
      { id: 'db-1', name: 'CRM', connection: { engine: 'postgres' }, tables: [{}, {}] },
      { id: 'db-2', name: 'Vector', tables: [] },
    ]);
    const r = listDatabasesHandler(baseSession);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as any[];
    expect(d[0]).toEqual({ id: 'db-1', name: 'CRM', engine: 'postgres', tableCount: 2 });
    expect(d[1].engine).toBe('sqlite'); // default
  });
});

describe('🚨 readDbSchemaHandler', () => {
  it('🚨 db not found → error con lista disponibili', () => {
    dbStudioListMock.mockReturnValueOnce([{ id: 'db-a' }]);
    const r = readDbSchemaHandler(baseSession, { databaseId: 'db-no' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/non trovato/u);
    expect(r.error).toContain('db-a');
  });

  it('🚨 happy: tables + columns flatten', () => {
    dbStudioListMock.mockReturnValueOnce([{
      id: 'db', name: 'X', tables: [
        { name: 'users', columns: [
          { name: 'id', type: 'INT', constraints: { primaryKey: true, nullable: false } },
          { name: 'email', type: 'TEXT' },
        ] },
      ],
    }]);
    const r = readDbSchemaHandler(baseSession, { databaseId: 'db' });
    if (!r.ok) return;
    const d = r.data as any;
    expect(d.tables[0].columns[0]).toEqual({ name: 'id', type: 'INT', primaryKey: true, nullable: false });
    expect(d.tables[0].columns[1].nullable).toBe(true); // default true se non false
  });
});

describe('🚨 listWorkflowsHandler', () => {
  it('🚨 limit 30 + tenant scoped', async () => {
    const wf50 = Array.from({ length: 50 }, (_, i) => ({
      id: `wf-${i}`, name: `WF ${i}`, description: '', enabled: true, nodes: [], updatedAt: '2026-06-07',
    }));
    wfListMock.mockResolvedValueOnce(wf50);
    const r = await listWorkflowsHandler(baseSession);
    if (!r.ok) return;
    expect((r.data as any[]).length).toBe(30);
    expect(wfListMock).toHaveBeenCalledWith('t-1');
  });
});

describe('🚨 readWorkflowHandler', () => {
  it('🚨 workflowId mancante → error', async () => {
    expect((await readWorkflowHandler(baseSession, {})).ok).toBe(false);
  });

  it('🚨 wf not found → error', async () => {
    wfGetMock.mockResolvedValueOnce(null);
    const r = await readWorkflowHandler(baseSession, { workflowId: 'no-such' });
    expect(r.ok).toBe(false);
  });

  it('🚨 happy: full nodes+edges returned', async () => {
    wfGetMock.mockResolvedValueOnce({
      id: 'wf-1', name: 'WF', description: 'd', enabled: true,
      nodes: [{ id: 'n1', defId: 'x', config: {} }],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    const r = await readWorkflowHandler(baseSession, { workflowId: 'wf-1' });
    if (!r.ok) return;
    expect((r.data as any).nodes.length).toBe(1);
    expect((r.data as any).edges.length).toBe(1);
  });
});

describe('🚨 listNodeCatalogHandler', () => {
  it('🚨 default: brief list', () => {
    buildNodeCatalogMock.mockReturnValueOnce([
      { defId: 'a', type: 'action', label: 'A', description: 'd', fields: [{}] },
      { defId: 't', type: 'trigger', label: 'T', description: 'd', fields: [] },
    ]);
    const r = listNodeCatalogHandler(baseSession, {});
    if (!r.ok) return;
    expect((r.data as any[]).length).toBe(2);
    expect((r.data as any[])[0].fieldCount).toBe(1);
  });

  it('🚨 type filter', () => {
    buildNodeCatalogMock.mockReturnValueOnce([
      { defId: 'a', type: 'action', label: 'A', description: 'd', fields: [] },
      { defId: 't', type: 'trigger', label: 'T', description: 'd', fields: [] },
    ]);
    const r = listNodeCatalogHandler(baseSession, { type: 'trigger' });
    if (!r.ok) return;
    expect((r.data as any[]).length).toBe(1);
    expect((r.data as any[])[0].defId).toBe('t');
  });

  it('🚨 defId specifico → full entry', () => {
    buildNodeCatalogMock.mockReturnValueOnce([
      { defId: 'action_http', type: 'action', label: 'HTTP', description: 'd', fields: [{ key: 'url' }] },
    ]);
    const r = listNodeCatalogHandler(baseSession, { defId: 'action_http' });
    if (!r.ok) return;
    expect((r.data as any).fields).toEqual([{ key: 'url' }]);
  });

  it('🚨 defId inesistente → error', () => {
    buildNodeCatalogMock.mockReturnValueOnce([]);
    expect(listNodeCatalogHandler(baseSession, { defId: 'no' }).ok).toBe(false);
  });
});

describe('🚨 listSecretsHandler — NO values exposed', () => {
  it('🚨 ritorna SOLO names + usage hint', () => {
    credListMock.mockReturnValueOnce([{ name: 'api-token' }, { name: 'webhook-sec' }]);
    const r = listSecretsHandler(baseSession);
    if (!r.ok) return;
    const data = r.data as any;
    expect(data.secretNames).toEqual(['api-token', 'webhook-sec']);
    expect(data.usage).toMatch(/non sono mai esposti/u);
    // 🚨 nessun "value" field
    expect(JSON.stringify(data)).not.toMatch(/value/i);
  });
});

describe('🚨 listLlmProvidersHandler — directive', () => {
  it('🚨 provider configured + isDefault flag', () => {
    llmListMock.mockReturnValueOnce([
      { provider: 'anthropic', hasKey: true, defaultModel: 'claude-3-5' },
      { provider: 'openai', hasKey: true, defaultModel: 'gpt-4' },
      { provider: 'mistral', hasKey: false }, // skipped
    ]);
    resolveDefaultProviderMock.mockReturnValueOnce('anthropic');
    const r = listLlmProvidersHandler(baseSession);
    if (!r.ok) return;
    const d = r.data as any[];
    expect(d.length).toBe(2); // mistral filtered
    expect(d.find((p) => p.provider === 'anthropic').isDefault).toBe(true);
    expect(d.find((p) => p.provider === 'openai').isDefault).toBe(false);
    expect(r.meta?.useThisProvider).toBe('anthropic');
    expect(r.meta?.directive).toMatch(/anthropic.*verbatim|exactly/iu);
  });

  it('🚨 no provider configurato + no default → directive surface error', () => {
    llmListMock.mockReturnValueOnce([]);
    resolveDefaultProviderMock.mockReturnValueOnce(null);
    const r = listLlmProvidersHandler(baseSession);
    if (!r.ok) return;
    expect(r.meta?.directive).toMatch(/No LLM provider|do NOT scaffold/iu);
  });
});

describe('🚨 listDraftNodesHandler', () => {
  it('🚨 recovery: ritorna nodes + edges del draft session', () => {
    const session = {
      ...baseSession,
      draft: {
        nodes: [{ id: 'n1', defId: 'http', name: 'My HTTP' }, { id: 'n2', defId: 'cron' }],
        edges: [{ from: 'n1', to: 'n2' }],
      },
    };
    const r = listDraftNodesHandler(session);
    if (!r.ok) return;
    expect((r.data as any).nodes.length).toBe(2);
    expect((r.data as any).nodes[0].name).toBe('My HTTP');
    expect((r.data as any).nodes[1].name).toBeNull();
    expect((r.data as any).edges.length).toBe(1);
  });
});

describe('🚨 listEmailAccountsHandler', () => {
  it('🚨 imap/smtp host extract + isDefault', () => {
    emailListMock.mockReturnValueOnce([
      { id: 'e1', label: 'Primary', fromAddress: 'a@b.it', imap: { host: 'imap' }, smtp: { host: 'smtp' }, isDefault: true },
    ]);
    const r = listEmailAccountsHandler(baseSession);
    if (!r.ok) return;
    expect((r.data as any[])[0]).toMatchObject({
      label: 'Primary', fromAddress: 'a@b.it', imapHost: 'imap', smtpHost: 'smtp', isDefault: true,
    });
  });

  it('🚨 no imap → imapHost null', () => {
    emailListMock.mockReturnValueOnce([
      { id: 'e2', label: 'SMTP-only', fromAddress: 'x@y.it', smtp: { host: 'smtp' }, isDefault: false },
    ]);
    const r = listEmailAccountsHandler(baseSession);
    if (!r.ok) return;
    expect((r.data as any[])[0].imapHost).toBeNull();
  });
});
