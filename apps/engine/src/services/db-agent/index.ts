/**
 * DB-agent di Liara — barrel pubblico.
 *
 * Sottosistema tenant-safe che espone, in modo deterministico e testabile, le
 * operazioni DB che Liara può compiere nel workspace del PROPRIO tenant:
 * creare database/tabelle/indici, aggiungere/rimuovere colonne (con conferma
 * sulle DROP), inserire e leggere righe. È la base su cui poggia il pannello
 * chat di DB Studio (fetta successiva): l'agente chat non parla mai col
 * DbStudioService direttamente, passa SEMPRE da `executeDbAgentTool`.
 *
 * Confine tenant garantito da [[context]] (tenant da `getTenantId`, congelato),
 * [[guard]] (`get(id, tenantId)`, mai `getAnyTenant`) e dalla validazione
 * `.strict()` dei tool (un `tenantId` iniettato negli args è un errore).
 *
 * @module services/db-agent
 */
export { createDbAgentContext, type DbAgentContext } from './context.js';
export { executeDbAgentTool, listDbAgentTools, isDestructiveTool } from './registry.js';
export type { DbAgentToolResult } from './tool-types.js';
export { runDbAgentChat, type RunDbAgentChatOptions } from './chat/loop.js';
export { buildDbAgentSystemPrompt, type DbAgentPromptContext } from './chat/prompt.js';
export {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse,
  makeOpenAiLlmTurn,
  type OpenAiLlmTurnOptions,
  type OaChatRequest,
} from './chat/openai-tool-adapter.js';
export type {
  ChatTurn,
  LlmTurn,
  LlmTurnInput,
  LlmTurnResult,
  LlmToolCall,
  DbAgentChatResult,
  DbAgentChatStep,
} from './chat/types.js';
export {
  DbAgentError,
  TenantScopeError,
  ToolValidationError,
  ConfirmationRequiredError,
  UnknownToolError,
  type DbAgentErrorCode,
} from './errors.js';
