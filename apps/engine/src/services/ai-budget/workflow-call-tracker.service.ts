/**
 * Workflow LLM Call Tracker — records every LLM invocation performed by
 * a workflow node executor during a run.
 *
 * Phase 1 of AI-SCALING-100-TENANTS. Distinct from ai_messages (chat).
 * Persists to ai_workflow_calls table per-tenant SQLite DB. Powers:
 *   - Per-tenant cost dashboard (chat + workflow unified)
 *   - Anomaly detection (burst > 10× baseline → alert)
 *   - Billing reconciliation at month-end
 *   - Queue depth + scheduler input
 *
 * Cost estimation: rough per-provider/model pricing in pricing-table.ts.
 * Exact provider-reported tokens preferred when available.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

export type WorkflowCallStatus = 'ok' | 'error' | 'rate_limited' | 'circuit_open' | 'timeout';
export type CacheHitKind = 'none' | 'semantic' | 'prompt';

export interface RecordWorkflowCallInput {
  runId: string;
  workflowId: string;
  nodeId: string;
  defId: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costUsdEstimate?: number;
  status: WorkflowCallStatus;
  errorMessage?: string;
  cacheHit?: CacheHitKind;
  queueWaitMs?: number;
  retryAttempt?: number;
}

export interface BudgetDailyRow {
  date: string;
  source: 'chat' | 'workflow';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  callCount: number;
  errorCount: number;
}

/**
 * F14 fix DD audit (2026-06-01) — daily budget timezone Europe/Rome.
 *
 * Pre-fix: `toISOString().slice(0,10)` = UTC date. Per utente IT il reset
 * budget appariva alle 02:00 (estate) / 01:00 (inverno) — non midnight locale.
 * UX confusing: "ho usato budget tutto il giorno, perché si resetta alle 2am?"
 *
 * Post-fix: usa it-IT locale + tz Europe/Rome. Restituisce stringa
 * `YYYY-MM-DD` nella timezone del cliente target. Reset midnight Rome time.
 *
 * Env override `MEDEA_BUDGET_TZ` per multi-region future (es. tenant US).
 */
// NB: misnomer storico — ritorna la data nel fuso BUSINESS (MEDEA_BUDGET_TZ,
// default Europe/Rome), NON UTC. Il budget giornaliero resetta a mezzanotte
// business. Esportato come single-source-of-truth per i test (evita flakiness
// timezone: il test non deve ricalcolare la data con UTC).
export function todayUtc(): string {
  const tz = process.env.MEDEA_BUDGET_TZ ?? 'Europe/Rome';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  });
  return fmt.format(new Date());
}

/**
 * Per-provider/model pricing (USD per 1M tokens). Provider-agnostic table —
 * every supported vendor included alla pari. Updated 2026-05-30.
 *
 * Estensione: aggiungi qui voci `<provider>/<model>` quando emergono nuovi
 * modelli pubblici. Quando il provider e\` self-hosted (Liara, Ollama),
 * modelliamo SOLO il cost amortizzato della GPU (no per-token outflow USD).
 *
 * Lookup: prima prova `${provider}/${model}` esatto, poi cade su `${provider}`
 * fallback. Se nessun match → cost 0 (no extrapolazione: meglio underbill
 * di overbill in mancanza di dati).
 */
