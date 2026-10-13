/**
 * Un turno di Claude Code, dal pannello.
 *
 * Il turno dura a lungo e nel frattempo succedono cose: arriva testo, la CLI
 * usa strumenti, chiede permessi. Qui si tengono insieme: si sceglie cosa
 * mandare, si ascolta, si inoltrano le domande all'utente e le sue risposte
 * alla CLI, e alla fine si ricorda la sessione per il turno dopo.
 */

import { aiApi, type EventoClaudeCode } from '../api';
import { promptPerCli, ultimoMessaggio, type ClaudeCliTurn } from '../claude-cli-turn';
import type { ToolCall } from '../tools';
import type { ChatTurn } from '../types';

import { descriviPermesso } from './permesso';
import {
  cartellaScelta,
  dimenticaSessione,
  modelloScelto,
  ricordaComandi,
  ricordaSessione,
  sessioneDi,
} from './settings';

export interface RichiestaTurno {
  /** La conversazione: la sessione della CLI si ricorda per quella. */
  conversationId: string | null;
  history: readonly Pick<ChatTurn, 'role' | 'content'>[];
  systemPrompt: string;
  /** Riceve tutto il testo scritto finora, a ogni pezzo nuovo. */
  onTesto?: (testo: string) => void;
  /** Riceve il nome di ogni strumento che la CLI comincia a usare. */
  onStrumento?: (nome: string) => void;
  /** Chiede all'utente se un'azione può partire. */
  chiediPermesso: (call: ToolCall, azione: string) => Promise<boolean>;
}

/** Il turno che sta girando adesso, se ce n'è uno. */
let inCorso: string | null = null;
let progressivo = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Vero se la CLI ha rifiutato la sessione perché non la trova più.
 *
 * È l'unico errore dopo il quale si può ricominciare: il turno non è nemmeno
 * partito. Qualunque altro può essere arrivato a metà lavoro, con strumenti
 * che hanno già agito, e rifarlo li farebbe agire due volte.
 */
function sessioneSparita(errore: unknown): boolean {
  const testo = errore instanceof Error ? errore.message : String(errore);
  return /No conversation found/iu.test(testo);
}

async function unTentativo(
  richiesta: RichiestaTurno,
  sessione: string | null,
): Promise<ClaudeCliTurn> {
  progressivo += 1;
  const turnId = `cc-${String(Date.now())}-${String(progressivo)}`;
  let testo = '';

  /** Inoltra la domanda all'utente, e la sua risposta alla CLI. */
  async function rispondi(evento: Extract<EventoClaudeCode, { tipo: 'permesso' }>) {
    let consenti = false;
    try {
      consenti = await richiesta.chiediPermesso(
        {
          id: evento.requestId,
          name: evento.toolName,
          args: isRecord(evento.input) ? evento.input : {},
        },
        descriviPermesso(evento.toolName, evento.input),
      );
    } catch {
      // La CLI aspetta ferma: senza una risposta il turno non finirebbe mai.
      consenti = false;
    }
    await aiApi.claudeCode
      .permesso({ turnId, requestId: evento.requestId, consenti, input: evento.input })
      .catch(() => undefined);
  }

  const smetti = await aiApi.claudeCode.ascolta((evento) => {
    if (evento.turnId !== turnId) return;
    switch (evento.tipo) {
      case 'avvio':
        ricordaComandi(evento.slashCommands);
        break;
      case 'testo':
        testo += evento.delta;
        richiesta.onTesto?.(testo);
        break;
      case 'strumento':
        richiesta.onStrumento?.(evento.name);
        break;
      case 'permesso':
        void rispondi(evento);
        break;
      case 'esitoStrumento':
        break;
    }
  });

  const modello = modelloScelto();
  const cartella = cartellaScelta();
  inCorso = turnId;
  try {
    return await aiApi.claudeCode.turno({
      turnId,
      // Una sessione ripresa ha già il resto della conversazione.
      prompt: sessione ? ultimoMessaggio(richiesta.history) : promptPerCli(richiesta.history),
      systemPrompt: richiesta.systemPrompt,
      ...(modello === 'default' ? {} : { model: modello }),
      ...(sessione ? { sessionId: sessione } : {}),
      ...(cartella ? { cwd: cartella } : {}),
      allowTools: true,
    });
  } finally {
    if (inCorso === turnId) inCorso = null;
    smetti();
  }
}

/** Esegue un turno e restituisce quello che la CLI ha fatto. */
export async function eseguiTurnoClaudeCode(richiesta: RichiestaTurno): Promise<ClaudeCliTurn> {
  const sessione = sessioneDi(richiesta.conversationId);
  let turno: ClaudeCliTurn;
  try {
    turno = await unTentativo(richiesta, sessione);
  } catch (errore) {
    if (!sessione || !sessioneSparita(errore)) throw errore;
    dimenticaSessione(richiesta.conversationId);
    turno = await unTentativo(richiesta, null);
  }
  if (turno.sessionId) ricordaSessione(richiesta.conversationId, turno.sessionId);
  return turno;
}

/** Vero se un turno di Claude Code sta girando. */
export function turnoClaudeCodeInCorso(): boolean {
  return inCorso !== null;
}

/** Ferma il turno in corso, se ce n'è uno. */
export async function fermaTurnoClaudeCode(): Promise<void> {
  if (inCorso) await aiApi.claudeCode.ferma(inCorso);
}
