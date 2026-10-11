/**
 * Test 2026-grade — llm-providers route (BYOK 9 providers).
 *
 * 🚨 SECURITY-CRITICAL:
 *  - GET list NEVER ritorna plaintext apiKey
 *  - requireRole('editor') su tutte le write op
 *  - Provider name strict validation contro lista whitelist
 *
 * 🚨 INPUT VALIDATION (Zod):
 *  - apiKey max 2000
 *  - defaultModel max 200
 *  - baseUrl URL valid or empty string (custom: z.url() or z.literal(''))
 *
 * 🚨 TENANT PREFERENCES:
 *  - defaultLlmProvider: string | null (clear)
 *  - effective field computed (effectiveDefaultLlmProvider)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { Hono } from 'hono';

const listMock = vi.fn();
const upsertMock = vi.fn();
const removeMock = vi.fn();
const getMock = vi.fn();
class LlmProvidersServiceMock {
  list = listMock;
  upsert = upsertMock;
  remove = removeMock;
  get = getMock;
}
vi.mock('@/services/llm-providers.service.js', () => ({
  LlmProvidersService: LlmProvidersServiceMock,
  // 'ollama' incluso (allineato al reale): senza, i test SSRF su /llm/ollama
  // davano 400 per "provider non valido" invece che per il refine baseUrl = green-fake.
  SUPPORTED_PROVIDERS: [
    'anthropic',
    'openai',
    'google',
    'deepseek',
    'xai',
    'openrouter',
    'perplexity',
    'mistral',
    'groq',
    'ollama',
  ] as const,
}));

const prefsGetMock = vi.fn();
const prefsSetMock = vi.fn();
const resolveDefaultProviderMock = vi.fn();
class TenantAiPreferencesServiceMock {
  get = prefsGetMock;
  set = prefsSetMock;
  resolveDefaultProvider = resolveDefaultProviderMock;
}
vi.mock('@/services/tenant-ai-preferences.service.js', () => ({
  TenantAiPreferencesService: TenantAiPreferencesServiceMock,
}));

vi.mock('@/middleware/rbac.js', () => ({
  requireRole:
    (role: string) =>
    async (c: { get: (k: string) => { role?: string } | undefined }, next: () => Promise<void>) => {
      const auth = c.get('auth');
      if (!auth)
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      const userRole = auth.role ?? 'viewer';
      const roleHierarchy = ['viewer', 'editor', 'admin', 'owner', 'superadmin'];
      const userLevel = roleHierarchy.indexOf(userRole);
      const requiredLevel = roleHierarchy.indexOf(role);
      if (userLevel < requiredLevel) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return next();
    },
}));

const dispatchLLMForTestMock = vi.fn();
vi.mock('../services/llm-test.service.js', () => ({
  dispatchLLMForTest: dispatchLLMForTestMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));
vi.mock('@/lib/actor.js', () => ({
  getActorId: () => 'actor-1',
}));

const { createLlmProvidersRoutes } = await import('./llm-providers.js');

function makeApp(role: 'viewer' | 'editor' | 'admin' | 'owner' | 'superadmin' = 'editor'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { role, userId: 'u1' } as never);
    return next();
  });
  app.route('/llm', createLlmProvidersRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockReturnValue([]);
  prefsGetMock.mockReturnValue({ defaultLlmProvider: null });
  resolveDefaultProviderMock.mockReturnValue(null);
});

describe('🚨 GET / — list providers (SECURITY: never plaintext key)', () => {
  it('🚨 ritorna lista providers da service', async () => {
    listMock.mockReturnValue([
      { provider: 'anthropic', hasKey: true, defaultModel: 'claude-3-5' },
      { provider: 'openai', hasKey: false },
    ]);
    const res = await makeApp('viewer').request('/llm');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { providers: { provider: string; hasKey: boolean }[] };
    expect(json.providers).toHaveLength(2);
    expect(listMock).toHaveBeenCalledWith('tenant-A');
  });

  it('🚨 viewer può LEGGERE (no rbac sul GET)', async () => {
    const res = await makeApp('viewer').request('/llm');
    expect(res.status).toBe(200);
  });
});

describe('🚨 GET /preferences', () => {
  it('🚨 ritorna la preferenza e il default effettivo, e nient’altro', async () => {
    prefsGetMock.mockReturnValue({ defaultLlmProvider: 'anthropic' });
    resolveDefaultProviderMock.mockReturnValue('anthropic');
    listMock.mockReturnValue([{ provider: 'anthropic', hasKey: true }]);

    const res = await makeApp('viewer').request('/llm/preferences');
    expect(res.status).toBe(200);
    // Le chiavi sono esattamente queste: nessun interruttore di un provider
    // «di casa», che non esiste.
    expect(await res.json()).toEqual({
      defaultLlmProvider: 'anthropic',
      effectiveDefaultLlmProvider: 'anthropic',
    });
  });

  it('🚨 nessun provider configurato → il default effettivo è null, non un ripiego', async () => {
    const res = await makeApp('viewer').request('/llm/preferences');
    expect(await res.json()).toEqual({
      defaultLlmProvider: null,
      effectiveDefaultLlmProvider: null,
    });
  });

  it('🚨 resolveDefaultProvider riceve SOLO provider con hasKey:true', async () => {
    listMock.mockReturnValue([
      { provider: 'anthropic', hasKey: true },
      { provider: 'openai', hasKey: false },
      { provider: 'google', hasKey: true },
    ]);
    await makeApp('viewer').request('/llm/preferences');
    const arg = resolveDefaultProviderMock.mock.calls[0]![1] as { provider: string }[];
    expect(arg).toEqual([
      { provider: 'anthropic', hasKey: true },
      { provider: 'google', hasKey: true },
    ]);
  });
});

describe('🚨 PUT /preferences (editor required)', () => {
  it('🚨 SECURITY: viewer → 403', async () => {
    const res = await makeApp('viewer').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultLlmProvider: 'openai' }),
    });
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 200 + patch applicato', async () => {
    const res = await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultLlmProvider: 'openai' }),
    });
    expect(res.status).toBe(200);
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', { defaultLlmProvider: 'openai' });
  });

  it('🚨 defaultLlmProvider=null → clear preference', async () => {
    const res = await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultLlmProvider: null }),
    });
    expect(res.status).toBe(200);
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', { defaultLlmProvider: null });
  });

  it('🚨 defaultLlmProvider stringa max 40 char enforced', async () => {
    const res = await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultLlmProvider: 'x'.repeat(41) }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 un campo che non esiste più viene ignorato: non entra nel patch', async () => {
    await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campoDismesso: true }),
    });
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', {});
  });

  it('🚨 body vuoto {} → patch vuoto (no error)', async () => {
    const res = await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', {});
  });
});

describe('🚨 PUT /:provider — upsert', () => {
  it('🚨 SECURITY: viewer → 403', async () => {
    const res = await makeApp('viewer').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-xxx' }),
    });
    expect(res.status).toBe(403);
  });

  it('🚨 happy: editor + provider valido → upsert + 200', async () => {
    const res = await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-real', defaultModel: 'claude-3-5' }),
    });
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      'tenant-A',
      'anthropic',
      expect.objectContaining({
        apiKey: 'sk-ant-real',
        defaultModel: 'claude-3-5',
        actorId: 'actor-1',
      }),
    );
  });

  describe('🔴 SSRF — baseUrl custom (BYOK Ollama/proxy) bloccato verso host interni', () => {
    const INTERNAL = [
      'http://172.20.0.1:6379', // Redis/Dragonfly su flowforge-net
      'http://172.20.0.1:3006', // portal gateway interno
      'http://127.0.0.1:8080', // loopback runtime
      'http://localhost:11434', // Ollama-locale: non ha senso nel cloud
      'http://169.254.169.254/latest/meta-data/', // cloud metadata (IMDS)
      'http://10.0.0.5', // RFC1918
      'http://192.168.1.1', // RFC1918
      'http://[::1]:11434', // IPv6 loopback
      'ftp://evil.example.com', // scheme non-http
    ];
    it.each(INTERNAL)('🔴 baseUrl bloccato "%s" → 400, upsert NON chiamato', async (baseUrl) => {
      const res = await makeApp('editor').request('/llm/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '', baseUrl }),
      });
      expect(res.status).toBe(400);
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('🟢 baseUrl PUBBLICO https → 200, upsert riceve il baseUrl', async () => {
      const res = await makeApp('editor').request('/llm/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '', baseUrl: 'https://ollama.example.com' }),
      });
      expect(res.status).toBe(200);
      expect(upsertMock).toHaveBeenCalledWith(
        'tenant-A',
        'ollama',
        expect.objectContaining({ baseUrl: 'https://ollama.example.com' }),
      );
    });

    it('🟢 baseUrl vuoto → 200 (nessun endpoint custom, provider a endpoint fisso)', async () => {
      const res = await makeApp('editor').request('/llm/anthropic', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-ant', baseUrl: '' }),
      });
      expect(res.status).toBe(200);
    });
  });

  it('🚨 provider NON valido → 400 con lista supportati', async () => {
    const res = await makeApp('editor').request('/llm/fake-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Supportati: anthropic, openai/u);
  });

  it('🚨 apiKey max 2000 char → 400 oltre', async () => {
    const res = await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'x'.repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 baseUrl URL valida → 200 + propagato', async () => {
    await makeApp('editor').request('/llm/openrouter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api' }),
    });
    expect(upsertMock).toHaveBeenCalledWith(
      'tenant-A',
      'openrouter',
      expect.objectContaining({
        baseUrl: 'https://openrouter.ai/api',
      }),
    );
  });

  it('🚨 baseUrl non-URL → 400', async () => {
    const res = await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k', baseUrl: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 baseUrl empty string accettato (z.literal(""))', async () => {
    const res = await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k', baseUrl: '' }),
    });
    expect(res.status).toBe(200);
    // baseUrl='' NON propagato a service (filtered)
    expect(upsertMock).toHaveBeenCalledWith(
      'tenant-A',
      'anthropic',
      expect.not.objectContaining({
        baseUrl: '',
      }),
    );
  });

  it('🚨 defaultModel empty/whitespace NON propagato', async () => {
    await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k', defaultModel: '   ' }),
    });
    expect(upsertMock).toHaveBeenCalledWith(
      'tenant-A',
      'anthropic',
      expect.not.objectContaining({
        defaultModel: expect.anything(),
      }),
    );
  });

  it('🚨 service throw → 400 con err message', async () => {
    upsertMock.mockImplementationOnce(() => {
      throw new Error('vault encrypt failed');
    });
    const res = await makeApp('editor').request('/llm/anthropic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'k' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('vault encrypt failed');
  });
});

describe('🚨 DELETE /:provider', () => {
  it('🚨 SECURITY: viewer → 403', async () => {
    const res = await makeApp('viewer').request('/llm/anthropic', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('🚨 happy: editor + valid → service.remove', async () => {
    removeMock.mockReturnValue(true);
    const res = await makeApp('editor').request('/llm/openai', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(removeMock).toHaveBeenCalledWith('tenant-A', 'openai', 'actor-1');
  });

  /**
   * `remove` è asincrono (aspetta il registro di audit). Senza attenderlo la
   * rotta rispondeva `{ ok: {} }` — una promessa serializzata — e chi chiamava
   * non poteva distinguere «tolto» da «non c'era».
   */
  it('🚨 la risposta dice se qualcosa è stato tolto davvero', async () => {
    removeMock.mockResolvedValue(true);
    const tolto = await makeApp('editor').request('/llm/openai', { method: 'DELETE' });
    expect(await tolto.json()).toEqual({ ok: true });

    removeMock.mockResolvedValue(false);
    const assente = await makeApp('editor').request('/llm/openai', { method: 'DELETE' });
    expect(await assente.json()).toEqual({ ok: false });
  });

  it('🚨 nessun provider è protetto dalla cancellazione: chi l’ha configurato lo può togliere', async () => {
    removeMock.mockReturnValue(true);
    for (const p of ['anthropic', 'ollama', 'groq']) {
      const res = await makeApp('editor').request(`/llm/${p}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    }
    expect(removeMock).toHaveBeenCalledTimes(3);
  });

  it('🚨 provider NON valido → 400', async () => {
    const res = await makeApp('editor').request('/llm/fake', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('🚨 un provider che non esiste più → 400, e niente viene cancellato', async () => {
    const res = await makeApp('editor').request('/llm/provider-dismesso', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('🚨 POST /:provider/test', () => {
  it('🚨 SECURITY: viewer → 403', async () => {
    const res = await makeApp('viewer').request('/llm/anthropic/test', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('🚨 provider NON valido → 400', async () => {
    const res = await makeApp('editor').request('/llm/fake/test', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  /**
   * Senza una configurazione salvata non c'è niente da provare, per NESSUN
   * provider: una prova che partisse lo stesso andrebbe verso un servizio
   * senza chiave, e direbbe «funziona» o «non funziona» di qualcosa che il
   * tenant non ha.
   */
  it.each(['anthropic', 'openai', 'ollama'])(
    '🚨 %s senza config → 404, e nessuna prova parte',
    async (p) => {
      getMock.mockReturnValue(null);
      const res = await makeApp('editor').request(`/llm/${p}/test`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(dispatchLLMForTestMock).not.toHaveBeenCalled();
    },
  );

  it('🚨 happy: dispatch ok → ok:true + durationMs + sample (200 char max)', async () => {
    getMock.mockReturnValue({ provider: 'anthropic', apiKey: 'sk' });
    dispatchLLMForTestMock.mockResolvedValueOnce('x'.repeat(500));
    const res = await makeApp('editor').request('/llm/anthropic/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; durationMs: number; sample: string };
    expect(json.ok).toBe(true);
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
    expect(json.sample).toHaveLength(200); // truncated
  });

  it('🚨 dispatch throw → 502 + ok:false', async () => {
    getMock.mockReturnValue({ provider: 'anthropic', apiKey: 'sk' });
    dispatchLLMForTestMock.mockRejectedValueOnce(new Error('401 Unauthorized'));
    const res = await makeApp('editor').request('/llm/anthropic/test', { method: 'POST' });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('401 Unauthorized');
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('🚨 dispatch throw non-Error → coerced a String', async () => {
    getMock.mockReturnValue({ provider: 'anthropic', apiKey: 'sk' });
    dispatchLLMForTestMock.mockRejectedValueOnce('plain-string-fail');
    const res = await makeApp('editor').request('/llm/anthropic/test', { method: 'POST' });
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('plain-string-fail');
  });
});