const PRICING_TABLE: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Liara self-hosted (GPU amortized)
  liara: { inputPerM: 0.05, outputPerM: 0.1 },

  // OpenAI (ChatGPT)
  'openai/gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'openai/gpt-4.1': { inputPerM: 2.0, outputPerM: 8.0 },
  'openai/gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'openai/o1': { inputPerM: 15.0, outputPerM: 60.0 },
  'openai/o1-mini': { inputPerM: 3.0, outputPerM: 12.0 },

  // Anthropic Claude
  'anthropic/claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'anthropic/claude-haiku-4-5': { inputPerM: 0.8, outputPerM: 4.0 },
  'anthropic/claude-opus-4-7': { inputPerM: 15.0, outputPerM: 75.0 },

  // Google Gemini
  'gemini/gemini-2.0-flash': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini/gemini-2.0-pro': { inputPerM: 1.25, outputPerM: 5.0 },

  // Grok (X.AI)
  'grok/grok-2-latest': { inputPerM: 2.0, outputPerM: 10.0 },
  'grok/grok-2-mini': { inputPerM: 0.2, outputPerM: 0.8 },
  'grok/grok-3': { inputPerM: 5.0, outputPerM: 25.0 },
  // alias xai (dispatcher matcha entrambi)
  'xai/grok-2-latest': { inputPerM: 2.0, outputPerM: 10.0 },
  'xai/grok-3': { inputPerM: 5.0, outputPerM: 25.0 },

  // DeepSeek
  'deepseek/deepseek-chat': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek/deepseek-coder': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek/deepseek-reasoner': { inputPerM: 0.55, outputPerM: 2.19 },

  // Mistral
  'mistral/mistral-large': { inputPerM: 2.0, outputPerM: 6.0 },
  'mistral/mistral-medium': { inputPerM: 0.4, outputPerM: 2.0 },
  'mistral/mistral-small': { inputPerM: 0.2, outputPerM: 0.6 },

  // Groq (LPU — hardware fast inference)
  'groq/llama-3.3-70b-versatile': { inputPerM: 0.59, outputPerM: 0.79 },
  'groq/llama-3.1-8b-instant': { inputPerM: 0.05, outputPerM: 0.08 },

  // OpenRouter — pass-through (no surcharge tracked here, real cost arrives
  // dal vendor backing). Cost 0 fallback finche\` non tracciamo header X-Cost.
  openrouter: { inputPerM: 0, outputPerM: 0 },

  // Ollama self-hosted (free)
  ollama: { inputPerM: 0, outputPerM: 0 },
};

