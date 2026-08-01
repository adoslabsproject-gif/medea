/**
 * Tipi del loop chat agentico del DB-agent (Fetta 2).
 *
 * Il loop è PROVIDER-AGNOSTICO: non conosce Anthropic/OpenAI/Liara. Riceve una
 * funzione `llmTurn` (iniettabile) che incapsula la chiamata al modello con
 * tool-calling e ritorna o un testo finale o una lista di tool da eseguire.
 * Questo rende il cervello deterministico e testabile senza un LLM reale.
 *
 * @module services/db-agent/chat/types
 */

export interface ChatTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Per i messaggi role='tool': id della tool-call a cui rispondono. */
  toolCallId?: string;
  /**
   * Per i messaggi role='assistant' che hanno RICHIESTO tool: le chiamate.
   * Serve all'adapter per costruire un thread OpenAI-compat VALIDO (un
   * messaggio tool deve seguire un assistant con i relativi tool_calls).
   */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  /** id univoco della chiamata (echeggiato nel messaggio tool di risposta). */
  id: string;
  name: string;
  args: unknown;
}

export type LlmTurnResult =
  | { kind: 'final'; text: string }
  | { kind: 'tools'; text?: string; toolCalls: LlmToolCall[] };

export interface LlmTurnInput {
  system: string;
  messages: ChatTurn[];
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
}

export type LlmTurn = (input: LlmTurnInput) => Promise<LlmTurnResult>;

export interface DbAgentChatStep {
  tool: string;
  ok: boolean;
  /** code d'errore del ToolResult (TENANT_SCOPE, CONFIRMATION_REQUIRED, …) se ok=false. */
  code?: string;
  /** true se il tool è distruttivo (l'UI lo evidenzia). */
  destructive: boolean;
}

export interface DbAgentChatResult {
  message: string;
  steps: DbAgentChatStep[];
  iterations: number;
  stoppedReason: 'final' | 'max_iterations';
}
