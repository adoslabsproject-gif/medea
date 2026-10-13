/**
 * Leggere un turno eseguito dalla CLI in abbonamento.
 *
 * Con la CLI il ciclo degli strumenti non è di Medea: la CLI chiama i tool
 * attraverso il server MCP e restituisce il turno a cose fatte. Qui si
 * stabilisce cosa resta da fare a Medea per ciascuna chiamata:
 *
 *  - quelle già eseguite si mostrano;
 *  - quelle che modificano dati il server le ha solo annunciate, e vanno
 *    confermate dall'utente prima di eseguirle;
 *  - le bozze vanno preparate qui per poterne mostrare la scheda.
 */

import type { ToolCall, ToolCallResult, ToolDescriptor } from './tools';
import type { ChatTurn, TokenUsage } from './types';

/** Una chiamata a uno strumento come la riferisce il backend. */
export interface ClaudeCliToolCall {
  id: string;
  name: string;
  /** Vero se lo strumento è di Medea e non di Claude Code. */
  diMedea: boolean;
  arguments: unknown;
  /** Quello che lo strumento ha risposto alla CLI, se ha risposto. */
  output: string | null;
  isError: boolean;
}

export interface ClaudeCliTurn {
  text: string;
  toolCalls: ClaudeCliToolCall[];
  usage: TokenUsage | null;
  /** La sessione della CLI, da riprendere al turno dopo. */
  sessionId: string | null;
}

export interface TurnoCliLetto {
  /** Chiamate già eseguite dalla CLI, da mostrare così come sono. */
  eseguiti: ToolCallResult[];
  /** Chiamate che modificano dati: le esegue Medea, dopo il sì dell'utente. */
  daConfermare: ToolCall[];
  /** Bozze: Medea le riesegue per avere il contenuto della scheda. */
  daPreparare: ToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Il risultato come dato, quando lo strumento ha risposto con dei dati. */
function dato(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function eseguito(call: ToolCall, origine: ClaudeCliToolCall, adesso: string): ToolCallResult {
  // La CLI non dice quando ha chiamato lo strumento né quanto ci ha messo:
  // si segna il momento in cui il turno è arrivato, e nessuna durata.
  const tempi = { startedAt: adesso, finishedAt: adesso, durationMs: 0 };
  if (origine.output === null) {
    return { call, result: null, error: 'nessuna risposta dallo strumento', ...tempi };
  }
  if (origine.isError) {
    return { call, result: null, error: origine.output, ...tempi };
  }
  return { call, result: dato(origine.output), error: null, ...tempi };
}

export function leggiTurnoCli(
  turno: ClaudeCliTurn,
  registry: readonly ToolDescriptor[],
  adesso: string = new Date().toISOString(),
): TurnoCliLetto {
  const letto: TurnoCliLetto = { eseguiti: [], daConfermare: [], daPreparare: [] };

  for (const origine of turno.toolCalls) {
    const call: ToolCall = {
      id: origine.id,
      name: origine.name,
      args: isRecord(origine.arguments) ? origine.arguments : {},
    };
    // Solo gli strumenti di Medea hanno una specie. Quelli di Claude Code li
    // ha già eseguiti — o si è visto negare — la CLI: qui si mostrano e basta,
    // anche se uno portasse lo stesso nome di uno strumento di Medea.
    const kind = origine.diMedea ? registry.find((t) => t.name === origine.name)?.kind : undefined;

    if (kind === 'sensitive') {
      letto.daConfermare.push(call);
    } else if (kind === 'proposal' && !origine.isError && origine.output !== null) {
      letto.daPreparare.push(call);
    } else {
      letto.eseguiti.push(eseguito(call, origine, adesso));
    }
  }

  return letto;
}

/**
 * La conversazione come un solo testo: la CLI riceve un prompt, non una
 * lista di turni.
 *
 * I risultati degli strumenti dei turni passati restano fuori: sono già
 * riassunti nelle risposte dell'assistente, e la CLI ha i suoi strumenti per
 * rileggere ciò che le serve.
 */
export function promptPerCli(history: readonly Pick<ChatTurn, 'role' | 'content'>[]): string {
  return history
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => `${t.role === 'user' ? 'Utente' : 'Assistente'}: ${t.content}`)
    .join('\n\n');
}

/**
 * L'ultimo messaggio dell'utente, così com'è.
 *
 * È quello che si manda quando la CLI riprende una sessione: il resto della
 * conversazione lo ha già. E va mandato senza «Utente:» davanti, perché un
 * comando come `/compact` è tale solo in testa al messaggio.
 */
export function ultimoMessaggio(history: readonly Pick<ChatTurn, 'role' | 'content'>[]): string {
  return history.filter((t) => t.role === 'user').at(-1)?.content ?? '';
}
