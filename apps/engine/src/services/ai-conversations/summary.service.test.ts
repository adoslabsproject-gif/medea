/**
 * Test 2026-grade — trySummarize (conversation compaction).
 *
 * COOLDOWN: 30s soft lock anti-thrashing.
 * SLIDING WINDOW: last 20 turns NEVER folded (whole-fidelity).
 * IDEMPOTENT: needsCompaction guard + summaryAt timestamp.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { at } from '@/__testkit__/assert.js';

const getByIdMock = vi.fn();
const needsCompactionMock = vi.fn();
const getRecentMessagesMock = vi.fn();
const applySummaryMock = vi.fn();
vi.mock('./conversation.service.js', () => ({
  conversationService: {
    getById: getByIdMock,
    needsCompaction: needsCompactionMock,
    getRecentMessages: getRecentMessagesMock,
    applySummary: applySummaryMock,
  },
}));

const dispatchLLMChatMock = vi.fn();
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: dispatchLLMChatMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { trySummarize, selectFoldablePrefix, summaryTargetTokens, estimateMsgTokens } = await import('./summary.service.js');

type FoldMsg = Parameters<typeof selectFoldablePrefix>[0][number];
/** Helper: messaggio minimale per i test del fold (solo i campi usati). */
function msg(content: string, tokens: number | null, createdAt = 'x'): FoldMsg {
  return { role: 'user', content, tokens, createdAt } as FoldMsg;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z') });
});

describe('🚨 guards', () => {
  it('🚨 not found → reason "not_found"', async () => {
    getByIdMock.mockReturnValueOnce(undefined);
    const r = await trySummarize('cv-x', 'liara', '', '');
    expect(r).toEqual({ summarized: false, reason: 'not_found' });
  });

  it('🚨 cooldown: summarized < 30s fa → skip', async () => {
    getByIdMock.mockReturnValueOnce({
      summaryAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const r = await trySummarize('cv', 'liara', '', '');
    expect(r.reason).toBe('cooldown');
  });

  it('🚨 needsCompaction=false → threshold_not_met', async () => {
    getByIdMock.mockReturnValueOnce({});
    needsCompactionMock.mockReturnValueOnce(false);
    const r = await trySummarize('cv', 'liara', '', '');
    expect(r.reason).toBe('threshold_not_met');
  });

  it('🚨 PROPAGA la soglia token-based a needsCompaction (compaction al riempimento)', async () => {
    getByIdMock.mockReturnValueOnce({});
    needsCompactionMock.mockReturnValueOnce(false);
    await trySummarize('cv', 'liara', '', '', undefined, { maxContextTokens: 30720 });
    expect(needsCompactionMock).toHaveBeenCalledWith('cv', { maxContextTokens: 30720 });
  });

  it('🚨 senza opts: needsCompaction chiamata con {} (fallback a turni)', async () => {
    getByIdMock.mockReturnValueOnce({});
    needsCompactionMock.mockReturnValueOnce(false);
    await trySummarize('cv', 'liara', '', '');
    expect(needsCompactionMock).toHaveBeenCalledWith('cv', {});
  });

  it('🚨 messaggi che stanno tutti nel budget → not_enough_to_fold (niente da comprimere)', async () => {
    getByIdMock.mockReturnValueOnce({});
    needsCompactionMock.mockReturnValueOnce(true);
    // 15 messaggi piccoli → entrano tutti in keepBudget (default 4000) → nessun fold.
    getRecentMessagesMock.mockReturnValueOnce(
      Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `m${i}`, tokens: 5, createdAt: 'x' })),
    );
    const r = await trySummarize('cv', 'liara', '', '');
    expect(r.reason).toBe('not_enough_to_fold');
  });
});

