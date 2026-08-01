/**
 * Test 2026-grade — ai-metrics route.
 *
 * 🚨 AUTH: tutti gli endpoint richiedono auth (401 senza)
 * 🚨 RBAC: gdpr-purge solo superadmin OR operator (403 altri)
 * 🚨 DATE DEFAULTS: from=daysAgo(7), to=today UTC se omessi
 * 🚨 BY-MODEL: query params YYYY-MM-DD trasformati in ISO datetime inclusivo
 * 🚨 AGGREGATION: totals = sum di tutti gli accumulator field
 * 🚨 SQLite REAL queries per conversations/summary (avg NULL handling)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const readDailyBudgetMock = vi.fn();
const byModelBreakdownMock = vi.fn();
vi.mock('@/services/ai-budget/workflow-call-tracker.service.js', () => ({
  workflowCallTracker: {
    readDailyBudget: readDailyBudgetMock,
    byModelBreakdown: byModelBreakdownMock,
  },
}));

const llmQueueStatsMock = vi.fn();
vi.mock('@/services/llm-queue/llm-queue.service.js', () => ({
  llmQueue: { stats: llmQueueStatsMock },
}));

const runPurgeOnceMock = vi.fn();
vi.mock('@/services/ai-conversations/gdpr-purge.cron.js', () => ({
  runPurgeOnce: runPurgeOnceMock,
}));

const mockDb = { sqlite: null as DB | null };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: mockDb.sqlite }),
}));

const { createAiMetricsRoutes } = await import('./ai-metrics.js');

function setupConvSchema(db: DB): void {
  db.exec(`
    CREATE TABLE ai_conversations (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT
    );
    CREATE TABLE ai_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
  `);
}

function makeApp(role?: 'viewer' | 'editor' | 'admin' | 'operator' | 'superadmin'): Hono {
  const app = new Hono();
  if (role !== undefined) {
    app.use('*', async (c, next) => {
      c.set('auth' as never, { role, userId: 'u1' } as never);
      return next();
    });
  }
  app.route('/m', createAiMetricsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.sqlite = new Database(':memory:');
  setupConvSchema(mockDb.sqlite);
  readDailyBudgetMock.mockReturnValue([]);
  byModelBreakdownMock.mockReturnValue([]);
  llmQueueStatsMock.mockReturnValue({ depth: 0, active: 0 });
});

describe('🚨 auth gate', () => {
  it('🚨 GET /budget senza auth → 401', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/m/ai-metrics/budget');
    expect(res.status).toBe(401);
  });

  it('🚨 GET /queue senza auth → 401', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/m/ai-metrics/queue');
    expect(res.status).toBe(401);
  });

  it('🚨 GET /by-model senza auth → 401', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/m/ai-metrics/by-model');
    expect(res.status).toBe(401);
  });

  it('🚨 GET /conversations/summary senza auth → 401', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/m/ai-metrics/conversations/summary');
    expect(res.status).toBe(401);
  });

  it('🚨 POST /gdpr-purge senza auth → 403 (path differente da 401 ma stesso effetto)', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('🚨 GET /budget — date defaults + totals', () => {
  it('🚨 from/to defaults: 7gg ago → oggi', async () => {
    readDailyBudgetMock.mockReturnValue([]);
    const res = await makeApp('viewer').request('/m/ai-metrics/budget');
    expect(res.status).toBe(200);
    const json = await res.json() as { from: string; to: string };
    expect(json.from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(json.to).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // from < to (7gg diff)
    expect(new Date(json.from).getTime()).toBeLessThan(new Date(json.to).getTime());
  });

  it('🚨 from/to custom propagati al service', async () => {
    await makeApp('viewer').request('/m/ai-metrics/budget?from=2026-06-01&to=2026-06-08');
    expect(readDailyBudgetMock).toHaveBeenCalledWith('2026-06-01', '2026-06-08');
  });

  it('🚨 totals: aggrega ALL fields (input/output/cost/calls/errors)', async () => {
    readDailyBudgetMock.mockReturnValue([
      { day: '2026-06-07', inputTokens: 100, outputTokens: 50, costUsd: 0.05, callCount: 2, errorCount: 0 },
      { day: '2026-06-08', inputTokens: 200, outputTokens: 80, costUsd: 0.10, callCount: 5, errorCount: 1 },
    ]);
    const res = await makeApp('viewer').request('/m/ai-metrics/budget');
    const json = await res.json() as { totals: { inputTokens: number; outputTokens: number; costUsd: number; callCount: number; errorCount: number }; daily: unknown[] };
    expect(json.totals).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      costUsd: 0.15000000000000002, // floating point precision
      callCount: 7,
      errorCount: 1,
    });
    expect(json.daily).toHaveLength(2);
  });

  it('🚨 empty rows → totals tutti a 0', async () => {
    readDailyBudgetMock.mockReturnValue([]);
    const res = await makeApp('viewer').request('/m/ai-metrics/budget');
    const json = await res.json() as { totals: { inputTokens: number; callCount: number } };
    expect(json.totals.inputTokens).toBe(0);
    expect(json.totals.callCount).toBe(0);
  });
});

describe('🚨 GET /queue', () => {
  it('🚨 ritorna llmQueue.stats() direct', async () => {
    llmQueueStatsMock.mockReturnValue({ depth: 12, active: 3, perPriority: { high: 5, normal: 7 } });
    const res = await makeApp('viewer').request('/m/ai-metrics/queue');
    expect(res.status).toBe(200);
    const json = await res.json() as { depth: number; perPriority: Record<string, number> };
    expect(json.depth).toBe(12);
    expect(json.perPriority.high).toBe(5);
  });
});

describe('🚨 GET /by-model — date range conversion ISO', () => {
  it('🚨 YYYY-MM-DD trasformato in ISO datetime inclusivo 00:00..23:59', async () => {
    byModelBreakdownMock.mockReturnValue([]);
    await makeApp('viewer').request('/m/ai-metrics/by-model?from=2026-06-01&to=2026-06-08');
    expect(byModelBreakdownMock).toHaveBeenCalledWith(
      '2026-06-01T00:00:00.000Z',
      '2026-06-08T23:59:59.999Z',
    );
  });

  it('🚨 totals include totalTokens (estende budget totals)', async () => {
    byModelBreakdownMock.mockReturnValue([
      { model: 'claude-3-5', inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.05, callCount: 2, errorCount: 0 },
      { model: 'gpt-4', inputTokens: 200, outputTokens: 80, totalTokens: 280, costUsd: 0.10, callCount: 5, errorCount: 1 },
    ]);
    const res = await makeApp('viewer').request('/m/ai-metrics/by-model');
    const json = await res.json() as { totals: { totalTokens: number; inputTokens: number; outputTokens: number } };
    expect(json.totals.totalTokens).toBe(430);
    expect(json.totals.inputTokens).toBe(300);
    expect(json.totals.outputTokens).toBe(130);
  });

  it('🚨 rows propagated to response as `rows` (not `daily`)', async () => {
    byModelBreakdownMock.mockReturnValue([
      { model: 'claude-3-5', inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, callCount: 0, errorCount: 0 },
    ]);
    const res = await makeApp('viewer').request('/m/ai-metrics/by-model');
    const json = await res.json() as { rows: unknown[]; daily?: unknown };
    expect(json.rows).toHaveLength(1);
    expect(json.daily).toBeUndefined();
  });
});

describe('🚨 GET /conversations/summary — SQLite real queries', () => {
  it('🚨 vuoto → tutti i contatori a 0, avgMessages=0 (NULL handling)', async () => {
    const res = await makeApp('viewer').request('/m/ai-metrics/conversations/summary');
    const json = await res.json() as { totalOpenConversations: number; totalMessages: number; avgMessagesPerConv: number; bySurface: unknown[]; pendingHardPurge: number };
    expect(json.totalOpenConversations).toBe(0);
    expect(json.totalMessages).toBe(0);
    expect(json.avgMessagesPerConv).toBe(0); // NULL → 0
    expect(json.bySurface).toEqual([]);
    expect(json.pendingHardPurge).toBe(0);
  });

  it('🚨 totalOpenConversations counts solo NOT deleted', async () => {
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c1', 'chat', 5);
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c2', 'chat', 10);
    mockDb.sqlite!.prepare(`INSERT INTO ai_conversations (id, surface, message_count, deleted_at) VALUES (?, ?, ?, ?)`)
      .run('c3', 'chat', 3, new Date().toISOString());
    const res = await makeApp('viewer').request('/m/ai-metrics/conversations/summary');
    const json = await res.json() as { totalOpenConversations: number; pendingHardPurge: number };
    expect(json.totalOpenConversations).toBe(2);
    expect(json.pendingHardPurge).toBe(1);
  });

  it('🚨 avgMessagesPerConv calcolato correttamente', async () => {
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c1', 'chat', 10);
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c2', 'chat', 20);
    const res = await makeApp('viewer').request('/m/ai-metrics/conversations/summary');
    const json = await res.json() as { avgMessagesPerConv: number };
    expect(json.avgMessagesPerConv).toBe(15);
  });

  it('🚨 bySurface aggrega per categoria', async () => {
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c1', 'chat', 0);
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c2', 'chat', 0);
    mockDb.sqlite!.prepare('INSERT INTO ai_conversations (id, surface, message_count) VALUES (?, ?, ?)').run('c3', 'workflow', 0);
    const res = await makeApp('viewer').request('/m/ai-metrics/conversations/summary');
    const json = await res.json() as { bySurface: { surface: string; c: number }[] };
    expect(json.bySurface).toHaveLength(2);
    const chat = json.bySurface.find((s) => s.surface === 'chat');
    expect(chat!.c).toBe(2);
  });

  it('🚨 totalMessages counta TUTTI i messages (no tenant filter — single-tenant container)', async () => {
    mockDb.sqlite!.prepare('INSERT INTO ai_messages (id, conversation_id) VALUES (?, ?)').run('m1', 'c1');
    mockDb.sqlite!.prepare('INSERT INTO ai_messages (id, conversation_id) VALUES (?, ?)').run('m2', 'c1');
    const res = await makeApp('viewer').request('/m/ai-metrics/conversations/summary');
    const json = await res.json() as { totalMessages: number };
    expect(json.totalMessages).toBe(2);
  });
});

describe('🚨 POST /gdpr-purge — RBAC superadmin/operator only', () => {
  it('🚨 viewer → 403', async () => {
    const res = await makeApp('viewer').request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(runPurgeOnceMock).not.toHaveBeenCalled();
  });

  it('🚨 editor → 403', async () => {
    const res = await makeApp('editor').request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('🚨 admin → 403 (NOT in whitelist: solo superadmin+operator)', async () => {
    const res = await makeApp('admin').request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('🚨 superadmin → 200 + runPurgeOnce chiamato', async () => {
    runPurgeOnceMock.mockResolvedValue({ purged: 5, errors: 0 });
    const res = await makeApp('superadmin').request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json() as { purged: number };
    expect(json.purged).toBe(5);
  });

  it('🚨 operator → 200 + runPurgeOnce chiamato', async () => {
    runPurgeOnceMock.mockResolvedValue({ purged: 0, errors: 0 });
    const res = await makeApp('operator').request('/m/ai-metrics/gdpr-purge', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runPurgeOnceMock).toHaveBeenCalled();
  });
});
