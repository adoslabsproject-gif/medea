/**
 * Test end-to-end del path STREAMING di /node-generator/generate.
 *
 * A differenza di node-generator.test.ts (che mocka NodeGeneratorService), qui
 * usiamo il SERVIZIO REALE + il REALE ResolvedLLMProvider → esercitiamo:
 *   route SSE → service.generateStream → provider.stream (bridge push→pull) →
 *   dispatchLLMChatStreaming (stubbato).
 * Così il ponte coda+wake-up (ordine dei delta, nessun chunk perso, propagazione
 * errori) è verificato davvero, non simulato. Lo schema NodeDef è quello REALE
 * (@flowforge/core-schema) → il parse/validazione/safety-gate gira sul serio.
 */
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
const streamingMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn(() => 'interaction-1'));
const rateLimitMiddleware = vi.hoisted(() => vi.fn(() => async (_c: unknown, next: () => Promise<void>) => { await next(); }));

vi.mock('@/services/llm-resolver.service.js', () => {
  class NoLlmProviderError extends Error {
    httpStatus = 400;
    constructor(msg: string, status?: number) { super(msg); if (status) this.httpStatus = status; }
  }
  return { llmResolver: { resolve: resolveMock }, NoLlmProviderError };
});

vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChatStreaming: streamingMock,
  dispatchLLMChat: completeMock,
}));

vi.mock('@/services/ai-interactions.service.js', () => ({
  AIInteractionsService: vi.fn(() => ({ insert: insertMock })),
}));

vi.mock('@/middleware/rate-limit.js', () => ({ llmRateLimit: rateLimitMiddleware }));
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'tenant-1' }));
vi.mock('@/lib/logger.js');

const { createNodeGeneratorRoutes } = await import('./node-generator.js');

function makeApp() {
  const app = new Hono();
  // Auth iniettata: la route è owner-only (requireRole('owner'), commit ad59a8a0) e
  // l'attribuzione userId viene dal JWT (c.get('auth').userId, commit 68dca742) — NON più
  // dall'header x-user-id (spoofabile). Senza questo middleware la route risponde 401 prima
  // dello stream (era la causa degli 8 test rossi).
  app.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'user-7', tenantId: 'tenant-1', role: 'owner' } as never);
    await next();
  });
  app.route('/', createNodeGeneratorRoutes());
  return app;
}

/** NodeDef VALIDO (schema reale) serializzato in JSON fence — splittabile in chunk. */
const VALID_NODE = {
  def: {
    id: 'action_stripe_charge',
    type: 'action',
    label: 'Stripe Charge',
    icon: 'credit-card',
    color: '#635bff',
    description: 'Create a charge via Stripe API.',
    configFields: [
      { key: 'amount', label: 'Amount', type: 'number', required: true },
    ],
    vendor: 'third-party',
    version: '1.0.0',
  },
  executorSource: "async function execute(config, input, context) { const r = await fetch('https://api.stripe.com/v1/charges'); return { output: await r.json(), durationMs: 0 }; }",
  rationale: 'Stripe REST API.',
  warnings: ['no idempotency key'],
};
const VALID_RAW = '```json\n' + JSON.stringify(VALID_NODE, null, 2) + '\n```';

/** Spezza una stringa in `n` chunk ~uguali (simula i delta del modello). */
function chunkify(s: string, n: number): string[] {
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Stub dispatchLLMChatStreaming: invoca onChunk per ogni delta poi risolve. */
function emitChunks(chunks: string[]) {
  streamingMock.mockImplementation(async (...args: unknown[]) => {
    const onChunk = args[7] as (d: string) => void;
    for (const ch of chunks) onChunk(ch);
    return chunks.join('');
  });
}

/** Parsa il testo SSE in eventi {event, data}. */
function parseSse(text: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (ev && dataLine !== undefined) out.push({ event: ev, data: JSON.parse(dataLine) });
  }
  return out;
}

async function postStream(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = makeApp();
  const res = await app.request('/node-generator/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ stream: true, ...body }),
  });
  return { res, events: parseSse(await res.text()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock.mockReturnValue({ provider: 'liara', apiKey: 'key', model: 'qwen3-32b' });
  insertMock.mockReturnValue('interaction-1');
});

