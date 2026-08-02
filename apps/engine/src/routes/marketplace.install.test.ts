/**
 * Bug-bounty test — POST /marketplace/install: SSRF a 2 layer.
 *
 * Il fix (2026-06-11 audit): l'URL UTENTE deve passare per `safeOutboundFetch`
 * (wrapper canonico con dispatcher undici `connect.lookup` = Layer-2 anti
 * DNS-rebinding), NON per il `fetch` globale raw + sola validazione
 * pre-risoluzione (Layer-1) che lasciava aperta la finestra TOCTOU.
 *
 * Questi test provano il comportamento, non il plumbing:
 *  - l'URL utente è passato a safeOutboundFetch con redirect:'manual';
 *  - ANTI-REGRESSIONE: il `fetch` globale raw NON è usato per l'URL utente
 *    (solo per la chiamata interna /workflows su 127.0.0.1);
 *  - URL SSRF (validateUrlForFetch ko) → 400 URL_BLOCKED, nessuna fetch;
 *  - redirect 3xx → 400 (anti-SSRF), nessun follow;
 *  - workflow creato è `enabled:false` (non esegue codice all'import).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/lib/safe-outbound-fetch.js', () => ({ safeOutboundFetch: vi.fn() }));
vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()),
  validateUrlForFetch: vi.fn(),
}));
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'ws-test' }));
vi.mock('@medea/engine-nodes-stdlib', () => ({ stdlibNodeDefs: () => [] }));

const { safeOutboundFetch } = await import('@/lib/safe-outbound-fetch.js');
const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
const safeOutboundFetchMock = vi.mocked(safeOutboundFetch);
const validateUrlForFetchMock = vi.mocked(validateUrlForFetch);

const { createMarketplaceRoutes } = await import('./marketplace.js');

function app(): Hono {
  const a = new Hono();
  a.route('/api/v1', createMarketplaceRoutes());
  return a;
}
async function post(body: unknown): Promise<Response> {
  return app().request('/api/v1/marketplace/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer tkn' },
    body: JSON.stringify(body),
  });
}

const WF = { name: 'Imported WF', nodes: [], edges: [] };

beforeEach(() => {
  validateUrlForFetchMock.mockReturnValue({ ok: true });
  // safeOutboundFetch ritorna una Response reale (readWithCap legge res.body).
  safeOutboundFetchMock.mockResolvedValue(
    new Response(JSON.stringify(WF), {
      status: 200,
      headers: { 'content-length': String(JSON.stringify(WF).length) },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('POST /marketplace/install — SSRF 2-layer', () => {
  it('🚨 URL utente passa per safeOutboundFetch (Layer-2), NON per fetch globale raw', async () => {
    // fetch globale: solo la chiamata interna /workflows (127.0.0.1) deve usarlo.
    const globalFetch = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ id: 'wf-1', enabled: false }), { status: 201 }),
    );
    vi.stubGlobal('fetch', globalFetch);

    const res = await post({ url: 'https://evil-but-passes-layer1.test/wf.json' });
    expect(res.status).toBe(201);

    // 1) l'URL utente è andato a safeOutboundFetch con redirect manual.
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = safeOutboundFetchMock.mock.calls[0]!;
    expect(url).toBe('https://evil-but-passes-layer1.test/wf.json');
    expect(opts).toMatchObject({ redirect: 'manual' });

    // 2) ANTI-REGRESSIONE: il fetch globale NON è mai stato chiamato con l'URL
    //    utente (solo con l'endpoint interno /workflows).
    for (const call of globalFetch.mock.calls) {
      expect(String(call[0])).not.toContain('evil-but-passes-layer1.test');
      expect(String(call[0])).toContain('/workflows');
    }
  });

  it('🚨 URL SSRF (validateUrlForFetch ko) → 400 URL_BLOCKED, nessuna fetch', async () => {
    validateUrlForFetchMock.mockReturnValue({ ok: false, reason: 'BLOCKED_PRIVATE_IP' });
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    const res = await post({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('URL_BLOCKED');
    expect(safeOutboundFetchMock).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('🚨 redirect 3xx dal target → 400 (anti-SSRF), nessun follow', async () => {
    safeOutboundFetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:5000/' } }),
    );
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    const res = await post({ url: 'https://attacker.test/redir' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('URL_BLOCKED');
    // niente chiamata interna /workflows (l'import si è fermato al redirect).
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('body senza url → 400; body non-oggetto → 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
  });

  it("🚨 workflow importato è creato enabled:false (non esegue all'import)", async () => {
    const globalFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const sent = JSON.parse(init?.body ?? '{}') as { enabled?: boolean };
      // L'invariante di sicurezza: enabled DEVE essere false.
      expect(sent.enabled).toBe(false);
      return new Response(JSON.stringify({ id: 'wf-1' }), { status: 201 });
    });
    vi.stubGlobal('fetch', globalFetch);
    const res = await post({ url: 'https://ok.test/wf.json' });
    expect(res.status).toBe(201);
    expect(globalFetch).toHaveBeenCalled();
  });
});
