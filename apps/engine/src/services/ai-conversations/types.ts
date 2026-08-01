/**
 * Types for AI Conversations subsystem.
 * Phase 1 of AI-SCALING-100-TENANTS architecture (docs/AI-SCALING-100-TENANTS.md).
 */

export type Surface = 'editor_chat' | 'wizard_scaffold' | 'help_chat' | 'node_editor' | 'db_studio';
export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface AiConversationRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  workflowId: string | null;
  surface: Surface;
  title: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  summary: string | null;
  summaryAt: string | null;
  summaryMessageCount: number;
  providerPin: string | null;
  createdAt: string;
  lastMessageAt: string;
  deletedAt: string | null;
}

export interface AiMessageRow {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  tokens: number | null;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  costUsdEstimate: number | null;
  embeddedAt: string | null;
  patchJson: string | null;
  inSummary: number;
  createdAt: string;
}

export interface CreateConversationInput {
  userId: string;
  workspaceId?: string;
  workflowId?: string;
  surface: Surface;
  providerPin?: string;
}

export interface AppendMessageInput {
  conversationId: string;
  role: Role;
  content: string;
  tokens?: number;
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsdEstimate?: number;
  patch?: unknown;
}

export interface SlidingWindowOptions {
  /** Max turns to include from the tail. Default 20. */
  maxTurns?: number;
  /** Max tokens to include from the tail (whichever hits first). Default 8192. */
  maxTokens?: number;
}

export interface BuiltContext {
  summary: string | null;
  messages: { role: Role; content: string }[];
  totalTokensEstimate: number;
  conversationId: string;
}
