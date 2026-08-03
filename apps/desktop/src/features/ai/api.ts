import { invoke } from '@tauri-apps/api/core';

import type { ChatRequest, ChatResponse } from './types';

export interface ClaudeCliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  message: string;
}

export const aiApi = {
  chat: (req: ChatRequest): Promise<ChatResponse> => invoke('ai_chat', { req }),

  /** Ferma un'inferenza in volo. Fermarne una già finita non è un errore. */
  chatAbort: (requestId: string): Promise<void> => invoke('ai_chat_abort', { requestId }),

  /** Stato della CLI `claude` locale (provider in abbonamento). */
  claudeCliStatus: (): Promise<ClaudeCliStatus> => invoke('claude_cli_status'),

  /** Turno eseguito dalla CLI in abbonamento; i tool di Medea passano da MCP. */
  claudeCliRun: (args: {
    prompt: string;
    systemPrompt?: string | undefined;
    model?: string | undefined;
    allowTools: boolean;
  }): Promise<string> => invoke('claude_cli_run', args),
};
