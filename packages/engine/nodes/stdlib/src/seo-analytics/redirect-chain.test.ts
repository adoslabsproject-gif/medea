/**
 * Test bug-bounty — action_redirect_chain (network mockato).
 * Copre: catena multi-hop, loop, cross-domain, seoImpact ramp, server/contentType,
 * meta-refresh + canonical mismatch sulla pagina finale, SSRF, fallback HEAD→GET.
 * Mutation-verify esplicito sui campi nuovi (seoImpact/crossDomainCount/metaRefresh).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeFetchWithRedirects, readTextTruncated, SsrfBlockedError } from '@flowforge/safe-fetch';
import { redirectChainNode } from './redirect-chain.js';

vi.mock('@flowforge/safe-fetch', () => {
  class SsrfBlockedError extends Error {}
  return { SsrfBlockedError, safeFetchWithRedirects: vi.fn(), readTextTruncated: vi.fn() };
});

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const mockFetch = vi.mocked(safeFetchWithRedirects);
const mockRead = vi.mocked(readTextTruncated);
const exec = redirectChainNode.executor!;

interface Route { status: number; location?: string; contentType?: string; server?: string; html?: string; ssrf?: boolean }

function fakeRes(r: Route): Response {
  const headers: Record<string, string | undefined> = {
    location: r.location, 'content-type': r.contentType, server: r.server,
  };
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: { cancel: () => undefined },
    __html: r.html ?? '',
  } as unknown as Response;
}

function routeTable(routes: Record<string, Route>): void {
  mockFetch.mockImplementation((url: unknown) => {
    const r = routes[String(url)];
    if (!r) return Promise.resolve(fakeRes({ status: 404 }));
    if (r.ssrf) return Promise.reject(new SsrfBlockedError('blocked'));
    return Promise.resolve(fakeRes(r));
  });
   
  mockRead.mockImplementation((res: any) => Promise.resolve({ text: String(res.__html ?? ''), truncated: false, bytes: 0 }));
}

beforeEach(() => { mockFetch.mockReset(); mockRead.mockReset(); });

describe('redirect_chain — catena base', () => {
  it('301 → 200: 2 hop, ok, seoImpact good, server/contentType raccolti', async () => {
    routeTable({
      'https://a.com/old': { status: 301, location: 'https://a.com/new', server: 'nginx' },
      'https://a.com/new': { status: 200, contentType: 'text/html', server: 'nginx', html: '<html></html>' },
    });
    const r = await exec({ url: 'https://a.com/old' }, null, CTX);
    const out = r.output as Record<string, unknown>;
    expect(out.hopCount).toBe(2);
    expect(out.finalUrl).toBe('https://a.com/new');
    expect(out.ok).toBe(true);
    expect(out.seoImpact).toBe('good');
    expect(out.crossDomainCount).toBe(0);
    const chain = out.chain as { server: string | null; contentType: string | null }[];
    expect(chain[0]?.server).toBe('nginx');
    expect(chain[1]?.contentType).toBe('text/html');
    expect(typeof out.totalLatencyMs).toBe('number');
  });

  it('🚨 cross-domain → crossDomainCount + seoImpact warning', async () => {
    routeTable({
      'https://a.com/': { status: 302, location: 'https://b.com/' },
      'https://b.com/': { status: 200, contentType: 'application/json' },
    });
    const r = await exec({ url: 'https://a.com/', analyzeFinalPage: false }, null, CTX);
    const out = r.output as Record<string, unknown>;
    // MUTATION: senza il conteggio host-diff crossDomainCount resterebbe 0 e seoImpact 'good'.
    expect(out.crossDomainCount).toBe(1);
    expect(out.seoImpact).toBe('warning');
  });

  it('🚨 loop A→B→A → loopDetected, ok false, seoImpact bad', async () => {
    routeTable({
      'https://a.com/': { status: 302, location: 'https://b.com/' },
      'https://b.com/': { status: 302, location: 'https://a.com/' },
    });
    const r = await exec({ url: 'https://a.com/' }, null, CTX);
    const out = r.output as Record<string, unknown>;
    expect(out.loopDetected).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.seoImpact).toBe('bad');
  });

  it('🚨 catena lunga (5 hop) → seoImpact bad', async () => {
    routeTable({
      'https://s.com/1': { status: 301, location: 'https://s.com/2' },
      'https://s.com/2': { status: 301, location: 'https://s.com/3' },
      'https://s.com/3': { status: 301, location: 'https://s.com/4' },
      'https://s.com/4': { status: 301, location: 'https://s.com/5' },
      'https://s.com/5': { status: 200, contentType: 'text/html', html: '<html></html>' },
    });
    const r = await exec({ url: 'https://s.com/1' }, null, CTX);
    expect((r.output as { seoImpact: string }).seoImpact).toBe('bad');
  });
});

describe('redirect_chain — analisi pagina finale', () => {
  it('🚨 meta-refresh estratto come weak redirect', async () => {
    routeTable({
      'https://a.com/': { status: 200, contentType: 'text/html', html: '<html><head><meta http-equiv="refresh" content="0; url=https://a.com/next"></head></html>' },
    });
    const r = await exec({ url: 'https://a.com/' }, null, CTX);
    const out = r.output as { metaRefresh: string | null; warnings?: string[] };
    expect(out.metaRefresh).toBe('https://a.com/next');
  });

  it('🚨 canonical mismatch quando il canonical punta altrove', async () => {
    routeTable({
      'https://a.com/page': { status: 200, contentType: 'text/html', html: '<html><head><link rel="canonical" href="https://a.com/canonical-altro"></head></html>' },
    });
    const r = await exec({ url: 'https://a.com/page' }, null, CTX);
    const out = r.output as { canonicalMismatch: boolean | null; canonicalUrl: string | null };
    expect(out.canonicalMismatch).toBe(true);
    expect(out.canonicalUrl).toBe('https://a.com/canonical-altro');
  });

  it('canonical che combacia (ignora trailing slash) → mismatch false', async () => {
    routeTable({
      'https://a.com/page': { status: 200, contentType: 'text/html', html: '<html><head><link rel="canonical" href="https://a.com/page/"></head></html>' },
    });
    const r = await exec({ url: 'https://a.com/page' }, null, CTX);
    expect((r.output as { canonicalMismatch: boolean | null }).canonicalMismatch).toBe(false);
  });

  it('pagina finale non-HTML → niente analisi (metaRefresh null)', async () => {
    routeTable({ 'https://a.com/file.pdf': { status: 200, contentType: 'application/pdf' } });
    const r = await exec({ url: 'https://a.com/file.pdf' }, null, CTX);
    const out = r.output as { metaRefresh: string | null; canonicalMismatch: boolean | null };
    expect(out.metaRefresh).toBeNull();
    expect(out.canonicalMismatch).toBeNull();
  });

  it('analyzeFinalPage=false → nessun GET extra (solo la catena)', async () => {
    routeTable({ 'https://a.com/': { status: 200, contentType: 'text/html', html: '<meta http-equiv="refresh" content="0;url=https://x">' } });
    const r = await exec({ url: 'https://a.com/', analyzeFinalPage: false }, null, CTX);
    expect((r.output as { metaRefresh: string | null }).metaRefresh).toBeNull();
  });
});

describe('redirect_chain — robustezza', () => {
  it('SSRF sul primo hop → error, chain vuota, ok false', async () => {
    routeTable({ 'https://169.254.169.254/': { status: 0, ssrf: true } });
    const r = await exec({ url: 'https://169.254.169.254/' }, null, CTX);
    const out = r.output as { ok: boolean; hopCount: number; error?: string };
    expect(out.ok).toBe(false);
    expect(out.hopCount).toBe(0);
    expect(out.error).toBeTruthy();
  });

  it('url mancante → throw', async () => {
    await expect(exec({}, null, CTX)).rejects.toThrow(/url required/u);
  });

  it('maxHops rispettato → exceededMaxHops', async () => {
    routeTable({
      'https://s.com/1': { status: 301, location: 'https://s.com/2' },
      'https://s.com/2': { status: 301, location: 'https://s.com/3' },
      'https://s.com/3': { status: 301, location: 'https://s.com/4' },
    });
    const r = await exec({ url: 'https://s.com/1', maxHops: 2 }, null, CTX);
    expect((r.output as { exceededMaxHops: boolean }).exceededMaxHops).toBe(true);
  });
});
