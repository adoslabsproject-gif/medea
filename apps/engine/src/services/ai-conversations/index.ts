/**
 * Barrel — AI Conversations subsystem (Phase 1 of AI-SCALING-100-TENANTS).
 */
export { ConversationService, conversationService } from './conversation.service.js';
export type {
  Surface,
  Role,
  AiConversationRow,
  AiMessageRow,
  CreateConversationInput,
  AppendMessageInput,
  SlidingWindowOptions,
  BuiltContext,
} from './types.js';