export function estimateCostUsd(
  provider: string,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = model ? `${provider}/${model}` : provider;
  const price = PRICING_TABLE[key] ?? PRICING_TABLE[provider] ?? { inputPerM: 0, outputPerM: 0 };
  return (
    (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
  );
}

export class WorkflowCallTracker {
  /**
   * Persist a workflow LLM call. Also updates ai_budget_daily atomically.
   */
  record(input: RecordWorkflowCallInput): string {
    const { sqlite } = getDatabase();
    const id = randomUUID();
    const now = new Date().toISOString();
    const totalTokens = (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    const cost =
      input.costUsdEstimate ??
      estimateCostUsd(input.provider, input.model, input.inputTokens ?? 0, input.outputTokens ?? 0);

    const txn = sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO ai_workflow_calls
          (id, run_id, workflow_id, node_id, def_id, provider, model,
           input_tokens, output_tokens, total_tokens, latency_ms, cost_usd_estimate,
           status, error_message, cache_hit, queue_wait_ms, retry_attempt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          input.workflowId,
          input.nodeId,
          input.defId,
          input.provider,
          input.model ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          totalTokens,
          input.latencyMs ?? null,
          cost,
          input.status,
          input.errorMessage ?? null,
          input.cacheHit ?? 'none',
          input.queueWaitMs ?? null,
          input.retryAttempt ?? 0,
          now,
        );

      // Update daily budget atomically (UPSERT).
      const date = todayUtc();
      const isError = input.status !== 'ok' ? 1 : 0;
      sqlite
        .prepare(
          `INSERT INTO ai_budget_daily (date, source, input_tokens, output_tokens, cost_usd, call_count, error_count)
         VALUES (?, 'workflow', ?, ?, ?, 1, ?)
         ON CONFLICT(date, source) DO UPDATE SET
           input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           cost_usd = cost_usd + ?,
           call_count = call_count + 1,
           error_count = error_count + ?`,
        )
        .run(
          date,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          cost,
          isError,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          cost,
          isError,
        );
    });
    try {
      txn();
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          runId: input.runId,
          defId: input.defId,
        },
        '[ai-budget] record failed',
      );
      throw err;
    }
    return id;
  }

  /**
   * Record a chat-side LLM call (delta on top of ai_messages). Used by
   * ai-assistant route to keep the budget table in sync.
   */
  recordChatBudget(input: {
    inputTokens: number;
    outputTokens: number;
    provider: string;
    model?: string;
    isError?: boolean;
  }): void {
    const { sqlite } = getDatabase();
    const date = todayUtc();
    const cost = estimateCostUsd(
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
    );
    const errFlag = input.isError ? 1 : 0;
    sqlite
      .prepare(
        `INSERT INTO ai_budget_daily (date, source, input_tokens, output_tokens, cost_usd, call_count, error_count)
       VALUES (?, 'chat', ?, ?, ?, 1, ?)
       ON CONFLICT(date, source) DO UPDATE SET
         input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?,
         cost_usd = cost_usd + ?,
         call_count = call_count + 1,
         error_count = error_count + ?`,
      )
      .run(
        date,
        input.inputTokens,
        input.outputTokens,
        cost,
        errFlag,
        input.inputTokens,
        input.outputTokens,
        cost,
        errFlag,
      );
  }

  /**
   * Read daily budget rows for dashboard / billing.
   */
  readDailyBudget(fromDate: string, toDate: string): BudgetDailyRow[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        `SELECT date, source, input_tokens, output_tokens, cost_usd, call_count, error_count
       FROM ai_budget_daily
       WHERE date BETWEEN ? AND ?
       ORDER BY date DESC, source`,
      )
      .all(fromDate, toDate) as Record<string, unknown>[];
    return rows.map((r) => ({
      date: r.date as string,
      source: r.source as 'chat' | 'workflow',
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: Number(r.cost_usd),
      callCount: Number(r.call_count),
      errorCount: Number(r.error_count),
    }));
  }

  /**
   * Get last N workflow calls for run, useful for debugging + Run Inspector AI panel.
   */
  listByRun(runId: string, limit = 100): Record<string, unknown>[] {
    const { sqlite } = getDatabase();
    return sqlite
      .prepare(`SELECT * FROM ai_workflow_calls WHERE run_id = ? ORDER BY created_at LIMIT ?`)
      .all(runId, Math.min(limit, 1000)) as Record<string, unknown>[];
  }

  /**
   * Per-model breakdown across workflow + chat surfaces in [fromDate, toDate].
   * Unisce ai_workflow_calls (esecuzioni nodi AI in un run) + ai_messages
   * (turn assistant della editor_chat / chat conversazionale).
   *
   * Output ordinato per cost desc — modelli più costosi in cima.
   */
  byModelBreakdown(
    fromDateIso: string,
    toDateIso: string,
  ): {
    provider: string;
    model: string;
    source: 'workflow' | 'chat';
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    callCount: number;
    errorCount: number;
  }[] {
    const { sqlite } = getDatabase();
    // Workflow side
    const wfRows = sqlite
      .prepare(
        `SELECT provider, COALESCE(model, '-') as model,
              SUM(COALESCE(input_tokens, 0))  as input_tokens,
              SUM(COALESCE(output_tokens, 0)) as output_tokens,
              SUM(COALESCE(total_tokens, 0))  as total_tokens,
              SUM(COALESCE(cost_usd_estimate, 0)) as cost_usd,
              COUNT(*) as call_count,
              SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) as error_count
       FROM ai_workflow_calls
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY provider, COALESCE(model, '-')`,
      )
      .all(fromDateIso, toDateIso) as Record<string, unknown>[];

    // Chat side (assistant turn) — model can be NULL for older rows.
    const chatRows = sqlite
      .prepare(
        `SELECT COALESCE(provider, 'unknown') as provider,
              COALESCE(model, '-') as model,
              SUM(CASE WHEN role = 'user' THEN COALESCE(tokens, 0) ELSE 0 END) as input_tokens,
              SUM(CASE WHEN role = 'assistant' THEN COALESCE(tokens, 0) ELSE 0 END) as output_tokens,
              SUM(COALESCE(tokens, 0)) as total_tokens,
              SUM(COALESCE(cost_usd_estimate, 0)) as cost_usd,
              SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as call_count,
              0 as error_count
       FROM ai_messages
       WHERE provider IS NOT NULL
         AND created_at >= ? AND created_at <= ?
       GROUP BY COALESCE(provider, 'unknown'), COALESCE(model, '-')`,
      )
      .all(fromDateIso, toDateIso) as Record<string, unknown>[];

    const mapRow = (source: 'workflow' | 'chat') => (r: Record<string, unknown>) => ({
      provider: String(r.provider),
      model: String(r.model),
      source,
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      totalTokens: Number(r.total_tokens ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
      callCount: Number(r.call_count ?? 0),
      errorCount: Number(r.error_count ?? 0),
    });

    const all = [...wfRows.map(mapRow('workflow')), ...chatRows.map(mapRow('chat'))];
    all.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
    return all;
  }
}

export const workflowCallTracker = new WorkflowCallTracker();
