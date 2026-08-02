/**
 * Marketplace discovery client — FAIL-SOFT totale (la chat non si rompe mai per
 * colpa del marketplace) + formattazione free/paid per il prompt.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/internal-token.js', () => ({ getOutboundPortalToken: () => 'tok-123' }));
vi.mock('@/config.js', () => ({ loadConfig: () => ({ MEDEA_PORTAL_URL: 'http://portal:3006' }) }));
vi.mock('@/lib/logger.js');

const { searchMarketplace, formatPrice, formatMarketplaceSuggestions } =
  await import('./marketplace-discovery.js');

const sample = {
  defId: 'community_acme_pdf',
  displayName: 'Acme PDF Splitter',
  description: 'Divide un PDF in pagine. Veloce.',
  category: 'files',
  pricingModel: 'free',
  priceCents: 0,
  currency: 'EUR',
  installCount: 42,
  ratingAvg: 4.5,
};

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});
beforeEach(() => {
  /* breaker state may persist across tests in same module — ok */
});

describe('searchMarketplace — fail-soft', () => {
  it('200 con results → ritorna i suggerimenti', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, results: [sample] }), { status: 200 }),
      );
    const r = await searchMarketplace('dividi pdf');
    expect(r).toHaveLength(1);
    expect(r[0]!.defId).toBe('community_acme_pdf');
  });

  it('manda x-internal-token + query nel body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    globalThis.fetch = fetchMock;
    await searchMarketplace('cerca qualcosa');
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
    expect(init.headers['x-internal-token']).toBe('tok-123');
    expect(JSON.parse(init.body)).toMatchObject({ query: 'cerca qualcosa' });
  });

  it('query troppo corta → [] senza chiamare il portal', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    expect(await searchMarketplace('a')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('portal 500 → [] (mai throw)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    expect(await searchMarketplace('qualcosa di valido')).toEqual([]);
  });

  it('fetch rifiuta (portal giù/timeout) → [] (mai throw)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await searchMarketplace('altra query valida')).toEqual([]);
  });
});

describe('formatPrice — free vs paid', () => {
  it('free / priceCents 0 → "gratis"', () => {
    expect(formatPrice({ ...sample, pricingModel: 'free', priceCents: 0 })).toBe('gratis');
    expect(formatPrice({ ...sample, pricingModel: 'one_time', priceCents: 0 })).toBe('gratis');
  });
  it('one_time → importo una tantum', () => {
    expect(formatPrice({ ...sample, pricingModel: 'one_time', priceCents: 499 })).toMatch(
      /4,99 EUR una tantum/,
    );
  });
  it('subscription → /mese', () => {
    expect(formatPrice({ ...sample, pricingModel: 'subscription', priceCents: 900 })).toMatch(
      /9,00 EUR\/mese/,
    );
  });
});

describe('formatMarketplaceSuggestions', () => {
  it('vuoto → stringa vuota (nessun blocco nel prompt)', () => {
    expect(formatMarketplaceSuggestions([])).toBe('');
  });
  it('marca "NON installati" + propone install/acquisto, mostra prezzo', () => {
    const out = formatMarketplaceSuggestions([
      { ...sample, pricingModel: 'free', priceCents: 0 },
      {
        ...sample,
        defId: 'community_x_paid',
        displayName: 'Paid X',
        pricingModel: 'one_time',
        priceCents: 1500,
      },
    ]);
    expect(out).toContain('NON installati');
    expect(out).toContain('community_acme_pdf');
    expect(out).toContain('gratis');
    expect(out).toContain('15,00 EUR una tantum');
  });
});
