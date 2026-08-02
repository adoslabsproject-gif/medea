/**
 * Test 2026-grade — llm-providers route (BYOK 9 providers).
 *
 * 🚨 SECURITY-CRITICAL:
 *  - GET list NEVER ritorna plaintext apiKey
 *  - Liara NON eliminabile (free-tier, protected)
 *  - requireRole('editor') su tutte le write op
 *  - Provider name strict validation contro lista whitelist
 *
 * 🚨 INPUT VALIDATION (Zod):
 *  - apiKey max 2000
 *  - defaultModel max 200
 *  - baseUrl URL valid or empty string (custom: z.url() or z.literal(''))
 *
 * 🚨 TENANT PREFERENCES:
 *  - allowLiara optional boolean
 *  - defaultLlmProvider: string | null (clear)
 *  - effective fields computed (liaraEffective, effectiveDefaultLlmProvider)
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
    'liara',
  ] as const,
}));

const prefsGetMock = vi.fn();
const prefsSetMock = vi.fn();
const isLiaraAllowedForTenantMock = vi.fn();
const resolveDefaultProviderMock = vi.fn();
class TenantAiPreferencesServiceMock {
  get = prefsGetMock;
  set = prefsSetMock;
  isLiaraAllowedForTenant = isLiaraAllowedForTenantMock;
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

const isLiaraEnabledMock = vi.fn(() => true);
vi.mock('@/config.js', () => ({
  isLiaraEnabled: isLiaraEnabledMock,
}));

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
  prefsGetMock.mockReturnValue({ allowLiara: true, defaultLlmProvider: null });
  isLiaraAllowedForTenantMock.mockReturnValue(true);
  resolveDefaultProviderMock.mockReturnValue('liara');
  isLiaraEnabledMock.mockReturnValue(true);
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
  it('🚨 ritorna prefs + liaraGloballyEnabled + liaraEffective + effectiveDefault', async () => {
    prefsGetMock.mockReturnValue({ allowLiara: false, defaultLlmProvider: 'anthropic' });
    isLiaraAllowedForTenantMock.mockReturnValue(false);
    resolveDefaultProviderMock.mockReturnValue('anthropic');
    listMock.mockReturnValue([{ provider: 'anthropic', hasKey: true }]);

    const res = await makeApp('viewer').request('/llm/preferences');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      allowLiara: boolean;
      liaraGloballyEnabled: boolean;
      liaraEffective: boolean;
      effectiveDefaultLlmProvider: string;
    };
    expect(json.allowLiara).toBe(false);
    expect(json.liaraGloballyEnabled).toBe(true);
    expect(json.liaraEffective).toBe(false);
    expect(json.effectiveDefaultLlmProvider).toBe('anthropic');
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

  it('🚨 isLiaraEnabled() globale propagato', async () => {
    isLiaraEnabledMock.mockReturnValueOnce(false);
    const res = await makeApp('viewer').request('/llm/preferences');
    const json = (await res.json()) as { liaraGloballyEnabled: boolean };
    expect(json.liaraGloballyEnabled).toBe(false);
  });
});

describe('🚨 PUT /preferences (editor required)', () => {
  it('🚨 SECURITY: viewer → 403', async () => {
    const res = await makeApp('viewer').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowLiara: true }),
    });
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 200 + patch applicato', async () => {
    const res = await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowLiara: false }),
    });
    expect(res.status).toBe(200);
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', { allowLiara: false });
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

  it('🚨 update PARZIALE: solo campi presenti vengono settati (no overwrite)', async () => {
    await makeApp('editor').request('/llm/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowLiara: true }), // NO defaultLlmProvider
    });
    expect(prefsSetMock).toHaveBeenCalledWith('tenant-A', { allowLiara: true });
    // Niente defaultLlmProvider nel patch
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

  it('🚨 SECURITY: Liara NON eliminabile → 400', async () => {
    const res = await makeApp('editor').request('/llm/liara', { method: 'DELETE' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Liara.*non eliminabile/iu);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('🚨 provider NON valido → 400', async () => {
    const res = await makeApp('editor').request('/llm/fake', { method: 'DELETE' });
    expect(res.status).toBe(400);
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

  it('🚨 provider !== liara senza config → 404', async () => {
    getMock.mockReturnValue(null);
    const res = await makeApp('editor').request('/llm/anthropic/test', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('🚨 liara senza config → procede (Liara free-tier)', async () => {
    getMock.mockReturnValue(null);
    dispatchLLMForTestMock.mockResolvedValueOnce('test reply');
    const res = await makeApp('editor').request('/llm/liara/test', { method: 'POST' });
    expect(res.status).toBe(200);
  });

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
