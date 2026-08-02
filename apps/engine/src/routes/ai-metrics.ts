/**
 * AI Metrics Route — observability per le AI surfaces (chat + workflow + queue).
 *
 * Endpoints (auth required):
 *   GET /ai-metrics/budget?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /ai-metrics/queue
 *   GET /ai-metrics/conversations/summary
 *   POST /ai-metrics/gdpr-purge   (admin only — manual trigger)
 *
 * Aggregato del tenant (single-tenant container = isolato).
 */

import { Hono } from 'hono';
import { workflowCallTracker } from '@/services/ai-budget/workflow-call-tracker.service.js';
import { llmQueue } from '@/services/llm-queue/llm-queue.service.js';
import { runPurgeOnce } from '@/services/ai-conversations/gdpr-purge.cron.js';
import { getDatabase } from '@/storage/db.js';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function createAiMetricsRoutes(): Hono {
  const app = new Hono();

  /** Token + cost budget for chat and workflow surfaces in [from, to] range. */
  app.get('/ai-metrics/budget', (c) => {
    const auth = c.get('auth');
    if (!auth) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    const from = c.req.query('from') ?? daysAgoUtc(7);
    const to = c.req.query('to') ?? todayUtc();
    const rows = workflowCallTracker.readDailyBudget(from, to);
    const totals = rows.reduce(
      (acc, r) => {
        acc.inputTokens += r.inputTokens;
        acc.outputTokens += r.outputTokens;
        acc.costUsd += r.costUsd;
        acc.callCount += r.callCount;
        acc.errorCount += r.errorCount;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, costUsd: 0, callCount: 0, errorCount: 0 },
    );
    return Promise.resolve(c.json({ from, to, daily: rows, totals }));
  });

  /** Current LLM queue depth + active workers + per-priority breakdown. */
  app.get('/ai-metrics/queue', (c) => {
    const auth = c.get('auth');
    if (!auth) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    return Promise.resolve(c.json(llmQueue.stats()));
  });

  /** Per-model breakdown (workflow + chat surfaces unified) for the range. */
  app.get('/ai-metrics/by-model', (c) => {
    const auth = c.get('auth');
    if (!auth) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    const from = c.req.query('from') ?? daysAgoUtc(7);
    const to = c.req.query('to') ?? todayUtc();
    // ai_workflow_calls.created_at e ai_messages.created_at sono ISO datetime,
    // ma le query parameters arrivano come date (YYYY-MM-DD). Trasforma in
    // intervalli inclusivi a livello giornaliero.
    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${to}T23:59:59.999Z`;
    const rows = workflowCallTracker.byModelBreakdown(fromIso, toIso);
    const totals = rows.reduce(
      (acc, r) => {
        acc.inputTokens += r.inputTokens;
        acc.outputTokens += r.outputTokens;
        acc.totalTokens += r.totalTokens;
        acc.costUsd += r.costUsd;
        acc.callCount += r.callCount;
        acc.errorCount += r.errorCount;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, callCount: 0, errorCount: 0 },
    );
    return Promise.resolve(c.json({ from, to, rows, totals }));
  });

  /** Summary stats over ai_conversations: total open, avg messages, top users. */
  app.get('/ai-metrics/conversations/summary', (c) => {
    const auth = c.get('auth');
    if (!auth) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    const { sqlite } = getDatabase();
    const totalOpen = sqlite
      .prepare(`SELECT COUNT(*) as c FROM ai_conversations WHERE deleted_at IS NULL`)
      .get() as { c: number };
    const totalMessages = sqlite.prepare(`SELECT COUNT(*) as c FROM ai_messages`).get() as {
      c: number;
    };
    const avgMessages = sqlite
      .prepare(`SELECT AVG(message_count) as a FROM ai_conversations WHERE deleted_at IS NULL`)
      .get() as { a: number | null };
    const bySurface = sqlite
      .prepare(
        `SELECT surface, COUNT(*) as c FROM ai_conversations WHERE deleted_at IS NULL GROUP BY surface`,
      )
      .all() as { surface: string; c: number }[];
    const pendingPurge = sqlite
      .prepare(`SELECT COUNT(*) as c FROM ai_conversations WHERE deleted_at IS NOT NULL`)
      .get() as { c: number };
    return Promise.resolve(
      c.json({
        totalOpenConversations: totalOpen.c,
        totalMessages: totalMessages.c,
        avgMessagesPerConv: avgMessages.a ?? 0,
        bySurface,
        pendingHardPurge: pendingPurge.c,
      }),
    );
  });

  /** Admin manual trigger for GDPR hard purge (skip 30gg wait for testing). */
  app.post('/ai-metrics/gdpr-purge', async (c) => {
    const auth = c.get('auth');
    if (!auth || (auth.role !== 'superadmin' && auth.role !== 'operator')) {
      return Promise.resolve(c.json({ error: 'Forbidden' }, 403));
    }
    const result = await runPurgeOnce();
    return Promise.resolve(c.json(result));
  });

  return app;
}