describe('🚨 streaming SSE — happy path (bridge reale)', () => {
  it('🚨 delta in ORDINE + done col nodo parsato + interactionId', async () => {
    const chunks = chunkify(VALID_RAW, 12);
    emitChunks(chunks);
    const { events } = await postStream({ description: 'crea nodo Stripe charge' });

    const deltas = events.filter((e) => e.event === 'delta');
    const dones = events.filter((e) => e.event === 'done');
    expect(events.some((e) => e.event === 'error')).toBe(false);

    // bridge non perde né riordina: concat dei delta == raw originale
    const reassembled = deltas.map((e) => (e.data as { text: string }).text).join('');
    expect(reassembled).toBe(VALID_RAW);

    expect(dones).toHaveLength(1);
    const done = dones[0]!.data as { node: { def: { id: string } }; interactionId: string };
    expect(done.node.def.id).toBe('action_stripe_charge');
    expect(done.interactionId).toBe('interaction-1');
  });

  it('🚨 molti chunk piccoli (stress della coda) → nessun delta perso', async () => {
    const chunks = chunkify(VALID_RAW, VALID_RAW.length); // 1 char per chunk
    emitChunks(chunks);
    const { events } = await postStream({ description: 'crea nodo Stripe charge' });
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas).toHaveLength(chunks.filter((ch) => ch.length > 0).length);
    expect(deltas.map((e) => (e.data as { text: string }).text).join('')).toBe(VALID_RAW);
  });

  it('🚨 interaction registrata con tenantId + userId DA AUTH JWT + model label', async () => {
    emitChunks(chunkify(VALID_RAW, 5));
    // userId viene da c.get('auth').userId (iniettato in makeApp), NON dall'header x-user-id.
    await postStream({ description: 'crea nodo Stripe charge' });
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      context: { tenantId: 'tenant-1', userId: 'user-7' },
      interactionType: 'node_generate',
      response: expect.objectContaining({ model: 'liara/qwen3-32b' }),
    }));
  });
});

describe('🚨 streaming SSE — error mapping', () => {
  it('🚨 output NON valido (JSON rotto) → event error (status 500)', async () => {
    emitChunks(['questo non e\\ ', 'json valido']);
    const { events } = await postStream({ description: 'descrizione abbastanza lunga' });
    const err = events.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect((err!.data as { status: number }).status).toBe(500);
    expect(events.some((e) => e.event === 'done')).toBe(false);
    // niente audit su fallimento
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('🚨 executor con token vietati → "forbidden" → status 422', async () => {
    const evil = { ...VALID_NODE, executorSource: 'async function execute(c,i,x){ return process.env.SECRET; }' };
    emitChunks(['```json\n' + JSON.stringify(evil) + '\n```']);
    const { events } = await postStream({ description: 'descrizione abbastanza lunga' });
    const err = events.find((e) => e.event === 'error');
    expect((err!.data as { status: number }).status).toBe(422);
  });

  it('🚨 dispatcher REJECTS (Liara down) → errore propagato dal bridge → event error', async () => {
    streamingMock.mockRejectedValue(new Error('Liara 500: upstream'));
    const { events } = await postStream({ description: 'descrizione abbastanza lunga' });
    const err = events.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect((err!.data as { error: string }).error).toMatch(/Liara 500/u);
  });
});

describe('🚨 streaming SSE — guardie a monte invariate', () => {
  it('🚨 zod: description < 10 char → 400 (no SSE)', async () => {
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'short', stream: true }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 NoLlmProviderError (quota) → 402 JSON, lo stream non parte', async () => {
    const { NoLlmProviderError } = await import('@/services/llm-resolver.service.js');
    resolveMock.mockImplementation(() => { throw new NoLlmProviderError('Quota exceeded', 402); });
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'descrizione abbastanza lunga', stream: true }),
    });
    expect(res.status).toBe(402);
    expect(streamingMock).not.toHaveBeenCalled();
  });
});
