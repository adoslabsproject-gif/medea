/**
 * Le conversazioni con l'assistente, conservate fra una sessione e l'altra.
 *
 * Perdere la conversazione quando si chiude l'app significa perdere il
 * ragionamento che ha portato al workflow: «perché quel nodo è lì» sta lì
 * dentro, non nel documento. Per questo si salvano, per workflow — e quella
 * di un workflow non deve comparire mentre se ne guarda un altro.
 *
 * Il salvataggio è in `localStorage`: sono poche decine di kilobyte per
 * workflow, e non c'è niente qui che valga un giro nel database.
 */

import type { ChatMessage } from './types';

const PREFIX = 'medea.workflows.chat:';
/** Le conversazioni di un workflow: le più recenti in cima. */
const MAX_CONVERSATIONS = 20;
/** Oltre questo numero di messaggi si dimenticano i più vecchi. */
const MAX_MESSAGES = 200;

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

/** La chiave di un workflow. I workflow non ancora salvati hanno la loro. */
function keyFor(workflowId: string | undefined): string {
  return `${PREFIX}${workflowId ?? 'nuovo'}`;
}

export function loadConversations(workflowId: string | undefined): Conversation[] {
  try {
    const raw = localStorage.getItem(keyFor(workflowId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation);
  } catch {
    // Una conversazione illeggibile non deve impedire di parlare con
    // l'assistente: si riparte da zero.
    return [];
  }
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c.id === 'string' && Array.isArray(c.messages);
}

export function saveConversations(
  workflowId: string | undefined,
  conversations: readonly Conversation[],
): void {
  const trimmed = conversations.slice(0, MAX_CONVERSATIONS).map((c) => ({
    ...c,
    messages: c.messages.slice(-MAX_MESSAGES),
  }));
  try {
    localStorage.setItem(keyFor(workflowId), JSON.stringify(trimmed));
  } catch {
    // Spazio esaurito: meglio perdere la cronologia che bloccare l'app.
  }
}

/**
 * Il titolo di una conversazione: la prima richiesta dell'utente, accorciata.
 * È quello che serve per ritrovarla in un elenco — la data no, le
 * conversazioni di uno stesso giorno sono tutte uguali.
 */
export function titleFrom(messages: readonly ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'Conversazione vuota';
  const text = first.text.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

let seq = 0;
export function newConversationId(): string {
  seq += 1;
  return `c${String(seq)}-${String(Math.trunc(performance.now()))}`;
}
