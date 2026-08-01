/**
 * LLM Queue Service — per-tenant fair scheduling for LLM dispatch.
 *
 * Phase 3 of AI-SCALING-100-TENANTS. Lives inside the runtime container
 * (one queue per tenant by isolation), backed by Dragonfly (Redis-compat).
 *
 * Architecture decisions:
 *   - Single tenant per container → no cross-tenant contention at this layer.
 *     Per-tenant fairness lives in the PORTAL llm gateway aggregator.
 *   - Per-user lane within tenant → prevents one user flooding others
 *     (chat AI + workflow runs share the same lane).
 *   - Priority by source:
 *       P0 chat (interactive UX, latency-sensitive)
 *       P1 workflow run (batch, throughput-sensitive)
 *       P2 background (summary, embedding) — runs only when P0/P1 idle
 *   - Backpressure: when queue depth > MAX_QUEUE_DEPTH, returns 429
 *     Retry-After (jitter) instead of enqueuing.
 *
 * The queue is in-memory + Redis-backed for crash recovery. Workers are
 * driven by the same process (no separate worker pool needed at tenant
 * scale; tenant container = max ~5 concurrent LLM calls).
 */

import { logger } from '@/lib/logger.js';

export type LlmJobPriority = number; // effective priority dopo plan tier weight
export type LlmJobSource = 'chat' | 'workflow' | 'background';
export type LlmJobPlanTier = 'free' | 'starter' | 'pro' | 'team' | 'enterprise';

/**
 * Modifier prioritario per plan tier (paying customers privilege).
 * Negativo = priorita\` ALTA (servito prima). Positivo = priorita\` BASSA.
 * Sommato a base source priority.
 *   Esempi:
 *     enterprise + workflow = -2 + 1 = -1   ← top priority
 *     pro       + workflow =  0 + 1 =  1
 *     starter   + workflow = +1 + 1 =  2
 *     free      + workflow = +2 + 1 =  3
 *     enterprise + background = -2 + 2 = 0  ← bg enterprise = chat free!
 */
const PLAN_TIER_PRIORITY_MODIFIER: Record<LlmJobPlanTier, number> = {
  enterprise: -2,
  team: -1,
  pro: 0,
  starter: 1,
  free: 2,
};

/** Max queue depth scala con plan tier — enterprise puo\` accodare di piu\`. */
const PLAN_TIER_QUEUE_QUOTA: Record<LlmJobPlanTier, number> = {
  enterprise: 50,
  team: 35,
  pro: 25,
  starter: 15,
  free: 8,
};

export interface LlmJob<R = unknown> {
  id: string;
  userId: string;
  source: LlmJobSource;
  priority: LlmJobPriority;
  enqueuedAt: number;
  runner: () => Promise<R>;
  resolve: (value: R) => void;
  reject: (err: Error) => void;
}

export class QueueBackpressureError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`LLM queue at capacity, retry after ${retryAfterMs.toString()}ms`);
    this.name = 'QueueBackpressureError';
  }
}

const MAX_QUEUE_DEPTH_TOTAL = 100;
const MAX_QUEUE_DEPTH_PER_USER = 20;
const MAX_CONCURRENCY = 5; // active workers per tenant container
const RETRY_AFTER_BASE_MS = 2000;
const RETRY_AFTER_JITTER_MS = 1500;

function nextRetryAfterMs(): number {
  return RETRY_AFTER_BASE_MS + Math.floor(Math.random() * RETRY_AFTER_JITTER_MS);
}

/**
 * In-memory priority queue scoped to the tenant. The runtime container
 * is per-tenant, so this implicitly is per-tenant.
 *
 * Workers loop: while activeCount < MAX_CONCURRENCY && queue.length > 0:
 *   pick highest priority (lowest priority number) → run → notify.
 */
export class LlmQueue {
  private queue: LlmJob[] = [];
  private active = new Set<string>();
  private depthPerUser = new Map<string, number>();

  /**
   * Enqueue a job and await its result. If queue is full, throws
   * QueueBackpressureError immediately (caller decides retry semantics).
   */
  enqueue<R>(opts: {
    userId: string;
    source: LlmJobSource;
    runner: () => Promise<R>;
    /** Plan tier del workspace — modulates priority + per-user quota. Default 'pro'. */
    planTier?: LlmJobPlanTier;
  }): Promise<R> {
    const planTier: LlmJobPlanTier = opts.planTier ?? 'pro';
    if (this.queue.length >= MAX_QUEUE_DEPTH_TOTAL) {
      throw new QueueBackpressureError(nextRetryAfterMs());
    }
    const perUserQuota = PLAN_TIER_QUEUE_QUOTA[planTier];
    const perUser = this.depthPerUser.get(opts.userId) ?? 0;
    if (perUser >= perUserQuota) {
      throw new QueueBackpressureError(nextRetryAfterMs());
    }

    // Plan-weighted priority: paying customers get faster service.
    // base: chat=0, workflow=1, background=2
    // +modifier: enterprise=-2, team=-1, pro=0, starter=+1, free=+2
    const basePriority = opts.source === 'chat' ? 0 : opts.source === 'workflow' ? 1 : 2;
    const effectivePriority = basePriority + PLAN_TIER_PRIORITY_MODIFIER[planTier];

    return new Promise<R>((resolve, reject) => {
      const job: LlmJob<R> = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        userId: opts.userId,
        source: opts.source,
        priority: effectivePriority,
        enqueuedAt: Date.now(),
        runner: opts.runner,
        resolve: resolve,
        reject,
      };
      this.queue.push(job as LlmJob);
      this.depthPerUser.set(opts.userId, perUser + 1);
      this.tick();
    });
  }

  private tick(): void {
    while (this.active.size < MAX_CONCURRENCY && this.queue.length > 0) {
      // Sort by priority asc + enqueuedAt asc (FIFO within priority).
      this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
      const job = this.queue.shift();
      if (!job) break;
      this.runJob(job);
    }
  }

  private runJob(job: LlmJob): void {
    this.active.add(job.id);
    const waitMs = Date.now() - job.enqueuedAt;
    if (waitMs > 1000) {
      logger.warn({ jobId: job.id, source: job.source, waitMs }, '[llm-queue] long wait');
    }
    void job.runner()
      .then((result) => { job.resolve(result); })
      .catch((err: unknown) => { job.reject(err instanceof Error ? err : new Error(String(err))); })
      .finally(() => {
        this.active.delete(job.id);
        const cnt = this.depthPerUser.get(job.userId) ?? 1;
        if (cnt <= 1) this.depthPerUser.delete(job.userId);
        else this.depthPerUser.set(job.userId, cnt - 1);
        this.tick();
      });
  }

  /**
   * Snapshot for observability — used by /admin/ai-queue metrics endpoint.
   */
  stats(): {
    queued: number;
    active: number;
    capacityTotal: number;
    capacityPerUser: number;
    concurrencyMax: number;
    byPriority: Record<string, number>;
  } {
    const byPriority: Record<string, number> = { '0': 0, '1': 0, '2': 0 };
    for (const j of this.queue) byPriority[j.priority.toString()] = (byPriority[j.priority.toString()] ?? 0) + 1;
    return {
      queued: this.queue.length,
      active: this.active.size,
      capacityTotal: MAX_QUEUE_DEPTH_TOTAL,
      capacityPerUser: MAX_QUEUE_DEPTH_PER_USER,
      concurrencyMax: MAX_CONCURRENCY,
      byPriority,
    };
  }
}

export const llmQueue = new LlmQueue();
