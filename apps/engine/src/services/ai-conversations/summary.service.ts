/**
 * Summary Compaction Service — folds older conversation turns into a compact
 * summary stored on ai_conversations.summary.
 *
 * Obiettivo: compattazione "alla Claude Code" — al RIEMPIMENTO del contesto
 * (token-based, non a conteggio messaggi), preservando un riassunto DENSO e
 * STRUTTURATO che permette di proseguire il lavoro senza perdere lo stato.
 *
 * Trigger:
 *   - Chiamata fire-and-forget dopo ogni turno assistant.
 *   - `needsCompaction(id, { maxContextTokens })` → true quando i token VIVI
 *     superano la soglia (~75% della finestra del modello).
 *
 * Fold (TOKEN-based + convergente):
 *   - Tiene gli ULTIMI messaggi che stanno in un budget di token (finestra viva
 *     ad alta fedeltà) e folda tutto il prefisso più vecchio. Dopo il fold i
 *     messaggi vivi pesano ~keepBudget << soglia → la conversazione CONVERGE
 *     (niente loop di ri-summary, niente overflow su chat poche-ma-pesanti).
 *
 * Summary:
 *   - Prompt strutturato in sezioni; lunghezza target DINAMICA (scala con la
 *     finestra, cap a SUMMARY_MAX_TOKENS), nella lingua dell'utente.
 *   - Rolling: incorpora il summary precedente nel nuovo.
 *
 * Idempotency: soft lock via summary_at — se compattata negli ultimi 30s, skip.
 */

import { conversationService } from './conversation.service.js';
import { logger } from '@/lib/logger.js';
import { dispatchLLMChat } from '@/services/llm-chat.service.js';
import type { AiMessageRow } from './types.js';

const SUMMARY_LOCK_MS = 30_000;
const CHARS_PER_TOKEN = 3.5;

/** Frazione della soglia di contesto tenuta INTERA (finestra viva ad alta fedeltà). */
const KEEP_RECENT_FRACTION = 0.35;
/** Budget di "tenuto intero" quando la soglia non è nota (fallback). */
const DEFAULT_KEEP_TOKENS = 4000;

/** Lunghezza target del summary: scala con la finestra, dentro [MIN, MAX]. */
const SUMMARY_MIN_TOKENS = 500;
const SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_FRACTION = 0.08;
/** Finestra di riferimento quando la soglia non è nota (fallback ≈ Qwen3 40960*0.75). */
const FALLBACK_CONTEXT_TOKENS = 30720;

/** Stima dei token di un messaggio: provider-reported se presente, altrimenti char/3.5. */
export function estimateMsgTokens(m: Pick<AiMessageRow, 'content' | 'tokens'>): number {
  return m.tokens != null ? Number(m.tokens) : Math.ceil(m.content.length / CHARS_PER_TOKEN);
}

/** Target (in token) del summary in funzione della soglia di contesto. Pura. */
export function summaryTargetTokens(maxContextTokens?: number): number {
  const base = maxContextTokens && maxContextTokens > 0 ? maxContextTokens : FALLBACK_CONTEXT_TOKENS;
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.floor(base * SUMMARY_FRACTION)));
}

/**
 * Prefisso (più vecchio, in ordine cronologico) da FOLDARE: tiene gli ultimi
 * messaggi che stanno entro `keepBudget` token e folda tutto ciò che precede.
 * Tiene SEMPRE almeno l'ultimo messaggio (anche se da solo supera il budget).
 * Pura → testabile. Convergente: i messaggi tenuti pesano ≤ keepBudget (+1 msg).
 */
export function selectFoldablePrefix(messages: AiMessageRow[], keepBudget: number): AiMessageRow[] {
  if (messages.length <= 1) return [];
  let acc = 0;
  let keepFrom = messages.length; // index del primo messaggio da TENERE intero
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const t = estimateMsgTokens(messages[i]!);
    // Tieni sempre l'ULTIMO messaggio; per gli altri rispetta il budget.
    if (i < messages.length - 1 && acc + t > keepBudget) break;
    acc += t;
    keepFrom = i;
  }
  return messages.slice(0, keepFrom);
}

