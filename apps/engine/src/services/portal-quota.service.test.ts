import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  internalAwareFetch: vi.fn(),
  getOutboundPortalToken: vi.fn(() => 'tok'),
}));

vi.mock('@/lib/internal-service-fetch.js', () => ({
  internalAwareFetch: (...a: unknown[]) => m.internalAwareFetch(...a),
}));
vi.mock('@/lib/internal-token.js', () => ({
  getOutboundPortalToken: () => m.getOutboundPortalToken(),
}));
vi.mock('@/lib/logger.js'); // manual mock condiviso (convenzione runtime)

const WS = 'd43e6f82-b056-4481-8284-8b812f499b77';

function okResponse(body: unknown): { ok: true; status: 200; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

async function load() {
  const mod = await import('./portal-quota.service.js');
  mod.__clearPortalQuotaCache();
  return mod;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.getOutboundPortalToken.mockReturnValue('tok');
});

describe('fetchPortalTokenUsage', () => {
  it('200 valido → ritorna usato + confini periodo', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({
      ok: true, tokensUsed: 1234, tokensLimit: 500_000,
      periodStartIso: '2026-06-15', periodEndIso: '2026-07-15', planCode: 'pro', maxUsers: 10,
    }));
    const { fetchPortalTokenUsage } = await load();
    const r = await fetchPortalTokenUsage(WS, 1000);
    expect(r).toEqual({
      tokensUsed: 1234, tokensLimit: 500_000,
      periodStartIso: '2026-06-15', periodEndIso: '2026-07-15', maxUsers: 10,
    });
    // header token + URL corretti
    const [url, opts] = m.internalAwareFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain(`/api/v1/internal/quota-usage/${WS}`);
    expect(opts.headers['X-Internal-Token']).toBe('tok');
  });

  it('tokensLimit null (Enterprise) → pass-through null', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({
      ok: true, tokensUsed: 5, tokensLimit: null,
      periodStartIso: '2026-06-01', periodEndIso: '2026-07-01',
    }));
    const { fetchPortalTokenUsage } = await load();
    const r = await fetchPortalTokenUsage(WS, 1000);
    expect(r?.tokensLimit).toBeNull();
    expect(r?.tokensUsed).toBe(5);
  });

  it('non-200 → null (fail-soft)', async () => {
    m.internalAwareFetch.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const { fetchPortalTokenUsage } = await load();
    expect(await fetchPortalTokenUsage(WS, 1000)).toBeNull();
  });

  it('fetch throw (timeout/rete) → null, non rilancia', async () => {
    m.internalAwareFetch.mockRejectedValue(new Error('AbortError'));
    const { fetchPortalTokenUsage } = await load();
    expect(await fetchPortalTokenUsage(WS, 1000)).toBeNull();
  });

  it('payload malformato (manca periodEndIso) → null', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({ ok: true, tokensUsed: 9, periodStartIso: '2026-06-15' }));
    const { fetchPortalTokenUsage } = await load();
    expect(await fetchPortalTokenUsage(WS, 1000)).toBeNull();
  });

  it('ok:false nel body → null (anche se 200)', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({ ok: false, error: 'nope' }));
    const { fetchPortalTokenUsage } = await load();
    expect(await fetchPortalTokenUsage(WS, 1000)).toBeNull();
  });
});

describe('fetchPortalTokenUsage — cache TTL 25s', () => {
  it('seconda call entro 25s NON rifà la fetch', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({
      ok: true, tokensUsed: 10, tokensLimit: 100, periodStartIso: '2026-06-15', periodEndIso: '2026-07-15',
    }));
    const { fetchPortalTokenUsage } = await load();
    await fetchPortalTokenUsage(WS, 1_000);
    await fetchPortalTokenUsage(WS, 1_000 + 24_000); // entro TTL
    expect(m.internalAwareFetch).toHaveBeenCalledTimes(1);
  });

  it('oltre 25s rifà la fetch', async () => {
    m.internalAwareFetch.mockResolvedValue(okResponse({
      ok: true, tokensUsed: 10, tokensLimit: 100, periodStartIso: '2026-06-15', periodEndIso: '2026-07-15',
    }));
    const { fetchPortalTokenUsage } = await load();
    await fetchPortalTokenUsage(WS, 1_000);
    await fetchPortalTokenUsage(WS, 1_000 + 26_000); // oltre TTL
    expect(m.internalAwareFetch).toHaveBeenCalledTimes(2);
  });

  it('cache anche il FALLIMENTO (null) per non martellare il portal se è giù', async () => {
    m.internalAwareFetch.mockRejectedValue(new Error('down'));
    const { fetchPortalTokenUsage } = await load();
    expect(await fetchPortalTokenUsage(WS, 1_000)).toBeNull();
    expect(await fetchPortalTokenUsage(WS, 1_000 + 10_000)).toBeNull();
    expect(m.internalAwareFetch).toHaveBeenCalledTimes(1); // null cachato
  });
});
