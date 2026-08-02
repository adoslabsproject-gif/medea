/**
 * Test 2026-grade — node-generator route.
 *
 * 🚨 PROVIDER-AGNOSTIC: NESSUN hardcoding vendor. llmResolver decide:
 *   header x-llm-provider OR tenant default OR Liara fallback.
 *   NoLlmProviderError → httpStatus dichiarato dall'errore.
 *
 * 🚨 RATE LIMIT: middleware llmRateLimit('node-generator') applicato
 *   PRIMA del Zod parse.
 *
 * 🚨 ZOD VALIDATION: description 10-2000 char (anti zero-input + anti spam),
 *   openApiUrl deve essere URL valida, language solo it/en.
 *
 * 🚨 ERROR STATUS MAP: "forbidden" o "validation" nel msg → 422
 *   (client error), altri → 500.
 *
 * 🚨 AI INTERACTIONS LOG: ogni successo SCRITTO in ai_interactions
 *   per audit + analytics.
 */
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonBody } from '@/lib/test-json-body.js';

const resolveMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const generateMock = vi.hoisted(() => vi.fn());
const insertMock = vi.hoisted(() => vi.fn(() => 'interaction-1'));
const rateLimitMiddleware = vi.hoisted(() => vi.fn(() => async (_c: unknown, next: () => Promise<void>) => { await next(); }));

vi.mock('@/services/llm-resolver.service.js', () => {
  class NoLlmProviderError extends Error {
    httpStatus = 400;
    constructor(msg: string, status?: number) {
      super(msg);
      if (status) this.httpStatus = status;
    }
  }
  return {
    llmResolver: { resolve: resolveMock },
    NoLlmProviderError,
  };
});

vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: dispatchMock,
}));

vi.mock('@/services/node-generator.service.js', () => ({
  NodeGeneratorService: vi.fn(() => ({ generate: generateMock })),
}));

vi.mock('@/services/ai-interactions.service.js', () => ({
  AIInteractionsService: vi.fn(() => ({ insert: insertMock })),
}));

vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: rateLimitMiddleware,
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-1',
}));

vi.mock('@/lib/logger.js');

const { createNodeGeneratorRoutes } = await import('./node-generator.js');

// La route è owner-only (requireRole('owner')) + l'attore dell'attribuzione AI
// arriva dal context `auth` (JWT), NON dall'header x-user-id (spoofabile).
// L'harness inietta un auth owner; passando null si testa il rifiuto 401/403.
function makeApp(auth: { userId?: string; role?: string; tenantId?: string } | null = { userId: 'owner-user', role: 'owner', tenantId: 'tenant-1' }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) (c as unknown as { set: (k: string, v: unknown) => void }).set('auth', auth);
    return next();
  });
  app.route('/', createNodeGeneratorRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock.mockReset();
  generateMock.mockReset();
  dispatchMock.mockReset();
  insertMock.mockClear();
  insertMock.mockReturnValue('interaction-1');
  resolveMock.mockReturnValue({ provider: 'liara', apiKey: 'key', model: 'qwen3-32b' });
});

describe('🚨 Zod validation', () => {
  it('🚨 description < 10 char → 400', async () => {
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'short' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 description > 2000 char → 400 (anti spam)', async () => {
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 openApiUrl non URL valida → 400', async () => {
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'description with enough length here',
        openApiUrl: 'not-a-url',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 language invalida (es: "fr") → 400', async () => {
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'description with enough length here',
        language: 'fr',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('🚨 provider resolution', () => {
  it('🚨 header x-llm-provider + x-llm-api-key forwardati a resolve', async () => {
    generateMock.mockResolvedValue({ def: { id: 'gen-node' } });
    const app = makeApp();
    await app.request('/node-generator/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-llm-provider': 'anthropic',
        'x-llm-api-key': 'sk-ant-key',
        'x-user-id': 'user-1',
      },
      body: JSON.stringify({ description: 'crea nodo che chiama Stripe API' }),
    });
    expect(resolveMock).toHaveBeenCalledWith('tenant-1', {
      headerApiKey: 'sk-ant-key',
      requestedProvider: 'anthropic',
    });
  });

  it('🚨 NoLlmProviderError → httpStatus dall\'errore (es. 402 quota exceeded)', async () => {
    const { NoLlmProviderError } = await import('@/services/llm-resolver.service.js');
    resolveMock.mockImplementation(() => {
      throw new NoLlmProviderError('Quota exceeded', 402);
    });
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(402);
  });

  it('🚨 NoLlmProviderError default status 400', async () => {
    const { NoLlmProviderError } = await import('@/services/llm-resolver.service.js');
    resolveMock.mockImplementation(() => {
      throw new NoLlmProviderError('No provider config');
    });
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 errore generico nel resolve → throw → 500 (Hono error handler)', async () => {
    resolveMock.mockImplementation(() => {
      throw new TypeError('Unexpected');
    });
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('🚨 generate happy path', () => {
  it('🚨 success → 200 + node + interactionId', async () => {
    generateMock.mockResolvedValue({
      def: { id: 'action_stripe_charge', label: 'Stripe Charge' },
      executor: '...',
    });
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'crea nodo che chiama Stripe charge API',
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.node).toBeDefined();
    expect(body.interactionId).toBe('interaction-1');
  });

  it('🚨 AI interaction: userId dall\'AUTH context (NON dall\'header x-user-id spoofabile)', async () => {
    generateMock.mockResolvedValue({ def: { id: 'x' } });
    const app = makeApp({ userId: 'owner-real', role: 'owner', tenantId: 'tenant-1' });
    await app.request('/node-generator/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'attacker-spoof', // deve essere IGNORATO
      },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    // mutation-verify: l'attribuzione usa l'auth (owner-real), non l'header spoofato.
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      context: { tenantId: 'tenant-1', userId: 'owner-real' },
      interactionType: 'node_generate',
    }));
  });

  it('🚨 senza auth → 401 (requireRole owner) e nessuna generazione', async () => {
    const app = makeApp(null);
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect([401, 403]).toContain(res.status);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('🚨 AI interaction model field = provider/model concat', async () => {
    resolveMock.mockReturnValue({ provider: 'openai', apiKey: 'k', model: 'gpt-4o' });
    generateMock.mockResolvedValue({ def: { id: 'x' } });
    const app = makeApp();
    await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({ model: 'openai/gpt-4o' }),
    }));
  });
});

describe('🚨 error status mapping', () => {
  it('🚨 "forbidden" nel msg → 422 (client error)', async () => {
    generateMock.mockRejectedValue(new Error('Operation forbidden by policy'));
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(422);
  });

  it('🚨 "validation" nel msg → 422', async () => {
    generateMock.mockRejectedValue(new Error('validation failed'));
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(422);
  });

  it('🚨 errore generico → 500', async () => {
    generateMock.mockRejectedValue(new Error('LLM crashed'));
    const app = makeApp();
    const res = await app.request('/node-generator/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'long enough description here' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('🚨 rate limit middleware applicato', () => {
  it('🚨 llmRateLimit invocato con bucket "node-generator" alla creazione route', async () => {
    rateLimitMiddleware.mockClear();
    makeApp();
    expect(rateLimitMiddleware).toHaveBeenCalledWith('node-generator');
  });
});
