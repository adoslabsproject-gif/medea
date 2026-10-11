/**
 * Test 2026-grade — LlmResolverService (provider resolution + BYO).
 *
 * SECURITY: BYOK header key NON loggata.
 * DRY: single source per "quale LLM" — 4 callsite consolidate prima.
 * UX: clear error message + HTTP status (401 unconfigured / 403 forbidden).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const providersGetMock = vi.fn();
const providersGetAllMock = vi.fn();
const providersListMock = vi.fn();
class LlmProvidersServiceMock {
  get = providersGetMock;
  getAll = providersGetAllMock;
  list = providersListMock;
}
vi.mock('./llm-providers.service.js', () => ({
  LlmProvidersService: LlmProvidersServiceMock,
}));

// Auto-pick delega la SCELTA DEL NOME a resolveDefaultProvider (STESSA fonte del
// branding). Qui lo mockiamo: la sua logica d'ordine/priorità è testata a fondo
// in tenant-ai-preferences.service.test.ts. Il resolver, dato il nome scelto,
// deve solo caricarne il descriptor (key/model/baseUrl) — è QUESTO il suo job.
const resolveDefaultProviderMock = vi.fn();
vi.mock('./tenant-ai-preferences.service.js', () => ({
  tenantAiPreferences: { resolveDefaultProvider: resolveDefaultProviderMock },
}));

const { LlmResolverService, NoLlmProviderError, llmResolver } =
  await import('./llm-resolver.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  providersGetMock.mockReturnValue(null);
  providersGetAllMock.mockReturnValue({});
  providersListMock.mockReturnValue([]);
  resolveDefaultProviderMock.mockReturnValue(null);
});

describe('🚨 BYO mode — header key', () => {
  it('🚨 requestedProvider + headerKey supported → BYO immediate', () => {
    const r = new LlmResolverService().resolve('t-1', {
      requestedProvider: 'anthropic',
      headerApiKey: 'sk-byo-key',
    });
    expect(r).toEqual({ provider: 'anthropic', apiKey: 'sk-byo-key', model: '' });
    expect(providersGetMock).not.toHaveBeenCalled();
  });

  it('🚨 legacy: solo header key (no provider) → assume anthropic', () => {
    const r = new LlmResolverService().resolve('t-1', { headerApiKey: 'sk-key' });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBe('sk-key');
  });

  it('🚨 trim whitespace su input', () => {
    const r = new LlmResolverService().resolve('t-1', {
      requestedProvider: '  openai  ',
      headerApiKey: '  sk-key  ',
    });
    expect(r.provider).toBe('openai');
    expect(r.apiKey).toBe('sk-key');
  });

  it('🚨 provider non supportato → fallback al flow store', () => {
    // 'fake-provider' non in SUPPORTED → cade nel branch auto-pick
    providersGetAllMock.mockReturnValueOnce({});
    expect(() =>
      new LlmResolverService().resolve('t-1', {
        requestedProvider: 'fake-provider',
        headerApiKey: 'k',
      }),
    ).toThrow(NoLlmProviderError);
  });
});

describe('🚨 grok / deepseek — desincronizzazione resolver FIXATA (2026-06-14)', () => {
  it('🚨 explicit "grok" con key salvata → risolto (prima cadeva in auto-pick: non supportato)', () => {
    providersGetMock.mockReturnValueOnce({ apiKey: 'xai-k', defaultModel: 'grok-2-latest' });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'grok' });
    expect(r.provider).toBe('grok');
    expect(r.apiKey).toBe('xai-k');
  });

  it('🚨 explicit "deepseek" con key salvata → risolto', () => {
    providersGetMock.mockReturnValueOnce({ apiKey: 'ds-k', defaultModel: 'deepseek-chat' });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'deepseek' });
    expect(r.provider).toBe('deepseek');
  });

  it('🚨 auto-pick: il NOME scelto da resolveDefaultProvider viene caricato (deepseek/grok)', () => {
    resolveDefaultProviderMock.mockReturnValueOnce('grok');
    providersGetAllMock.mockReturnValueOnce({ grok: { apiKey: 'xai-k' } });
    expect(new LlmResolverService().resolve('t-1').provider).toBe('grok');
    resolveDefaultProviderMock.mockReturnValueOnce('deepseek');
    providersGetAllMock.mockReturnValueOnce({
      deepseek: { apiKey: 'ds-k', defaultModel: 'deepseek-chat' },
    });
    const r = new LlmResolverService().resolve('t-1');
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-chat');
  });

  it('🚨 alias "xai" risolve a grok (provider-registry)', () => {
    providersGetMock.mockReturnValueOnce({ apiKey: 'xai-k' });
    // isSupportedProvider('xai') → true via registry; lo store viene interrogato.
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'xai' });
    expect(r.apiKey).toBe('xai-k');
  });
});

describe('🚨 explicit provider + tenant Settings key', () => {
  it('🚨 happy: pull stored key + model + baseUrl', () => {
    providersGetMock.mockReturnValueOnce({
      apiKey: 'sk-stored',
      defaultModel: 'claude-opus-4',
      baseUrl: 'https://api.anthropic.com',
    });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'anthropic' });
    expect(r).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-stored',
      model: 'claude-opus-4',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('🚨 no stored → NoLlmProviderError 401', () => {
    providersGetMock.mockReturnValueOnce(null);
    expect(() => new LlmResolverService().resolve('t-1', { requestedProvider: 'openai' })).toThrow(
      NoLlmProviderError,
    );
    try {
      new LlmResolverService().resolve('t-1', { requestedProvider: 'openai' });
    } catch (e) {
      expect((e as InstanceType<typeof NoLlmProviderError>).httpStatus).toBe(401);
      expect((e as Error).message).toMatch(/non configurato/u);
    }
  });

  it('🚨 model default vuoto se non set in Settings', () => {
    providersGetMock.mockReturnValueOnce({ apiKey: 'k' });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'openai' });
    expect(r.model).toBe('');
  });

  it('🚨 baseUrl undefined → NON appare nel ResolvedLlm', () => {
    providersGetMock.mockReturnValueOnce({ apiKey: 'k', defaultModel: 'gpt-4' });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'openai' });
    expect(r).not.toHaveProperty('baseUrl');
  });

  /**
   * Un nome rimasto in una richiesta o in un workflow da una versione che
   * aveva un provider in più non è «richiesto esplicitamente»: non essendo
   * noto, si ricade sulla scelta del tenant come se non fosse stato indicato.
   */
  it('🚨 un provider che non esiste più viene ignorato: decide la scelta del tenant', () => {
    resolveDefaultProviderMock.mockReturnValueOnce('openai');
    providersGetAllMock.mockReturnValueOnce({ openai: { apiKey: 'sk-o' } });
    const r = new LlmResolverService().resolve('t-1', { requestedProvider: 'provider-dismesso' });
    expect(r.provider).toBe('openai');
    expect(providersGetMock).not.toHaveBeenCalled();
  });
});

