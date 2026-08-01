/**
 * Contesto CROSS-SURFACE — memoria conversazionale condivisa per workspace.
 *
 * Obiettivo (richiesta owner): quando l'utente parla con Liara in UNA scheda
 * (workflow editor / editor nodi / db-studio) e poi passa a un'altra, Liara
 * "ricorda" cosa stava facendo nelle ALTRE schede dello STESSO workspace —
 * senza dover rispiegare. Es. "nell'editor nodi chiedo del workflow" o "in
 * db-studio nomino il lavoro fatto nel workflow editor".
 *
 * Design: NON una UI unica e NON un thread unico (le chat restano separate, con
 * funzioni diverse). Si CONDIVIDE il CONTESTO: un blocco compatto, costruito
 * dalle conversazioni delle ALTRE surface del workspace (loro `summary`, o gli
 * ultimi turni se non c'è ancora summary), iniettato nel system prompt della
 * surface corrente. Loose coupling, sfrutta i summary già esistenti.
 *
 * Read-only: non scrive nulla. Fail-soft: qualunque errore → blocco vuoto (mai
 * un 500 per colpa del contesto).
 *
 * @module services/ai-conversations/cross-surface-context
 */
import { conversationService } from './conversation.service.js';
import type { AiConversationRow } from './types.js';

/** Etichette leggibili per surface (Record<string,string> → niente coupling al CHECK). */
const SURFACE_LABELS: Record<string, string> = {
  editor_chat: 'Workflow editor',
  wizard_scaffold: 'Creazione guidata workflow',
  help_chat: 'Aiuto',
  node_editor: 'Editor nodi',
  db_studio: 'DB Studio',
};

export interface CrossSurfaceOptions {
  /** Conversazione corrente da ESCLUDERE (è già nel contesto della surface). */
  excludeConversationId?: string;
  /** Max surface diverse da includere (default 4). */
  maxSurfaces?: number;
  /** Cap caratteri per voce (default 320). */
  maxCharsPerEntry?: number;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Riepilogo di una conversazione: summary se presente, altrimenti ultimi turni. */
function summarize(conv: AiConversationRow, maxChars: number): string {
  if (conv.summary && conv.summary.trim().length > 0) return clip(conv.summary, maxChars);
  const msgs = conversationService.getRecentMessages(conv.id, 4)
    .filter((m) => m.role === 'user' || m.role === 'assistant');
  if (msgs.length === 0) return '';
  return clip(msgs.map((m) => `${m.role === 'user' ? 'U' : 'A'}: ${m.content}`).join(' · '), maxChars);
}

/**
 * Costruisce il blocco di contesto cross-surface per (utente, workspace).
 * Stringa vuota se non c'è nulla di pertinente. Una voce per surface (la
 * conversazione più recente di quella surface), escludendo quella corrente.
 */
export function buildCrossSurfaceContext(
  userId: string,
  workspaceId: string | undefined,
  opts: CrossSurfaceOptions = {},
): string {
  if (!userId || !workspaceId) return '';
  const maxSurfaces = opts.maxSurfaces ?? 4;
  const maxChars = opts.maxCharsPerEntry ?? 320;
  try {
    const convs = conversationService.listForUser(userId, { workspaceId, limit: 25 });
    // listForUser è ORDER BY last_message_at DESC → la prima per surface è la più recente.
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const c of convs) {
      if (entries.length >= maxSurfaces) break;
      if (c.id === opts.excludeConversationId) continue;
      if (c.messageCount === 0) continue;
      if (seen.has(c.surface)) continue;
      seen.add(c.surface);
      const text = summarize(c, maxChars);
      if (text) entries.push(`• ${SURFACE_LABELS[c.surface] ?? c.surface}: ${text}`);
    }
    if (entries.length === 0) return '';
    return [
      "[CONTESTO DA ALTRE SCHEDE DELL'EDITOR — stesso workspace]",
      "Cosa l'utente stava facendo nelle altre schede. Usa SOLO se pertinente alla richiesta corrente; non citarlo se irrilevante.",
      ...entries,
    ].join('\n');
  } catch {
    return ''; // fail-soft: il contesto non deve MAI rompere la chat
  }
}
