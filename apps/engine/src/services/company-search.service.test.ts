/**
 * company-search.service tests — focus #202 P0-3 SSRF guard.
 *
 * headValidate() viene chiamato su URL provenienti da search providers
 * (DDG/Brave/etc) → input non controllato dal codice, può contenere
 * link a IP privati/IMDS/Docker net interno. Pre-fix: fetch HEAD diretto.
 * Post-fix: validateUrlForFetch() PRIMA del fetch + ad ogni redirect hop.
 *
 * Test isolato sul behavior della validation, mockando webSearch +
 * llmResolver per non far girare l'intera pipeline LLM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  validateUrl: vi.fn().mockReturnValue({ ok: true }),
  webSearch: vi.fn(),
  llmResolve: vi.fn(),
}));

vi.stubGlobal('fetch', m.fetchMock);

vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()),
  validateUrlForFetch: (url: string) => m.validateUrl(url),
}));

vi.mock('./web-tools.service.js', () => ({
  webSearch: m.webSearch,
}));

vi.mock('./llm-resolver.service.js', () => ({
  llmResolver: { resolve: () => m.llmResolve() },
  NoLlmProviderError: class extends Error {},
}));

vi.mock('./llm-chat.service.js', () => ({
  dispatchLLMChat: vi.fn(),
}));

vi.mock('@/lib/logger.js');

beforeEach(() => {
  vi.clearAllMocks();
  m.validateUrl.mockReturnValue({ ok: true });
  m.fetchMock.mockReset();
});

describe('#202 P0-3 — companySearch.headValidate SSRF guard', () => {
  it('URL privato dal search → bloccato (filteredValidation +1), NO fetch HEAD', async () => {
    m.webSearch.mockResolvedValueOnce({
      provider: 'ddg',
      results: [{ url: 'http://10.0.0.5/', title: 'private', snippet: 's' }],
    });
    m.validateUrl.mockImplementation((url: string) => {
      if (url.includes('10.0.0.5')) return { ok: false, reason: 'BLOCKED_PRIVATE_IP', detail: 'rfc1918' };
      return { ok: true };
    });
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', {
      skipLLMExpansion: true,
      validateTimeoutMs: 1000,
    });
    expect(r.companies.length).toBe(0);
    expect(r.filtered_validation).toBeGreaterThan(0);
    // fetch HEAD NON deve essere mai chiamato per l'URL privato
    const privFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('10.0.0.5'));
    expect(privFetches.length).toBe(0);
  });

  it('URL pubblico OK → fetch HEAD chiamato + entra in candidates', async () => {
    m.webSearch.mockResolvedValueOnce({
      provider: 'ddg',
      results: [{ url: 'https://acme-corp-2.com/', title: 'acme', snippet: 'producer' }],
    });
    m.validateUrl.mockReturnValue({ ok: true });
    m.fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
    });
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', {
      skipLLMExpansion: true,
      validateTimeoutMs: 1000,
    });
    expect(r.companies.length).toBe(1);
    expect(r.companies[0]?.url).toBe('https://acme-corp-2.com/');
    expect(m.fetchMock).toHaveBeenCalled();
  });

  it('Redirect HEAD verso IP privato → secondo hop bloccato dal guard', async () => {
    m.webSearch.mockResolvedValueOnce({
      provider: 'ddg',
      results: [{ url: 'https://redirector-3.example.com/', title: 'r', snippet: 'r' }],
    });
    m.validateUrl.mockImplementation((url: string) => {
      if (url.includes('169.254')) return { ok: false, reason: 'BLOCKED_LINK_LOCAL', detail: 'IMDS' };
      return { ok: true };
    });
    // HEAD inziale ritorna 302 → http://169.254.169.254/latest/
    m.fetchMock.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'http://169.254.169.254/latest/' }),
    });
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', {
      skipLLMExpansion: true,
      validateTimeoutMs: 1000,
    });
    // Secondo hop bloccato → company NON valida → companies vuoto
    expect(r.companies.length).toBe(0);
    expect(r.filtered_validation).toBeGreaterThan(0);
    // Solo il primo HEAD è stato chiamato (su redirector-3), NON il secondo (su IMDS)
    const imdsFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('169.254'));
    expect(imdsFetches.length).toBe(0);
  });

  it('validateTimeoutMs=0 → headValidate skip (validation disabilita)', async () => {
    m.webSearch.mockResolvedValueOnce({
      provider: 'ddg',
      results: [{ url: 'https://no-validate-4.example.com/', title: 'nv', snippet: 'x' }],
    });
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', {
      skipLLMExpansion: true,
      validateTimeoutMs: 0,
    });
    expect(r.companies.length).toBe(1);
    // Validation skip → fetch NON chiamato
    expect(m.fetchMock).not.toHaveBeenCalled();
    // E SSRF guard NON serve invocarlo (validation off)
    expect(m.validateUrl).not.toHaveBeenCalled();
  });
});

describe('llm_usage (Fase 1b #13) — token della query expansion nel result', () => {
  it('expansion LLM avvenuta → llm_usage dal listener + llm_provider/llm_model', async () => {
    m.llmResolve.mockReturnValue({ provider: 'liara', apiKey: '', model: 'nha-v1' });
    m.webSearch.mockResolvedValue({ provider: 'ddg', results: [] });
    const { dispatchLLMChat } = await import('./llm-chat.service.js');
    vi.mocked(dispatchLLMChat).mockImplementation((async (...args: unknown[]) => {
      const listener = args[7] as ((u: { input: number; output: number; fromApi: boolean }) => void) | undefined;
      listener?.({ input: 40, output: 12, fromApi: true });
      return '["cantieri navali italia","yacht builders liguria"]';
    }) as typeof dispatchLLMChat);
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', { tenantId: 't1', validateTimeoutMs: 0 });
    expect(r.llm_usage).toEqual({ input: 40, output: 12, fromApi: true });
    expect(r.llm_provider).toBe('liara');
    expect(r.llm_model).toBe('nha-v1');
    expect(r.queries_generated_by_llm).toBe(true);
  });

  it('skipLLMExpansion → nessun llm_usage (nessun token speso)', async () => {
    m.webSearch.mockResolvedValue({ provider: 'ddg', results: [] });
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', { skipLLMExpansion: true, validateTimeoutMs: 0 });
    expect(r.llm_usage).toBeUndefined();
    expect(r.llm_model).toBeUndefined();
  });

  it('expansion fallita (dispatch throw) → nessun llm_usage, fallback seed-only come prima', async () => {
    m.llmResolve.mockReturnValue({ provider: 'liara', apiKey: '', model: 'nha-v1' });
    m.webSearch.mockResolvedValue({ provider: 'ddg', results: [] });
    const { dispatchLLMChat } = await import('./llm-chat.service.js');
    vi.mocked(dispatchLLMChat).mockRejectedValue(new Error('gateway giù'));
    const { companySearch } = await import('./company-search.service.js');
    const r = await companySearch('seed', { tenantId: 't1', validateTimeoutMs: 0 });
    expect(r.llm_usage).toBeUndefined();
    expect(r.queries_generated_by_llm).toBe(false);
    expect(r.queries_used).toEqual(['seed']);
  });
});
