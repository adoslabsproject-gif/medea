/**
 * AI Conversation Service — persistent conversational memory.
 *
 * Phase 1 of AI-SCALING-100-TENANTS architecture. Each tenant has its own
 * SQLite DB (container-per-tenant), so isolation is guaranteed by
 * infrastructure: no WHERE tenant_id needed in queries.
 *
 * Capabilities:
 *   - Create / resolve conversations (scoped by user + workspace + surface)
 *   - Append messages with token + cost metering
 *   - Sliding window context build (last N turns or M tokens)
 *   - Summary compaction trigger (deferred to summary.service in Phase 2)
 *   - Soft-delete + GDPR purge
 *
 * Token counting: provider-reported when available, else conservative
 * char/3.5 estimate (matches llm-chat.service.ts dynamic max_tokens calc).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import type {
  AiConversationRow,
  AiMessageRow,
  CreateConversationInput,
  AppendMessageInput,
  SlidingWindowOptions,
  BuiltContext,
  Surface,
} from './types.js';

const CHARS_PER_TOKEN = 3.5;
const SUMMARY_COMPACTION_THRESHOLD = 50; // turns since last summary (fallback senza soglia token)
// Minimo di messaggi perché valga la pena tentare la compaction token-based:
// servono almeno una coppia da foldare + l'ultima da tenere intera.
const MIN_MESSAGES_TO_COMPACT = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToConversation(row: Record<string, unknown>): AiConversationRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    workflowId: (row.workflow_id as string | null) ?? null,
    surface: row.surface as Surface,
    title: (row.title as string | null) ?? null,
    messageCount: Number(row.message_count ?? 0),
    totalInputTokens: Number(row.total_input_tokens ?? 0),
    totalOutputTokens: Number(row.total_output_tokens ?? 0),
    summary: (row.summary as string | null) ?? null,
    summaryAt: (row.summary_at as string | null) ?? null,
    summaryMessageCount: Number(row.summary_message_count ?? 0),
    providerPin: (row.provider_pin as string | null) ?? null,
    createdAt: row.created_at as string,
    lastMessageAt: row.last_message_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): AiMessageRow {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as AiMessageRow['role'],
    content: row.content as string,
    tokens: row.tokens != null ? Number(row.tokens) : null,
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    costUsdEstimate: row.cost_usd_estimate != null ? Number(row.cost_usd_estimate) : null,
    embeddedAt: (row.embedded_at as string | null) ?? null,
    patchJson: (row.patch_json as string | null) ?? null,
    inSummary: Number(row.in_summary ?? 0),
    createdAt: row.created_at as string,
  };
}

export class ConversationService {
  /**
   * Create a new conversation. Returns the created row.
   */
  create(input: CreateConversationInput): AiConversationRow {
    const { sqlite } = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    sqlite
      .prepare(
        `INSERT INTO ai_conversations
        (id, user_id, workspace_id, workflow_id, surface, provider_pin, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.workspaceId ?? null,
        input.workflowId ?? null,
        input.surface,
        input.providerPin ?? null,
        now,
        now,
      );
    logger.info(
      { conversationId: id, userId: input.userId, surface: input.surface },
      '[ai-conv] created',
    );
    const row = sqlite.prepare(`SELECT * FROM ai_conversations WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Conversation insert failed: ${id}`);
    return rowToConversation(row);
  }

  /**
   * Get a conversation by id. Returns null if not found OR soft-deleted.
   */
  getById(id: string): AiConversationRow | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(`SELECT * FROM ai_conversations WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToConversation(row) : null;
  }

  /**
   * Find OR create — main entry-point for the chat route.
   * If the caller passes a conversationId, validates ownership and returns it.
   * Otherwise creates a new conversation scoped to (user, workspace?, surface).
   */
  findOrCreate(
    conversationId: string | undefined,
    input: CreateConversationInput,
  ): AiConversationRow {
    if (conversationId) {
      const existing = this.getById(conversationId);
      if (existing?.userId === input.userId) return existing;
      // Defensive: id from client but mismatched owner OR deleted → start fresh.
      logger.warn(
        { conversationId, providedUserId: input.userId, foundOwner: existing?.userId ?? null },
        '[ai-conv] stale conversationId, starting new',
      );
    }
    return this.create(input);
  }

  /**
   * List conversations for a user, optionally filtered by surface or workspace.
   * Sorted by last activity desc. Soft-deleted excluded.
   */
  listForUser(
    userId: string,
    opts: { surface?: Surface; workspaceId?: string; limit?: number } = {},
  ): AiConversationRow[] {
    const { sqlite } = getDatabase();
    const conditions: string[] = ['user_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [userId];
    if (opts.surface) {
      conditions.push('surface = ?');
      params.push(opts.surface);
    }
    if (opts.workspaceId) {
      conditions.push('workspace_id = ?');
      params.push(opts.workspaceId);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    params.push(limit);
    const rows = sqlite
      .prepare(
        `SELECT * FROM ai_conversations
       WHERE ${conditions.join(' AND ')}
       ORDER BY last_message_at DESC
       LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToConversation);
  }

  /**
   * Append a message to a conversation atomically. Updates conversation counters.
   * Returns the created message row.
   */
  appendMessage(input: AppendMessageInput): AiMessageRow {
    const { sqlite } = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const tokens = input.tokens ?? estimateTokens(input.content);

    const txn = sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO ai_messages
          (id, conversation_id, role, content, tokens, provider, model, latency_ms, cost_usd_estimate, patch_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.role,
          input.content,
          tokens,
          input.provider ?? null,
          input.model ?? null,
          input.latencyMs ?? null,
          input.costUsdEstimate ?? null,
          input.patch != null ? JSON.stringify(input.patch) : null,
          now,
        );
      const inputDelta = input.role === 'user' || input.role === 'system' ? tokens : 0;
      const outputDelta = input.role === 'assistant' ? tokens : 0;
      sqlite
        .prepare(
          `UPDATE ai_conversations
         SET message_count = message_count + 1,
             total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             last_message_at = ?
         WHERE id = ?`,
        )
        .run(inputDelta, outputDelta, now, input.conversationId);
    });
    txn();

    const row = sqlite.prepare(`SELECT * FROM ai_messages WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Message insert failed: ${id}`);
    return rowToMessage(row);
  }

  /**
   * Get the last N messages of a conversation (ordered chronologically).
   * Excludes messages already folded into a summary (in_summary = 1).
   */
  getRecentMessages(conversationId: string, limit = 40): AiMessageRow[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        `SELECT * FROM ai_messages
       WHERE conversation_id = ? AND in_summary = 0
       ORDER BY created_at DESC
       LIMIT ?`,
      )
      .all(conversationId, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
    return rows.map(rowToMessage).reverse(); // chronological for LLM input
  }

  /**
   * Build the LLM-ready context: summary (if any) + sliding window of recent turns.
   * Caps to `maxTokens` (default 8K) from the tail, with `maxTurns` ceiling.
   */
  buildContext(conversationId: string, opts: SlidingWindowOptions = {}): BuiltContext {
    const maxTurns = opts.maxTurns ?? 20;
    const maxTokens = opts.maxTokens ?? 8192;
    const conv = this.getById(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const all = this.getRecentMessages(conversationId, maxTurns);
    // Take from the tail, accumulating tokens until we hit maxTokens.
    const reversed = [...all].reverse();
    const selected: typeof all = [];
    let totalTokens = 0;
    for (const m of reversed) {
      const t = m.tokens ?? estimateTokens(m.content);
      if (totalTokens + t > maxTokens && selected.length > 0) break;
      selected.unshift(m);
      totalTokens += t;
    }

    return {
      summary: conv.summary,
      messages: selected.map((m) => ({ role: m.role, content: m.content })),
      totalTokensEstimate: totalTokens + (conv.summary ? estimateTokens(conv.summary) : 0),
      conversationId,
    };
  }

  /**
   * Token "vivi" del contesto = ciò che verrà realmente inviato al modello al
   * prossimo turno: summary (se presente) + tutti i messaggi NON ancora foldati
   * (in_summary = 0). È la base per la compaction TOKEN-based (come Claude Code:
   * si comprime al riempimento della finestra, non a conteggio di messaggi).
   *
   * Usa i `tokens` provider-reported quando presenti, altrimenti la stima
   * char/3.5 (stessa euristica del resto del sottosistema).
   */
  liveContextTokens(conversationId: string): number {
    const { sqlite } = getDatabase();
    const conv = this.getById(conversationId);
    if (!conv) return 0;
    const rows = sqlite
      .prepare(
        `SELECT content, tokens FROM ai_messages
       WHERE conversation_id = ? AND in_summary = 0`,
      )
      .all(conversationId) as { content: string; tokens: number | null }[];
    let total = conv.summary ? estimateTokens(conv.summary) : 0;
    for (const r of rows) {
      total += r.tokens != null ? Number(r.tokens) : estimateTokens(r.content);
    }
    return total;
  }

  /**
   * Check if conversation needs summary compaction. Used by background job.
   *
   * - TOKEN-based (preferito, "identico a Claude Code"): se `maxContextTokens` è
   *   fornito, compatta quando i token vivi del contesto superano quella soglia
   *   (tipicamente ~75% della finestra del modello). Si comprime al RIEMPIMENTO,
   *   non a conteggio messaggi.
   * - Fallback a TURNI: senza soglia, mantiene il comportamento storico
   *   (≥ SUMMARY_COMPACTION_THRESHOLD turni dall'ultimo summary) per i chiamanti
   *   che non conoscono la finestra del provider.
   */
  needsCompaction(conversationId: string, opts: { maxContextTokens?: number } = {}): boolean {
    const conv = this.getById(conversationId);
    if (!conv) return false;
    if (opts.maxContextTokens != null && opts.maxContextTokens > 0) {
      // TOKEN-based, "alla Claude Code": comprimi al RIEMPIMENTO, a prescindere dal
      // NUMERO di messaggi. Anche poche conversazioni ma PESANTI vanno compresse
      // (il fold convergente in summary.service tiene gli ultimi entro un budget e
      // folda il resto). Serve solo un minimo per avere qualcosa da foldare.
      if (conv.messageCount < MIN_MESSAGES_TO_COMPACT) return false;
      return this.liveContextTokens(conversationId) >= opts.maxContextTokens;
    }
    return conv.messageCount - conv.summaryMessageCount >= SUMMARY_COMPACTION_THRESHOLD;
  }

  /**
   * Persist a summary + mark old messages as folded. Called by summary.service
   * (Phase 2) after Liara has generated the summary text.
   */
  applySummary(conversationId: string, summary: string, foldUpToTimestamp: string): void {
    const { sqlite } = getDatabase();
    const now = nowIso();
    const txn = sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE ai_conversations
         SET summary = ?,
             summary_at = ?,
             summary_message_count = message_count
         WHERE id = ?`,
        )
        .run(summary, now, conversationId);
      sqlite
        .prepare(
          `UPDATE ai_messages
         SET in_summary = 1
         WHERE conversation_id = ? AND created_at <= ? AND in_summary = 0`,
        )
        .run(conversationId, foldUpToTimestamp);
    });
    txn();
    logger.info({ conversationId, summaryLength: summary.length }, '[ai-conv] summary applied');
  }

  /**
   * Soft-delete (GDPR-friendly). Hard purge runs via cron after 30gg.
   */
  softDelete(conversationId: string, userId: string): boolean {
    const { sqlite } = getDatabase();
    const owned = sqlite
      .prepare(
        `SELECT id FROM ai_conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(conversationId, userId) as { id: string } | undefined;
    if (!owned) return false;
    sqlite
      .prepare(`UPDATE ai_conversations SET deleted_at = ? WHERE id = ?`)
      .run(nowIso(), conversationId);
    return true;
  }

  /**
   * Hard purge — cascade deletes messages via FK. Called by cron when
   * deleted_at < NOW() - 30 days.
   */
  hardPurgeExpired(olderThanIso: string): number {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(`SELECT id FROM ai_conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .all(olderThanIso) as { id: string }[];
    if (rows.length === 0) return 0;
    sqlite
      .prepare(`DELETE FROM ai_conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(olderThanIso);
    logger.warn({ purgedCount: rows.length, olderThanIso }, '[ai-conv] GDPR hard purge');
    return rows.length;
  }
}

export const conversationService = new ConversationService();
