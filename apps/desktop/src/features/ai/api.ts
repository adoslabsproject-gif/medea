import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { ClaudeCliTurn } from './claude-cli-turn';
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

  /** Claude Code dentro il pannello: la CLI in abbonamento, pilotata da Medea. */
  claudeCode: {
    /**
     * Esegue un turno. Mentre gira, gli eventi arrivano a chi `ascolta`; alla
     * fine torna il turno intero, con gli strumenti usati e la sessione.
     */
    turno: (richiesta: TurnoClaudeCode): Promise<ClaudeCliTurn> =>
      invoke('claude_code_turno', { richiesta }),

    /** La risposta dell'utente a una richiesta di permesso. */
    permesso: (args: {
      turnId: string;
      requestId: string;
      consenti: boolean;
      input: unknown;
    }): Promise<void> => invoke('claude_code_permesso', args),

    /** Ferma un turno in corso. Fermarne uno già finito non è un errore. */
    ferma: (turnId: string): Promise<boolean> => invoke('claude_code_ferma', { turnId }),

    /** Fa scegliere la cartella di lavoro. `null` se l'utente annulla. */
    scegliCartella: (): Promise<string | null> => invoke('claude_code_scegli_cartella'),

    /** Si mette in ascolto degli eventi. Restituisce come smettere. */
    ascolta: (onEvento: (evento: EventoClaudeCode) => void): Promise<() => void> =>
      listen<EventoClaudeCode>('claude-code:evento', (e) => {
        onEvento(e.payload);
      }),
  },
};

/** Cosa si chiede alla CLI per un turno. */
export interface TurnoClaudeCode {
  /** Lo sceglie chi chiama: serve a rispondere ai permessi e a fermare. */
  turnId: string;
  prompt: string;
  systemPrompt?: string | undefined;
  model?: string | undefined;
  /** La sessione della CLI da riprendere, dal turno precedente. */
  sessionId?: string | undefined;
  /** La cartella di lavoro scelta dall'utente. */
  cwd?: string | undefined;
  allowTools: boolean;
}

/** Quello che arriva mentre un turno è in corso. */
export type EventoClaudeCode = { turnId: string } & (
  | { tipo: 'avvio'; sessionId: string; model: string; slashCommands: string[] }
  | { tipo: 'testo'; delta: string }
  | { tipo: 'strumento'; id: string; name: string; diMedea: boolean; input: unknown }
  | { tipo: 'esitoStrumento'; id: string; output: string | null; isError: boolean }
  | {
      tipo: 'permesso';
      requestId: string;
      toolName: string;
      input: unknown;
      descrizione: string | null;
    }
);