describe('🚨 auto-pick — delega a resolveDefaultProvider (STESSA fonte del branding)', () => {
  it('🚨 nessun provider risolvibile → 401, col messaggio che dice dove configurarlo', () => {
    resolveDefaultProviderMock.mockReturnValueOnce(null);
    try {
      new LlmResolverService().resolve('t-1');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof NoLlmProviderError>).httpStatus).toBe(401);
      expect((e as Error).message).toMatch(/Nessun provider LLM configurato/u);
      expect((e as Error).message).toMatch(/Settings → AI Providers/u);
    }
  });

  it('🚨 carica il descriptor (key+model+baseUrl) del NOME scelto', () => {
    resolveDefaultProviderMock.mockReturnValueOnce('anthropic');
    providersGetAllMock.mockReturnValueOnce({
      anthropic: {
        apiKey: 'sk-a',
        defaultModel: 'claude-opus-4',
        baseUrl: 'https://api.anthropic.com',
      },
    });
    const r = new LlmResolverService().resolve('t-1');
    expect(r).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-a',
      model: 'claude-opus-4',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it("🚨🔒 ANTI-REGRESSIONE (bug 2026-06-18): il default scelto è ONORATO anche se c'è un'altra chiave", () => {
    // PRIMA del fix l'auto-pick preferiva anthropic (chiave presente) IGNORANDO
    // la scelta del tenant → Claude in silenzio, con l'avatar del provider
    // scelto. Ora la scelta vince: niente swap nascosto su un'altra chiave.
    resolveDefaultProviderMock.mockReturnValueOnce('gemini');
    providersGetAllMock.mockReturnValueOnce({
      gemini: { apiKey: 'g-key' },
      anthropic: { apiKey: 'sk-paid' }, // presente ma NON deve essere scelto
    });
    const r = new LlmResolverService().resolve('t-1');
    expect(r.provider).toBe('gemini');
    expect(r.apiKey).toBe('g-key');
  });

  it('🚨 delega: resolveDefaultProvider riceve i provider configurati con key (da list)', () => {
    providersListMock.mockReturnValueOnce([
      { provider: 'gemini', hasKey: true },
      { provider: 'anthropic', hasKey: true },
      { provider: 'openai', hasKey: false }, // niente key → escluso
    ]);
    resolveDefaultProviderMock.mockReturnValueOnce('anthropic');
    providersGetAllMock.mockReturnValueOnce({ anthropic: { apiKey: 'k' } });
    new LlmResolverService().resolve('t-1');
    expect(resolveDefaultProviderMock).toHaveBeenCalledWith('t-1', [
      { provider: 'gemini', hasKey: true },
      { provider: 'anthropic', hasKey: true },
    ]);
  });

  it('🚨 difensivo: nome risolto ma assente in getAll → NoLlmProviderError', () => {
    resolveDefaultProviderMock.mockReturnValueOnce('openai');
    providersGetAllMock.mockReturnValueOnce({}); // openai non c\'è
    expect(() => new LlmResolverService().resolve('t-1')).toThrow(NoLlmProviderError);
  });

  it('🚨 difensivo: nome non supportato → NoLlmProviderError (no crash)', () => {
    resolveDefaultProviderMock.mockReturnValueOnce('garbage-provider');
    expect(() => new LlmResolverService().resolve('t-1')).toThrow(NoLlmProviderError);
  });
});

describe('🚨 NoLlmProviderError shape', () => {
  it('🚨 default httpStatus 401', () => {
    const e = new NoLlmProviderError('test');
    expect(e.httpStatus).toBe(401);
    expect(e.name).toBe('NoLlmProviderError');
  });

  it('🚨 explicit 403 override', () => {
    expect(new NoLlmProviderError('x', 403).httpStatus).toBe(403);
  });
});

describe('🚨 singleton llmResolver', () => {
  it('🚨 esportato come instance riusabile', () => {
    expect(llmResolver).toBeInstanceOf(LlmResolverService);
  });
});
