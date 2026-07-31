import type { ChatMessage } from '../types';

export interface Attachment {
  name: string;
  size: number;
  type: string;
  base64: string;
}

export interface ComposeDraftProposal {
  type: 'compose_draft';
  summary: string;
  draft: {
    to: string[];
    cc?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    inReplyTo?: string | null;
  };
}

export interface ComposeHtmlProposal {
  type: 'compose_html';
  summary: string;
  document: {
    title: string;
    docKind: 'quote' | 'order_confirm' | 'letter' | 'report' | 'communication' | 'other';
    html: string;
    customerId?: number | null;
    suggestedFilename: string;
  };
}

export type Proposal = ComposeDraftProposal | ComposeHtmlProposal;

/** Esito persistente di una proposal eseguita dall'utente. Indicizzato
 *  per posizione (`index` = stessa della proposal nel `proposals[]` del msg). */
export interface ProposalExecution {
  proposalIndex: number;
  /** Tipo coerente con `proposal.type`. */
  type: 'compose_draft' | 'compose_html';
  /** Stato finale dell'azione. */
  outcome: 'sent' | 'draft_saved' | 'doc_saved';
  at: string;                                  // ISO timestamp
  to?: string[];                                // per sent
  subject?: string;
  draftFolder?: string | null;                  // per draft_saved
  archive?: {
    ok: boolean;
    folder: string | null;
    available: string[];
    error: string | null;
  };                                            // per sent
  filePath?: string;                            // per doc_saved
}

export interface ChatMessageEx extends ChatMessage {
  attachments?: Attachment[];
  /** Proposte di azione che l'utente conferma/annulla con un click. */
  proposals?: Proposal[];
  /** Esiti persistenti delle proposal già eseguite (per posizione). */
  proposalExecutions?: ProposalExecution[];
}

export interface Conversation {
  id: string;
  accountId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageEx[];
}

const STORAGE_KEY = 'medea.ai.conversations.v1';
const ACTIVE_KEY_PREFIX = 'medea.ai.activeConversation.';

function readAll(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Conversation[];
  } catch {
    return [];
  }
}

function writeAll(convs: Conversation[]) {
  try {
    const slim = convs.map((c) => ({
      ...c,
      messages: c.messages.slice(-400).map((m) => {
        const { attachments: _a, ...rest } = m;
        return rest;
      }),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    /* ignore */
  }
}

export function listConversations(accountId: string): Conversation[] {
  return readAll()
    .filter((c) => c.accountId === accountId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getConversation(id: string): Conversation | null {
  return readAll().find((c) => c.id === id) ?? null;
}

export function loadActive(accountId: string): string | null {
  return localStorage.getItem(ACTIVE_KEY_PREFIX + accountId);
}

export function saveActive(accountId: string, convId: string | null) {
  if (convId) localStorage.setItem(ACTIVE_KEY_PREFIX + accountId, convId);
  else localStorage.removeItem(ACTIVE_KEY_PREFIX + accountId);
}

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createConversation(accountId: string, title = 'Nuova conversazione'): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: genId(),
    accountId,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const all = readAll();
  all.push(conv);
  writeAll(all);
  return conv;
}

export function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, 'title' | 'messages'>>,
): Conversation | null {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const updated: Conversation = {
    ...all[idx]!,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.messages !== undefined ? { messages: patch.messages } : {}),
    updatedAt: new Date().toISOString(),
  };
  all[idx] = updated;
  writeAll(all);
  return updated;
}

export function deleteConversation(id: string) {
  const all = readAll().filter((c) => c.id !== id);
  writeAll(all);
}

/** Genera un titolo dai primi messaggi: prende le prime ~6 parole della prima user line. */
export function autoTitle(messages: ChatMessageEx[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!firstUser) return 'Nuova conversazione';
  const words = firstUser.content.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? words.slice(0, 60) + '…' : words;
}

/** One-shot migration: prende la vecchia history `medea.ai.history.<accountId>` e la importa come conv. */
export function migrateLegacyHistory(accountId: string) {
  try {
    const legacyKey = 'medea.ai.history.' + accountId;
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return;
    const msgs = JSON.parse(raw) as ChatMessageEx[];
    if (!Array.isArray(msgs) || msgs.length === 0) {
      localStorage.removeItem(legacyKey);
      return;
    }
    const conv = createConversation(accountId, autoTitle(msgs));
    updateConversation(conv.id, { messages: msgs });
    saveActive(accountId, conv.id);
    localStorage.removeItem(legacyKey);
  } catch {
    /* ignore */
  }
}
