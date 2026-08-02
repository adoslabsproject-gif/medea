/**
 * Bug-bounty CANCEL dell'agent tool-loop (fix 2026-06-17). Un agente con loop lungo
 * ignorava il cancel del run fino a maxIterations×timeout. Ora controlla
 * ctx.abortSignal a OGNI iterazione → si ferma prima della prossima chiamata LLM.
 */
import { describe, it, expect, vi } from 'vitest';

// La fetch LLM passa per safeFetchWithRedirects (via gatewayFetch). La spiamo per
// provare che con signal abortito NON viene MAI chiamata (cancel cooperativo reale).
const safeFetch = vi.fn(async () => { throw new Error('NON deve essere chiamata: cancel mancato'); });
vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({
  // helper di lettura body REALI (puri); mockiamo solo la fetch (spiata).
  ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock('@medea/engine-nodes-stdlib', async (orig) => {
  const actual = await orig<typeof import('@medea/engine-nodes-stdlib')>();
  return { ...actual, executeWithHostBreaker: (_url: string, fn: () => unknown) => fn() };
});

const { agentToolLoopNode } = await import('./tool-loop.js');

const baseCtx = { tenantId: 't1', runId: 'r1', nodeId: 'n1', workflowId: 'w1', logger: { info() {}, warn() {}, error() {} } };

describe('🚨 agent tool-loop — cancel cooperativo', () => {
  it('🚨 abortSignal GIÀ abortito → ritorna cancelled SENZA chiamare l\'LLM', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await agentToolLoopNode.executor!(
      { apiKey: 'sk-test', goal: 'fai qualcosa di lungo', maxIterations: '10' },
      undefined,
      { ...baseCtx, abortSignal: ac.signal } as never,
    );
    const out = (r as { output: { cancelled?: boolean; error?: string; iterations?: number } }).output;
    expect(out.cancelled).toBe(true);
    expect(out.error).toMatch(/annullato|cancellato/i);
    expect(out.iterations).toBe(0);
    expect(safeFetch).not.toHaveBeenCalled(); // niente chiamata LLM dopo il cancel
  });

  // Fase 2 (#14): senza apiKey NON è più un errore — il default è Liara via
  // gateway (decisione owner: "Liara-da-settings di default"). Il vecchio
  // contratto "apiKey required" resta SOLO per provider=anthropic esplicito.
  it('🔒 senza apiKey → NIENTE errore apiKey: parte il loop OpenAI-format verso Liara', async () => {
    // il fetch qui THROWA per design del mock → l'esito è un errore di rete,
    // MAI il vecchio "apiKey required".
    const r = await agentToolLoopNode.executor!({ goal: 'x' }, undefined, baseCtx as never);
    const out = (r as { output: { error?: string } }).output;
    expect(out.error).toBeDefined();
    expect(out.error).not.toMatch(/apiKey required/i);
    expect(safeFetch).toHaveBeenCalled();
  });

  it('🔒 Settings→anthropic con key VUOTA → errore apiKey chiaro (guard difensiva intatta)', async () => {
    const ctxWithEmptyAnthropicKey = { ...baseCtx, llmProviders: { anthropic: { apiKey: '' } } };
    const r = await agentToolLoopNode.executor!({ provider: 'anthropic', goal: 'x' }, undefined, ctxWithEmptyAnthropicKey as never);
    expect((r as { output: { error?: string } }).output.error).toMatch(/apiKey/i);
  });

  const okReply = (body: unknown) => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => body, text: async () => JSON.stringify(body),
  });

  it('🚨 il segnale di cancel È PASSATO al fetch LLM (abort in volo, non attende il timeout)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    safeFetch.mockImplementationOnce(async (..._a: unknown[]) => {
      capturedOpts = _a[1] as Record<string, unknown>;
      return okReply({ content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn' });
    });
    const ac = new AbortController();
    await agentToolLoopNode.executor!(
      { apiKey: 'sk-test', goal: 'x', maxIterations: '3' },
      undefined,
      { ...baseCtx, abortSignal: ac.signal } as never,
    );
    expect(capturedOpts?.signal).toBe(ac.signal); // pre-fix: signal NON propagato → undefined
  });

  it('🚨 abort DURANTE la chiamata LLM in volo → cancelled pulito (non rilancia)', async () => {
    const ac = new AbortController();
    safeFetch.mockImplementationOnce(async () => {
      ac.abort();
      const e = new Error('The operation was aborted'); e.name = 'AbortError';
      throw e;
    });
    const r = await agentToolLoopNode.executor!(
      { apiKey: 'sk-test', goal: 'x', maxIterations: '3' },
      undefined,
      { ...baseCtx, abortSignal: ac.signal } as never,
    );
    const out = (r as { output: { cancelled?: boolean } }).output;
    expect(out.cancelled).toBe(true); // pre-fix (no try/catch): AbortError rilanciato, non cancelled
  });

  // Guard input-rotto (review 2026-06-20): maxIterations='' → Number('')=0 → l'agente
  // non eseguiva NESSUN round e tornava "exceeded maxIterations=0". Ora → default 10.
  it('🚨 maxIterations vuoto (Number("")=0) → fallback 10, l\'agente ESEGUE (no "exceeded 0")', async () => {
    safeFetch.mockResolvedValueOnce(okReply({ content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn' }));
    const r = await agentToolLoopNode.executor!(
      { apiKey: 'sk-test', goal: 'x', maxIterations: '' },
      undefined,
      baseCtx as never,
    );
    const out = (r as { output: { finalAnswer?: string; error?: string; iterations?: number } }).output;
    // finalAnswer='fatto' (dalla risposta mockata) + iterations:1 provano che il
    // loop ha eseguito UN round produttivo (col bug avrebbe ritornato error e 0).
    expect(out.finalAnswer).toBe('fatto');
    expect(out.error).toBeUndefined();
    expect(out.iterations).toBe(1);
  });
});
