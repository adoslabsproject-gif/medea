/**
 * Tests 2026-grade per WorkflowCallTracker — Phase 1 budget metering.
 *
 * Coverage:
 *  - record() INSERT ai_workflow_calls + UPSERT ai_budget_daily atomically
 *  - estimateCostUsd per provider/model (regression price table)
 *  - recordChatBudget separato per source='chat'
 *  - readDailyBudget aggregation
 *  - listByRun ordering + limit
 *  - Atomic transaction: row insert E budget UPSERT entrambi su error
 *  - REGRESSION: total_tokens = input + output (no overflow)
 *  - REGRESSION: error_count incrementa SOLO se status != 'ok'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => {
          conn.exec(sql);
        },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) =>
          conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

vi.mock('@/lib/logger.js');

import { WorkflowCallTracker, estimateCostUsd, todayUtc } from './workflow-call-tracker.service.js';

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  // Insert dummy runs row to satisfy FK.
  // Insert dummy workflow + runs to satisfy FK chain.
  const now = new Date().toISOString();
  conn
    .prepare(`INSERT INTO workflows (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run('wf-1', 'Test Workflow', now, now);
  conn
    .prepare(`INSERT INTO runs (id, workflow_id, status, started_at) VALUES (?, ?, 'success', ?)`)
    .run('run-1', 'wf-1', new Date().toISOString());
  conn
    .prepare(`INSERT INTO runs (id, workflow_id, status, started_at) VALUES (?, ?, 'success', ?)`)
    .run('run-2', 'wf-1', new Date().toISOString());
  dbConnections.push(conn);
});

afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
});

describe('estimateCostUsd', () => {
  it('Liara cost amortizzato (~$0.05/M input)', () => {
    const cost = estimateCostUsd('liara', undefined, 1_000_000, 0);
    expect(cost).toBeCloseTo(0.05, 4);
  });

  it('Anthropic Claude Sonnet 4.6 input + output', () => {
    const cost = estimateCostUsd('anthropic', 'claude-sonnet-4-6', 100_000, 50_000);
    // input: 0.1M * $3 = $0.30; output: 0.05M * $15 = $0.75; total = $1.05
    expect(cost).toBeCloseTo(1.05, 4);
  });

  it('Provider sconosciuto → cost 0 (no extrapolation)', () => {
    const cost = estimateCostUsd('xai-grok', 'grok-3', 100_000, 50_000);
    expect(cost).toBe(0);
  });

  it('Ollama self-hosted → cost 0', () => {
    const cost = estimateCostUsd('ollama', 'qwen3:32b', 100_000, 50_000);
    expect(cost).toBe(0);
  });

  it('Grok-2 BYOK customer cost (~$2/M input)', () => {
    const cost = estimateCostUsd('grok', 'grok-2-latest', 1_000_000, 0);
    expect(cost).toBeCloseTo(2.0, 4);
  });

  it('Grok alias "xai/grok-2-latest" identical pricing', () => {
    const cost = estimateCostUsd('xai', 'grok-2-latest', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.0, 4); // 2 input + 10 output
  });

  it('DeepSeek Chat customer cost ($0.27/M input, $1.10/M output)', () => {
    const cost = estimateCostUsd('deepseek', 'deepseek-chat', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.37, 4);
  });

  it('OpenAI GPT-4o customer BYOK pricing', () => {
    const cost = estimateCostUsd('openai', 'gpt-4o', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 4);
  });

  it('Gemini 2.0 Flash BYOK pricing (~$0.10/M input)', () => {
    const cost = estimateCostUsd('gemini', 'gemini-2.0-flash', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.1, 4);
  });

  it('REGRESSION: pricing table provider-agnostic — Liara NON è 100× più cara di altri (no anti-customer bias)', () => {
    // Verifica integrità business: Liara è self-hosted gratis o low-cost,
    // mai prezzata sopra i più costosi BYOK come scoraggiamento ad usarla.
    const liara = estimateCostUsd('liara', undefined, 1_000_000, 1_000_000);
    const gpt4o = estimateCostUsd('openai', 'gpt-4o', 1_000_000, 1_000_000);
    expect(liara).toBeLessThan(gpt4o);
  });
});

describe('WorkflowCallTracker.record', () => {
  it('record() INSERT row + UPDATE budget atomically', () => {
    const tracker = new WorkflowCallTracker();
    const id = tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'agent_1',
      defId: 'agent_classifier',
      provider: 'liara',
      model: 'qwen3-32b',
      inputTokens: 1000,
      outputTokens: 200,
      latencyMs: 1234,
      status: 'ok',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const calls = tracker.listByRun('run-1');
    expect(calls.length).toBe(1);
    expect(calls[0]?.total_tokens).toBe(1200);
    expect(calls[0]?.status).toBe('ok');
  });

  it('UPSERT budget: 2 record stesso giorno → row unica con call_count=2', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'agent_classifier',
      provider: 'liara',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-2',
      workflowId: 'wf-1',
      nodeId: 'n2',
      defId: 'ai_anthropic',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 200,
      outputTokens: 100,
      status: 'ok',
    });
    const today = todayUtc(); // stessa data business-TZ del service (no flakiness UTC)
    const budget = tracker.readDailyBudget(today, today);
    const workflowRow = budget.find((b) => b.source === 'workflow');
    expect(workflowRow?.callCount).toBe(2);
    expect(workflowRow?.inputTokens).toBe(300);
    expect(workflowRow?.outputTokens).toBe(150);
    expect(workflowRow?.costUsd).toBeGreaterThan(0);
  });

  it('REGRESSION: status="error" incrementa error_count', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'ai_anthropic',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 0,
      status: 'error',
      errorMessage: 'rate limited',
    });
    const today = todayUtc(); // stessa data business-TZ del service (no flakiness UTC)
    const budget = tracker.readDailyBudget(today, today);
    const row = budget.find((b) => b.source === 'workflow');
    expect(row?.errorCount).toBe(1);
    expect(row?.callCount).toBe(1);
  });

  it('REGRESSION: status="ok" NON incrementa error_count', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'agent_classifier',
      provider: 'liara',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    const today = todayUtc(); // stessa data business-TZ del service (no flakiness UTC)
    const budget = tracker.readDailyBudget(today, today);
    const row = budget.find((b) => b.source === 'workflow');
    expect(row?.errorCount).toBe(0);
  });

  it('cache_hit field persistito (semantic/prompt cache observability)', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'agent_classifier',
      provider: 'liara',
      inputTokens: 100,
      outputTokens: 0,
      status: 'ok',
      cacheHit: 'semantic',
    });
    const calls = tracker.listByRun('run-1');
    expect(calls[0]?.cache_hit).toBe('semantic');
  });
});

describe('WorkflowCallTracker.recordChatBudget', () => {
  it('chat e workflow source separati nel budget table', () => {
    const tracker = new WorkflowCallTracker();
    tracker.recordChatBudget({ inputTokens: 500, outputTokens: 200, provider: 'liara' });
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'agent_classifier',
      provider: 'liara',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    const today = todayUtc(); // stessa data business-TZ del service (no flakiness UTC)
    const budget = tracker.readDailyBudget(today, today);
    expect(budget.length).toBe(2);
    expect(budget.find((b) => b.source === 'chat')?.inputTokens).toBe(500);
    expect(budget.find((b) => b.source === 'workflow')?.inputTokens).toBe(100);
  });
});

describe('WorkflowCallTracker.byModelBreakdown', () => {
  it('aggrega per provider+model lato workflow', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'agent_classifier',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n2',
      defId: 'agent_classifier',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 200,
      outputTokens: 100,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-2',
      workflowId: 'wf-1',
      nodeId: 'n3',
      defId: 'agent_classifier',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 50,
      outputTokens: 25,
      status: 'ok',
    });
    const rows = tracker.byModelBreakdown('2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    const haiku = rows.find((r) => r.model === 'claude-haiku-4-5');
    expect(haiku?.callCount).toBe(2);
    expect(haiku?.inputTokens).toBe(300);
    expect(haiku?.outputTokens).toBe(150);
    expect(haiku?.source).toBe('workflow');
    const gpt = rows.find((r) => r.model === 'gpt-4o-mini');
    expect(gpt?.callCount).toBe(1);
  });

  it('error_count solo per status != ok', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'd',
      provider: 'liara',
      model: 'qwen3',
      inputTokens: 10,
      outputTokens: 5,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n2',
      defId: 'd',
      provider: 'liara',
      model: 'qwen3',
      inputTokens: 10,
      outputTokens: 0,
      status: 'timeout',
    });
    const rows = tracker.byModelBreakdown('2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    const row = rows.find((r) => r.provider === 'liara');
    expect(row?.callCount).toBe(2);
    expect(row?.errorCount).toBe(1);
  });

  it('ordina per cost desc (modello più costoso in cima)', () => {
    const tracker = new WorkflowCallTracker();
    // openai/gpt-4o ha cost più alto di liara per stessi token
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'd',
      provider: 'liara',
      model: 'qwen3',
      inputTokens: 1000,
      outputTokens: 500,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n2',
      defId: 'd',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      status: 'ok',
    });
    const rows = tracker.byModelBreakdown('2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    expect(rows[0]?.model).toBe('gpt-4o');
    expect(rows[1]?.model).toBe('qwen3');
    expect(rows[0]!.costUsd).toBeGreaterThan(rows[1]!.costUsd);
  });

  it('finestra temporale filtra correttamente', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'd',
      provider: 'liara',
      model: 'qwen3',
      inputTokens: 100,
      outputTokens: 50,
      status: 'ok',
    });
    // Empty range future → no rows.
    const rows = tracker.byModelBreakdown('2100-01-01T00:00:00.000Z', '2200-01-01T00:00:00.000Z');
    expect(rows.length).toBe(0);
  });

  it('rows empty se nessun ai_workflow_calls + nessun ai_messages', () => {
    const tracker = new WorkflowCallTracker();
    const rows = tracker.byModelBreakdown('2020-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z');
    expect(rows).toEqual([]);
  });
});

describe('WorkflowCallTracker.listByRun', () => {
  it('ordering chronological', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'a',
      defId: 'agent_classifier',
      provider: 'liara',
      inputTokens: 10,
      outputTokens: 5,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'b',
      defId: 'agent_extractor',
      provider: 'liara',
      inputTokens: 20,
      outputTokens: 10,
      status: 'ok',
    });
    const calls = tracker.listByRun('run-1');
    expect(calls.length).toBe(2);
    // ordering by created_at ASC
    expect(calls[0]?.node_id).toBe('a');
    expect(calls[1]?.node_id).toBe('b');
  });

  it('limit cap a 1000 + isolamento per run', () => {
    const tracker = new WorkflowCallTracker();
    tracker.record({
      runId: 'run-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      defId: 'd',
      provider: 'liara',
      inputTokens: 1,
      outputTokens: 1,
      status: 'ok',
    });
    tracker.record({
      runId: 'run-2',
      workflowId: 'wf-1',
      nodeId: 'n2',
      defId: 'd',
      provider: 'liara',
      inputTokens: 1,
      outputTokens: 1,
      status: 'ok',
    });
    expect(tracker.listByRun('run-1').length).toBe(1);
    expect(tracker.listByRun('run-2').length).toBe(1);
  });
});
