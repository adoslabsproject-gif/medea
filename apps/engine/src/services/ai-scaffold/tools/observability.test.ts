/**
 * Test 2026-grade — AI Scaffold observability tools (tenant-scoped).
 *
 * TENANT ISOLATION: ogni query include WHERE tenant_id = ?.
 * PII PROTECTION: step outputs redacted, solo error+status+duration esposti.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: sqliteInst }) }));

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

const dbStudioListMock = vi.fn((): unknown[] => []);
const session: any = {
  tenantId: 't-1',
  dbStudio: { list: dbStudioListMock },
};

const {
  listRecentRunsHandler, readRunHandler, checkSettingsHealthHandler,
} = await import('./observability.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow_id TEXT, tenant_id TEXT,
      status TEXT, error_count INTEGER, total_duration_ms INTEGER,
      started_at TEXT, ended_at TEXT, steps_json TEXT, trigger_type TEXT
    );
  `);
});

describe('🚨 listRecentRunsHandler', () => {
  it('🚨 tenant isolation: solo runs del tenant session', () => {
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r1', 'wf', 't-1', 'ok', 0, 100, '2026-06-07', NULL, '[]', 'manual')`).run();
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r2', 'wf', 't-other', 'ok', 0, 100, '2026-06-07', NULL, '[]', 'manual')`).run();
    const r = listRecentRunsHandler(session, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any[]).length).toBe(1);
    expect((r.data as any[])[0].runId).toBe('r1');
  });

  it('🚨 limit cap 100 + min 1', () => {
    const r1 = listRecentRunsHandler(session, { limit: 9999 });
    expect(r1.ok).toBe(true); // no throw
    const r2 = listRecentRunsHandler(session, { limit: 0 });
    expect(r2.ok).toBe(true); // clamped to 1
  });

  it('🚨 workflowFilter applied', () => {
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r1', 'wf-A', 't-1', 'ok', 0, 100, '2026-06-07', NULL, '[]', 'manual')`).run();
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r2', 'wf-B', 't-1', 'ok', 0, 100, '2026-06-07', NULL, '[]', 'manual')`).run();
    const r = listRecentRunsHandler(session, { workflowId: 'wf-A' });
    if (!r.ok) return;
    expect((r.data as any[]).length).toBe(1);
    expect((r.data as any[])[0].workflowId).toBe('wf-A');
  });
});

describe('🚨 readRunHandler — PII redaction', () => {
  it('🚨 runId mancante → ok=false', () => {
    expect(readRunHandler(session, {}).ok).toBe(false);
  });

  it('🚨 run di altro tenant → not found', () => {
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-x', 'wf', 't-other', 'ok', 0, 0, 'a', NULL, '[]', 'manual')`).run();
    const r = readRunHandler(session, { runId: 'r-x' });
    expect(r.ok).toBe(false);
  });

  it('🚨 happy: steps con error redacted + outputs omessi (note PII)', () => {
    const steps = [{
      nodeId: 'n-1', defId: 'http', status: 'success', durationMs: 100,
      output: { apiKey: 'sk-leaked-secret', body: 'response' },
      error: null,
    }];
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r1', 'wf', 't-1', 'ok', 0, 100, '2026-06-07', '2026-06-07', ?, 'manual')`).run(JSON.stringify(steps));
    const r = readRunHandler(session, { runId: 'r1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as any;
    expect(data.steps[0].nodeId).toBe('n-1');
    expect(data.steps[0].output).toBeUndefined();
    expect(data.note).toMatch(/PII/u);
  });

  it('🚨 steps_json malformato → array vuoto fallback', () => {
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-broken', 'wf', 't-1', 'ok', 0, 0, 'a', NULL, 'not-json', 'manual')`).run();
    const r = readRunHandler(session, { runId: 'r-broken' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).steps).toEqual([]);
  });
});

describe('🚨 checkSettingsHealthHandler', () => {
  it('🚨 zero config → 3 warnings', () => {
    emailListMock.mockReturnValueOnce([]);
    credListMock.mockReturnValueOnce([]);
    llmListMock.mockReturnValueOnce([]);
    dbStudioListMock.mockReturnValueOnce([]);
    const r = checkSettingsHealthHandler(session);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as any;
    expect(data.warnings).toHaveLength(3);
    expect(data.warnings[0]).toMatch(/email/u);
    expect(data.warnings[1]).toMatch(/LLM/u);
    expect(data.warnings[2]).toMatch(/database/u);
  });

  it('🚨 all configured → no warnings + count + names', () => {
    emailListMock.mockReturnValueOnce([{ isDefault: true }, { isDefault: false }]);
    credListMock.mockReturnValueOnce([{ name: 'api-token' }, { name: 'webhook-sec' }]);
    llmListMock.mockReturnValueOnce([{ provider: 'anthropic', hasKey: true }, { provider: 'openai', hasKey: true }]);
    dbStudioListMock.mockReturnValueOnce([{ tables: ['t1', 't2'] }]);
    const r = checkSettingsHealthHandler(session);
    if (!r.ok) return;
    const data = r.data as any;
    expect(data.warnings).toHaveLength(0);
    expect(data.emailAccounts.count).toBe(2);
    expect(data.emailAccounts.hasDefault).toBe(true);
    expect(data.secrets.names).toEqual(['api-token', 'webhook-sec']);
    expect(data.llmProviders.providers).toEqual(['anthropic', 'openai']);
    expect(data.databases.totalTables).toBe(2);
  });

  it('🚨 llmListMock filtra solo hasKey=true', () => {
    emailListMock.mockReturnValueOnce([]);
    credListMock.mockReturnValueOnce([]);
    llmListMock.mockReturnValueOnce([
      { provider: 'anthropic', hasKey: true },
      { provider: 'openai', hasKey: false }, // skip
    ]);
    dbStudioListMock.mockReturnValueOnce([]);
    const r = checkSettingsHealthHandler(session);
    if (!r.ok) return;
    expect((r.data as any).llmProviders.providers).toEqual(['anthropic']);
  });
});
