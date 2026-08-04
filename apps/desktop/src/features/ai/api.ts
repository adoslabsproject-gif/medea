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

  /**
   * Sveglia il modello senza chiedergli niente di utile.
   *
   * Un server di inferenza scarica il modello dalla scheda quando nessuno lo
   * usa, e rimetterlo su costa minuti: chi ne ha uno tutto per sé lo trova
   * quasi sempre spento, e la prima richiesta paga l'attesa senza ricevere
   * risposta. Chiamandolo all'apertura del wizard, il caricamento avviene
   * mentre l'utente scrive cosa vuole — decine di secondi che altrimenti non
   * servono a niente.
   *
   * Non si aspetta e non si controlla l'esito: è un favore, non un requisito.
   */
  warmup: (req: ChatRequest): Promise<void> => invoke('ai_warmup', { req }),

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