/** Prompt di sistema strutturato (sezioni), lunghezza target dinamica. */
function buildSummarySystemPrompt(targetTokens: number): string {
  return (
    `Sei un compattatore di conversazioni per un assistente di automazione workflow. ` +
    `Comprimi la chat precedente in un riassunto DENSO e FEDELE, nella STESSA lingua ` +
    `dell'utente, che permetta di proseguire il lavoro senza perdere lo stato. ` +
    `Scrivi in terza persona. Output SOLO il testo del riassunto: niente preamboli, ` +
    `niente markdown, niente virgolette. Massimo ~${targetTokens.toString()} token.\n\n` +
    `Copri, quando presenti, queste sezioni (ometti quelle vuote):\n` +
    `1. Obiettivo dell'utente: cosa vuole costruire/ottenere nel workflow.\n` +
    `2. Stato del workflow: nodi e collegamenti decisi, configurazioni concordate.\n` +
    `3. Decisioni e vincoli: scelte fatte, requisiti, preferenze esplicite.\n` +
    `4. Problemi e fix: errori incontrati e come sono stati risolti.\n` +
    `5. In sospeso: blocchi aperti, dubbi non risolti, prossimo passo atteso.\n` +
    `6. Provider/strumenti preferiti e ogni dettaglio tecnico critico (id, nomi, valori).`
  );
}

/**
 * Attempt to summarize a conversation if eligible. Safe to call frequently —
 * internal idempotency guard prevents thrashing.
 */
export async function trySummarize(
  conversationId: string,
  provider: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
  opts: { maxContextTokens?: number } = {},
): Promise<{ summarized: boolean; reason?: string }> {
  const conv = conversationService.getById(conversationId);
  if (!conv) return { summarized: false, reason: 'not_found' };

  // Soft lock: skip if just summarized.
  if (conv.summaryAt) {
    const sinceSummary = Date.now() - new Date(conv.summaryAt).getTime();
    if (sinceSummary < SUMMARY_LOCK_MS) return { summarized: false, reason: 'cooldown' };
  }

  // Stessa soglia (token-based) usata dal gate in ai-assistant: il job di
  // summary deve ricontrollarla (la conversazione può essere cambiata tra il
  // gate e l'esecuzione fire-and-forget).
  if (!conversationService.needsCompaction(conversationId, opts)) {
    return { summarized: false, reason: 'threshold_not_met' };
  }

  // FOLD token-based + convergente: tieni gli ultimi messaggi entro keepBudget,
  // folda il prefisso più vecchio. keepBudget = frazione della soglia → dopo il
  // fold i vivi scendono ben sotto la soglia (no loop, no overflow).
  const all = conversationService.getRecentMessages(conversationId, 500);
  const keepBudget = opts.maxContextTokens && opts.maxContextTokens > 0
    ? Math.floor(opts.maxContextTokens * KEEP_RECENT_FRACTION)
    : DEFAULT_KEEP_TOKENS;
  const toFold = selectFoldablePrefix(all, keepBudget);
  if (toFold.length === 0) return { summarized: false, reason: 'not_enough_to_fold' };

  const previousSummary = conv.summary
    ? `Riassunto precedente:\n${conv.summary}\n\n`
    : '';
  const turnsBlock = toFold
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  const userPrompt = `${previousSummary}Nuovi turni da incorporare:\n\n${turnsBlock}\n\nScrivi ora il riassunto aggiornato e condensato.`;

  let summary: string;
  try {
    const baseUrlOrUndefined = baseUrl ?? undefined;
    summary = (await dispatchLLMChat(
      provider,
      apiKey,
      model,
      buildSummarySystemPrompt(summaryTargetTokens(opts.maxContextTokens)),
      userPrompt,
      baseUrlOrUndefined,
      [],
    )).trim();
  } catch (err) {
    logger.warn(
      { conversationId, err: err instanceof Error ? err.message : String(err) },
      '[ai-conv.summary] LLM call failed',
    );
    return { summarized: false, reason: 'llm_error' };
  }

  if (!summary || summary.length < 16) {
    logger.warn({ conversationId, summaryLength: summary.length }, '[ai-conv.summary] empty/short summary, skip');
    return { summarized: false, reason: 'empty' };
  }

  // The last message included in the fold determines the cut timestamp.
  const lastFoldedMessage = toFold[toFold.length - 1];
  if (!lastFoldedMessage) return { summarized: false, reason: 'fold_empty' };

  conversationService.applySummary(conversationId, summary, lastFoldedMessage.createdAt);
  logger.info(
    { conversationId, foldedTurns: toFold.length, keptTurns: all.length - toFold.length, summaryLength: summary.length },
    '[ai-conv.summary] applied',
  );
  return { summarized: true };
}