describe('🧮 funzioni pure del fold', () => {
  it('selectFoldablePrefix: folda il prefisso vecchio, tiene gli ultimi entro budget', () => {
    // 5 msg da 100 token, budget 250 → tiene ultimi 2 (200<=250), 3° sfora → folda primi 3.
    const msgs = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 100, `t${i}`));
    const folded = selectFoldablePrefix(msgs, 250);
    expect(folded.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('selectFoldablePrefix: tiene SEMPRE almeno l\'ultimo, anche se da solo supera il budget', () => {
    const msgs = [msg('vecchio', 10, 't0'), msg('gigante', 100000, 't1')];
    const folded = selectFoldablePrefix(msgs, 50);
    expect(folded.map((m) => m.content)).toEqual(['vecchio']); // folda il vecchio, tiene il gigante
  });

  it('selectFoldablePrefix: ≤1 messaggio → [] (niente da foldare)', () => {
    expect(selectFoldablePrefix([], 100)).toEqual([]);
    expect(selectFoldablePrefix([msg('solo', 999999, 't')], 100)).toEqual([]);
  });

  it('selectFoldablePrefix: tutti dentro il budget → [] (convergenza, niente fold inutile)', () => {
    const msgs = Array.from({ length: 4 }, (_, i) => msg(`m${i}`, 10, `t${i}`));
    expect(selectFoldablePrefix(msgs, 1000)).toEqual([]);
  });

  it('estimateMsgTokens: provider-reported se presente, altrimenti char/3.5', () => {
    expect(estimateMsgTokens(msg('x', 250))).toBe(250);
    expect(estimateMsgTokens(msg('x'.repeat(35), null))).toBe(10); // ceil(35/3.5)
  });

  it('summaryTargetTokens: scala con la finestra, clampato [500, 2000]', () => {
    expect(summaryTargetTokens(30720)).toBe(2000); // 30720*0.08=2457 → cap 2000
    expect(summaryTargetTokens(10000)).toBe(800);  // 10000*0.08=800
    expect(summaryTargetTokens(1000)).toBe(500);   // 1000*0.08=80 → floor 500
    expect(summaryTargetTokens(undefined)).toBe(2000); // fallback 30720
  });
});

describe('🚨 happy fold', () => {
  beforeEach(() => {
    getByIdMock.mockReturnValue({ summary: null });
    needsCompactionMock.mockReturnValue(true);
    // 30 msg da 2000 token → keepBudget default 4000 tiene gli ultimi 2,
    // folda i primi 28 (token-based, non più "ultimi 20" a conteggio).
    getRecentMessagesMock.mockReturnValue(
      Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}`, tokens: 2000,
        createdAt: `2026-06-${(i + 1).toString().padStart(2, '0')}`,
      })),
    );
  });

  it('🚨 fold token-based (tiene ultimi 2 entro budget, folda 28) → LLM call con turnsBlock', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('Dense summary of folded turns.');
    const r = await trySummarize('cv', 'liara', 'key', 'model');
    expect(r.summarized).toBe(true);
    expect(applySummaryMock).toHaveBeenCalledWith('cv', 'Dense summary of folded turns.', expect.any(String));
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ foldedTurns: 28, keptTurns: 2 }),
      '[ai-conv.summary] applied',
    );
  });

  it('🚨 previousSummary (rolling) incluso nel prompt se present', async () => {
    getByIdMock.mockReturnValueOnce({ summary: 'Existing summary text' });
    dispatchLLMChatMock.mockResolvedValueOnce('updated summary');
    await trySummarize('cv', 'liara', 'k', 'm');
    const userPrompt = at(dispatchLLMChatMock.mock.calls, 0, 'dispatch-calls')[4] as string;
    expect(userPrompt).toContain('Riassunto precedente');
    expect(userPrompt).toContain('Existing summary text');
  });

  it('🚨 prompt di sistema STRUTTURATO (sezioni) + target token dinamico', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('long enough summary content blah');
    await trySummarize('cv', 'liara', 'k', 'm', undefined, { maxContextTokens: 30720 });
    const systemPrompt = at(dispatchLLMChatMock.mock.calls, 0, 'dispatch-calls')[3] as string;
    expect(systemPrompt).toContain('Obiettivo dell\'utente');
    expect(systemPrompt).toContain('Stato del workflow');
    expect(systemPrompt).toContain('Problemi e fix');
    expect(systemPrompt).toContain('2000 token'); // target dinamico per finestra 30720
  });

  it('🚨 LLM throw → reason "llm_error" + warn log', async () => {
    dispatchLLMChatMock.mockRejectedValueOnce(new Error('Anthropic 500'));
    const r = await trySummarize('cv', 'anthropic', 'k', 'm');
    expect(r.reason).toBe('llm_error');
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('🚨 LLM ritorna empty → reason "empty"', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('');
    const r = await trySummarize('cv', 'liara', 'k', 'm');
    expect(r.reason).toBe('empty');
  });

  it('🚨 LLM ritorna < 16 char → reason "empty"', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('short');
    const r = await trySummarize('cv', 'liara', 'k', 'm');
    expect(r.reason).toBe('empty');
  });

  it('🚨 trim risposta LLM', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('  \n  long enough summary text here  \n ');
    await trySummarize('cv', 'liara', 'k', 'm');
    expect(applySummaryMock).toHaveBeenCalledWith('cv', 'long enough summary text here', expect.any(String));
  });

  it('🚨 cut timestamp = createdAt ULTIMO messaggio folded', async () => {
    dispatchLLMChatMock.mockResolvedValueOnce('long enough summary content blah');
    await trySummarize('cv', 'liara', 'k', 'm');
    // 30 msg, fold primi 28 → cut su createdAt msg index 27 = '2026-06-28'
    const call = at(applySummaryMock.mock.calls, 0, 'apply-calls');
    expect(call[2]).toBe('2026-06-28');
  });
});

describe('🚨 cooldown over 30s', () => {
  it('🚨 summarized 31s fa → ok continue', async () => {
    getByIdMock.mockReturnValue({
      summary: null,
      summaryAt: new Date(Date.now() - 31_000).toISOString(),
    });
    needsCompactionMock.mockReturnValueOnce(true);
    getRecentMessagesMock.mockReturnValueOnce(
      Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `m${i}`, tokens: 2000, createdAt: `2026-06-${(i + 1).toString().padStart(2, '0')}` })),
    );
    dispatchLLMChatMock.mockResolvedValueOnce('long summary text valid 16+ chars');
    const r = await trySummarize('cv', 'liara', 'k', 'm');
    expect(r.summarized).toBe(true);
  });
});
