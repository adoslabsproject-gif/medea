/**
 * contact-discovery.service tests — focus #202 P0-3 SSRF guard.
 *
 * Pre-fix: fetchRaw + fetchRobots usavano `fetch()` direttamente con la URL
 * dell'utente/serp DDG (untrusted). Un attaccante poteva mettere un link a
 * http://169.254.169.254/ (cloud metadata IMDS) o 127.0.0.1:6379 (Redis
 * interno) → leak credenziali / lateral movement.
 *
 * Post-fix: validateUrlForFetch() chiamato PRIMA di ogni fetch + re-validato
 * ad ogni redirect hop.
 *
 * Note: discoverContacts() ha cache LRU 7gg → ogni test usa URL diverso per
 * non hittare cache da test precedenti.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  validateUrl: vi.fn(),
  webSearch: vi.fn().mockResolvedValue({ results: [], provider: 'ddg' }),
  harvestEmails: vi.fn().mockReturnValue({ all_emails: [], unique_count: 0 }),
}));

// Global fetch mock — applicato su globalThis per essere intercettato dal modulo.
vi.stubGlobal('fetch', m.fetchMock);

vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()),
  validateUrlForFetch: (url: string) => m.validateUrl(url),
}));

vi.mock('./web-tools.service.js', () => ({
  webSearch: m.webSearch,
}));

vi.mock('./email-harvest.service.js', () => ({
  harvestEmails: m.harvestEmails,
}));

vi.mock('@/lib/logger.js');

beforeEach(() => {
  vi.clearAllMocks();
  m.fetchMock.mockReset();
  // Fallback: qualsiasi fetch non esplicitamente mockato ritorna 404 stub —
  // evita hang reali su DNS lookup sotto load CI parallelo (flaky timeout).
  m.fetchMock.mockResolvedValue(new Response('', { status: 404 }));
  m.validateUrl.mockReturnValue({ ok: true });
  m.harvestEmails.mockReturnValue({ all_emails: [], unique_count: 0 });
});

// SSRF tests usano timeout esteso (30s) per resistere a CPU contention CI.
describe('#202 P0-3 — SSRF guard su fetchRaw (homepage)', { timeout: 30_000 }, () => {
  it('URL privato 127.0.0.1 → bloccato senza fetch (guard intercetta prima)', async () => {
    // SSRF guard rifiuta l'URL.
    m.validateUrl.mockImplementation((url: string) => {
      if (url.includes('127.0.0.1'))
        return { ok: false, reason: 'BLOCKED_LOOPBACK', detail: 'loopback' };
      return { ok: true };
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('http://127.0.0.1/contacts?ssrf-uniq=1');
    expect(r.emails).toEqual([]);
    // fetch() per la URL privata NON deve essere chiamato (guard ha bloccato prima)
    const homepageFetches = m.fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('127.0.0.1'),
    );
    expect(homepageFetches.length).toBe(0);
    // E validateUrl deve essere stato chiamato con l'URL privato (proof guard è invocato)
    const guardCalls = m.validateUrl.mock.calls.filter((c) => String(c[0]).includes('127.0.0.1'));
    expect(guardCalls.length).toBeGreaterThan(0);
  });

  it('URL Docker internal *.flowforge-net → bloccato senza fetch', async () => {
    m.validateUrl.mockImplementation((url: string) => {
      if (url.includes('flowforge-net'))
        return { ok: false, reason: 'BLOCKED_HOST', detail: 'docker internal' };
      return { ok: true };
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('http://tenant.flowforge-net:3100/?u=2');
    expect(r.emails).toEqual([]);
    const internalFetches = m.fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('flowforge-net'),
    );
    expect(internalFetches.length).toBe(0);
  });

  it('URL pubblico OK → fetch chiamato + valida guard prima', async () => {
    m.validateUrl.mockReturnValue({ ok: true });
    m.fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      url: 'https://example-pub-3.com/',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () =>
        new TextEncoder().encode('<html><body>no emails</body></html>').buffer,
      text: async () => '',
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://example-pub-3.com/?u=3', {
      respectRobots: false,
      ddgFallback: false,
      timeoutMs: 500,
    });
    expect(r.pages_visited).toBeGreaterThan(0);
    // Guard è invocato per la homepage (con query string)
    const guardCalls = m.validateUrl.mock.calls.filter((c) =>
      String(c[0]).includes('example-pub-3.com'),
    );
    expect(guardCalls.length).toBeGreaterThan(0);
  });
});

describe('#202 P0-3 — SSRF guard su redirect hop', () => {
  it('Server pubblico redirect 302 → IP privato bloccato (no follow)', async () => {
    // Prima validazione homepage = OK, seconda (per la Location) = BLOCKED.
    let callIdx = 0;
    m.validateUrl.mockImplementation((url: string) => {
      callIdx++;
      // Tutte le URL pubbliche OK
      if (url.includes('10.0.0.1'))
        return { ok: false, reason: 'BLOCKED_PRIVATE_IP', detail: 'private' };
      return { ok: true };
    });
    // Fetch homepage ritorna 302 → http://10.0.0.1/admin
    m.fetchMock.mockResolvedValueOnce({
      status: 302,
      ok: false,
      url: 'https://malicious-4.example.com/',
      headers: new Headers({ location: 'http://10.0.0.1/admin' }),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://malicious-4.example.com/?u=4', {
      respectRobots: false,
      ddgFallback: false,
      timeoutMs: 500,
    });
    // Nessuna pagina visitata con successo
    expect(r.emails).toEqual([]);
    // fetch() chiamato per la pagina iniziale (302), ma NON per la Location privata
    const privateFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('10.0.0.1'));
    expect(privateFetches.length).toBe(0);
    expect(callIdx).toBeGreaterThan(0);
  });
});

describe('#202 P0-3 — SSRF guard su robots.txt', () => {
  it('origin malicious con guard FAIL su robots.txt → no fetch robots', async () => {
    m.validateUrl.mockImplementation((url: string) => {
      if (url.includes('/robots.txt') && url.includes('169.254')) {
        return { ok: false, reason: 'BLOCKED_LINK_LOCAL', detail: 'IMDS' };
      }
      return { ok: true };
    });
    // homepage fetch ritorna empty (no email) — solo verifichiamo che robots non venga fetched
    m.fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      url: 'http://169.254.169.254/',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => new TextEncoder().encode('<html></html>').buffer,
      text: async () => '',
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('http://169.254.169.254/?u=5', { ddgFallback: false, timeoutMs: 500 });
    const robotFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('/robots.txt'));
    expect(robotFetches.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Extended coverage — aggiunti 2026-05-30 per portare a 100% lines/funcs.
// ═══════════════════════════════════════════════════════════════════════

function mockRawFetch(opts: {
  url?: string;
  status?: number;
  contentType?: string;
  html?: string;
  location?: string;
}): unknown {
  const headers = new Headers({
    'content-type': opts.contentType ?? 'text/html',
    ...(opts.location ? { location: opts.location } : {}),
  });
  const body = opts.html ?? '';
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) < 400,
    url: opts.url ?? 'https://x.com/',
    headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  };
}

describe('discoverContacts — URL invalid + emptyResult', () => {
  it('URL malformato → reason=invalid_url', async () => {
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('not a url');
    expect(r.reason_if_empty).toBe('invalid_url');
    expect(r.emails).toEqual([]);
  });
});

describe('discoverContacts — homepage email found early', () => {
  it('homepage con email valida → harvest + ritorna immediatamente', async () => {
    m.harvestEmails.mockReturnValueOnce({
      all_emails: [
        { email: 'info@example.com', confidence: 'high' as const, source: 'mailto' as const },
      ],
      unique_count: 1,
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 })) // robots.txt
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://homerich.example.com/',
          html: '<html><body><footer>info@example.com</footer></body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://homerich.example.com/?u=10', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails.length).toBe(1);
    expect(r.primary_email).toBe('info@example.com');
    expect(r.source_page).toBeTruthy();
  });
});

describe('discoverContacts — sitemap fallback', () => {
  it('homepage senza email → sitemap.xml ritorna candidates → tryFetch', async () => {
    m.harvestEmails.mockImplementation((html: string) => {
      if (html.includes('CONTACT-PAGE-FOUND')) {
        return {
          all_emails: [
            { email: 'hello@sitemap.com', confidence: 'high' as const, source: 'mailto' as const },
          ],
          unique_count: 1,
        };
      }
      return { all_emails: [], unique_count: 0 };
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 })) // robots
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://sitemap-test.example.com/',
          html: '<html><body>no email</body></html>',
        }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://sitemap-test.example.com/sitemap.xml',
          contentType: 'application/xml',
          html: '<urlset><url><loc>https://sitemap-test.example.com/contact</loc></url></urlset>',
        }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://sitemap-test.example.com/contact',
          html: '<html><body>CONTACT-PAGE-FOUND hello@sitemap.com</body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://sitemap-test.example.com/?u=11', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails.length).toBe(1);
  });

  it('sitemap NESSUN candidate con score > 0', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({ url: 'https://no-sitemap-score.com/', html: '<html></html>' }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          contentType: 'application/xml',
          html: '<urlset><url><loc>https://no-sitemap-score.com/blog/post-1</loc></url></urlset>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://no-sitemap-score.com/?u=12', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails).toEqual([]);
  });
});

describe('discoverContacts — DDG fallback', () => {
  it('webSearch same-domain URL → tryFetch', async () => {
    m.harvestEmails.mockImplementation((html: string) => {
      if (html.includes('DDG-RESULT')) {
        return {
          all_emails: [
            { email: 'ddg@found.com', confidence: 'medium' as const, source: 'text' as const },
          ],
          unique_count: 1,
        };
      }
      return { all_emails: [], unique_count: 0 };
    });
    m.webSearch.mockResolvedValueOnce({
      results: [{ url: 'https://ddgfound.com/contact', title: 'C', snippet: '' }],
      provider: 'ddg',
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({ url: 'https://ddgfound.com/', html: '<html><body>no email</body></html>' }),
      )
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://ddgfound.com/contact',
          html: '<html><body>DDG-RESULT</body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ddgfound.com/?u=13', { timeoutMs: 5000 });
    expect(r.emails.length).toBeGreaterThan(0);
  });

  it('webSearch cross-domain → skip', async () => {
    m.webSearch.mockResolvedValueOnce({
      results: [{ url: 'https://OTHER-DOMAIN.com/path', title: 'X', snippet: '' }],
      provider: 'ddg',
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://ddgcross.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ddgcross.com/?u=14', { timeoutMs: 5000 });
    expect(r.emails).toEqual([]);
  });

  it('webSearch URL malformata → catch + continue', async () => {
    m.webSearch.mockResolvedValueOnce({
      results: [{ url: 'not-a-url', title: 'X', snippet: '' }],
      provider: 'ddg',
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://ddgbadurl.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ddgbadurl.com/?u=15', { timeoutMs: 5000 });
    expect(r.emails).toEqual([]);
  });

  it('webSearch throw → catch + continua', async () => {
    m.webSearch.mockRejectedValueOnce(new Error('DDG fallita'));
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://ddgthrow.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ddgthrow.com/?u=16', { timeoutMs: 5000 });
    expect(r.emails).toEqual([]);
  });

  it('ddgFallback=false → no webSearch call', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://noddg.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://noddg.com/?u=17', { ddgFallback: false, timeoutMs: 5000 });
    expect(m.webSearch).not.toHaveBeenCalled();
  });
});

describe('discoverContacts — cache behavior', () => {
  it('cache hit → ritorna senza fetch', async () => {
    m.harvestEmails.mockReturnValueOnce({
      all_emails: [
        { email: 'cached@example.com', confidence: 'high' as const, source: 'mailto' as const },
      ],
      unique_count: 1,
    });
    m.fetchMock.mockResolvedValueOnce(mockRawFetch({ status: 404 })).mockResolvedValueOnce(
      mockRawFetch({
        url: 'https://cached-domain-99.com/',
        html: '<html><body>cached@example.com</body></html>',
      }),
    );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r1 = await discoverContacts('https://cached-domain-99.com/?u=20', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r1.cache_hit).toBe(false);
    const baselineCalls = m.fetchMock.mock.calls.length;
    const r2 = await discoverContacts('https://cached-domain-99.com/?u=20', { ddgFallback: false });
    expect(r2.cache_hit).toBe(true);
    expect(r2.took_ms).toBe(0);
    expect(m.fetchMock.mock.calls.length).toBe(baselineCalls);
  });

  it('bypassCache=true → re-fetch ignore cache', async () => {
    m.fetchMock.mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://bypass-cache-test-1.com/?u=21', {
      ddgFallback: false,
      timeoutMs: 1000,
    });
    const baselineCalls = m.fetchMock.mock.calls.length;
    const r2 = await discoverContacts('https://bypass-cache-test-1.com/?u=21', {
      ddgFallback: false,
      bypassCache: true,
      timeoutMs: 1000,
    });
    expect(r2.cache_hit).toBe(false);
    expect(m.fetchMock.mock.calls.length).toBeGreaterThan(baselineCalls);
  });
});

describe('discoverContacts — robots.txt parser', () => {
  it('robots Disallow /admin parser ok', async () => {
    m.fetchMock
      .mockResolvedValueOnce(
        mockRawFetch({
          contentType: 'text/plain',
          html: 'User-agent: *\nDisallow: /admin\nAllow: /admin/public',
        }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://robotest1.com/',
          html: '<html></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://robotest1.com/?u=30', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.pages_visited).toBeGreaterThanOrEqual(1);
  });

  it('robots.txt with comments + empty lines', async () => {
    m.fetchMock
      .mockResolvedValueOnce(
        mockRawFetch({
          contentType: 'text/plain',
          html: '# Comment\n\nUser-agent: *\nDisallow: /private # inline\n',
        }),
      )
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://robocom1.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://robocom1.com/?u=31', { ddgFallback: false, timeoutMs: 5000 });
    expect(m.fetchMock).toHaveBeenCalled();
  });

  it('respectRobots=false → skip robots fetch', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://norobo.com/', html: '<html></html>' }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://norobo.com/?u=32', {
      respectRobots: false,
      ddgFallback: false,
      timeoutMs: 5000,
    });
    const robotFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('/robots.txt'));
    expect(robotFetches.length).toBe(0);
  });

  it('robots fetch throw → catch + empty rules', async () => {
    m.fetchMock
      .mockRejectedValueOnce(new Error('robots fetch fail'))
      .mockResolvedValueOnce(
        mockRawFetch({ url: 'https://robothrow1.com/', html: '<html></html>' }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://robothrow1.com/?u=33', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r).toBeDefined();
  });
});

describe('discoverContacts — fetchRaw edge cases', () => {
  it('protocollo ftp:// nei link → skip', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://ftpx.com/',
          html: '<html><body><a href="ftp://files.ftpx.com/contatti">FTP</a></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://ftpx.com/?u=40', { ddgFallback: false, timeoutMs: 5000 });
    const ftpFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('ftp://'));
    expect(ftpFetches.length).toBe(0);
  });

  it('fetchRaw redirect safe → fetch target', async () => {
    m.harvestEmails.mockImplementation((html: string) => {
      if (html.includes('REDIRECT-TARGET')) {
        return {
          all_emails: [
            { email: 'redirected@x.com', confidence: 'high' as const, source: 'mailto' as const },
          ],
          unique_count: 1,
        };
      }
      return { all_emails: [], unique_count: 0 };
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 })) // robots
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        url: 'https://redir.com/old',
        headers: new Headers({ 'content-type': 'text/html', location: 'https://redir.com/new' }),
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
      })
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://redir.com/new',
          html: '<html><body>REDIRECT-TARGET redirected@x.com</body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://redir.com/?u=41', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails.length).toBeGreaterThan(0);
  });

  it('fetchRaw response 403 → ritorna {status:403, html:""}', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce({
        status: 403,
        ok: false,
        url: 'https://forb.com/',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode('Forbidden').buffer,
        text: async () => 'Forbidden',
      })
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://forb.com/?u=42', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails).toEqual([]);
  });

  it('redirect oltre MAX_HOPS → return null', async () => {
    const redirect302 = {
      status: 302,
      ok: false,
      url: 'https://loop.com/',
      headers: new Headers({ 'content-type': 'text/html', location: 'https://loop.com/next' }),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    };
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValueOnce(redirect302)
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://loop.com/?u=45', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails).toEqual([]);
  });

  // NB: redirect con Location parse-throw è praticamente impossibile da
  // scatenare perché new URL(value, base) accetta praticamente qualsiasi
  // forma. Il branch try/catch dentro fetchRaw è defensive only.

  it('fetch reject (network err) → catch + reason classify', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 })) // robots ok
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://network-fail.com/?u=47', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails).toEqual([]);
    expect(r.reason_if_empty).toBeTruthy();
  });

  it('html body > 500KB → truncato', async () => {
    const huge = 'x'.repeat(600_000);
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ url: 'https://huge.com/', html: huge }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://huge.com/?u=44', { ddgFallback: false, timeoutMs: 5000 });
    expect(m.fetchMock).toHaveBeenCalled();
  });
});

describe('discoverContacts — link scoring', () => {
  it('priorità /contatti > /about', async () => {
    m.harvestEmails.mockImplementation((html: string) => {
      if (html.includes('CONTATTI-PAGE')) {
        return {
          all_emails: [
            { email: 'priority@x.com', confidence: 'high' as const, source: 'mailto' as const },
          ],
          unique_count: 1,
        };
      }
      return { all_emails: [], unique_count: 0 };
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://priority.com/',
          html: '<html><body><a href="/about-us">About</a><a href="/contatti">Contatti</a></body></html>',
        }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://priority.com/contatti',
          html: '<html><body>CONTATTI-PAGE</body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://priority.com/?u=50', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails[0]?.email).toBe('priority@x.com');
  });

  it('javascript/mailto/tel/# links → filtered', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://filter.com/',
          html: '<html><body><a href="javascript:void(0)">JS</a><a href="mailto:x@y.com">Email</a><a href="tel:+1234">Tel</a><a href="#sec">Anchor</a></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://filter.com/?u=51', { ddgFallback: false, timeoutMs: 5000 });
    const badFetches = m.fetchMock.mock.calls.filter((c) => {
      const u = String(c[0]);
      return (
        u.startsWith('javascript:') ||
        u.startsWith('mailto:') ||
        u.startsWith('tel:') ||
        u.startsWith('#')
      );
    });
    expect(badFetches.length).toBe(0);
  });

  it('cross-origin link → filtered', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://cross.com/',
          html: '<html><body><a href="https://OTHER-DOM.com/contatti">Other</a></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://cross.com/?u=52', { ddgFallback: false, timeoutMs: 5000 });
    const otherFetches = m.fetchMock.mock.calls.filter((c) => String(c[0]).includes('OTHER-DOM'));
    expect(otherFetches.length).toBe(0);
  });

  it('anchor text scoring senza path match', async () => {
    m.harvestEmails.mockImplementation((html: string) => {
      if (html.includes('ANCHOR-MATCHED')) {
        return {
          all_emails: [
            { email: 'anchor@x.com', confidence: 'high' as const, source: 'text' as const },
          ],
          unique_count: 1,
        };
      }
      return { all_emails: [], unique_count: 0 };
    });
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://anchorr.com/',
          html: '<html><body><a href="/page-1">Scrivici</a></body></html>',
        }),
      )
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://anchorr.com/page-1',
          html: '<html><body>ANCHOR-MATCHED</body></html>',
        }),
      );
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://anchorr.com/?u=54', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.emails.length).toBeGreaterThan(0);
  });
});

describe('discoverContacts — metadata extraction', () => {
  it('og:site_name → company_name + meta description + html lang', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://meta.com/',
          html: '<html lang="it"><head><meta property="og:site_name" content="My Company"/><meta name="description" content="My desc"/></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://meta.com/?u=60', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.company_name).toBe('My Company');
    expect(r.description).toBe('My desc');
    expect(r.site_language).toBe('it');
  });

  it('og:image relativo → assolutizzato', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://ogimg.com/',
          html: '<html><head><meta property="og:image" content="/img/logo.png"/></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ogimg.com/?u=61', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.og_image).toBe('https://ogimg.com/img/logo.png');
  });

  it('og:image assoluto preservato', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://ogimg2.com/',
          html: '<html><head><meta property="og:image" content="https://cdn.example.com/logo.png"/></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ogimg2.com/?u=62', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.og_image).toBe('https://cdn.example.com/logo.png');
  });

  it('title con separator "|" → prima parte', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://titlesep.com/',
          html: '<html><head><title>BrandName | Tagline</title></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://titlesep.com/?u=63', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.company_name).toBe('BrandName');
  });

  it('application-name fallback', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://appname.com/',
          html: '<html><head><meta name="application-name" content="App Co"/></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://appname.com/?u=64', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.company_name).toBe('App Co');
  });

  it('og:description fallback', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://ogdesc.com/',
          html: '<html><head><meta property="og:description" content="OG description text"/></head><body></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://ogdesc.com/?u=65', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.description).toBe('OG description text');
  });

  it('content_text strip script/style/svg/noscript/comments + decode entities', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://strip.com/',
          html: '<html><head></head><body><script>alert(1)</script><style>body{}</style><svg></svg><noscript>noscript</noscript><!--comment--><p>Real &amp; more</p></body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://strip.com/?u=66', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.content_text).toContain('Real & more');
    expect(r.content_text).not.toContain('alert');
  });

  it('fallback titlecase(domain) quando nessun meta', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(
        mockRawFetch({
          url: 'https://my-brand-name.com/',
          html: '<html><body>nothing</body></html>',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://my-brand-name.com/?u=67', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.company_name).toMatch(/My Brand Name/);
  });

  it('homepage unreachable → emptyResult titlecase', async () => {
    m.fetchMock
      .mockResolvedValueOnce(mockRawFetch({ status: 404 }))
      .mockResolvedValueOnce(mockRawFetch({ status: 500 }))
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://unreachable-meta-xyz.com/?u=68', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(r.company_name).toMatch(/Unreachable Meta Xyz/);
    expect(r.reason_if_empty).toBeDefined();
  });
});

describe('discoverContacts — classifyEmptyReason variants', () => {
  it('pages_visited=0 → homepage_unreachable (robots blocca tutto)', async () => {
    // pages_visited=0 si verifica SOLO quando il robots.txt blocca persino la
    // homepage. Il visited.add succede dopo il robots-check (riga 553 source).
    m.fetchMock
      .mockResolvedValueOnce(
        mockRawFetch({
          contentType: 'text/plain',
          html: 'User-agent: *\nDisallow: /',
        }),
      )
      .mockResolvedValue(mockRawFetch({ status: 404 }));
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('https://robots-block-all-pv0.com/?u=71', {
      ddgFallback: false,
      timeoutMs: 5000,
    });
    expect(['homepage_unreachable', 'robots_blocked']).toContain(r.reason_if_empty);
  });

  it('emptyResult con URL malformata → domain vuoto', async () => {
    const { discoverContacts } = await import('./contact-discovery.service.js');
    const r = await discoverContacts('!!!invalid!!!');
    expect(r.domain).toBe('');
    expect(r.reason_if_empty).toBe('invalid_url');
  });
});

describe('anti-OOM: download HTML cappato in STREAMING', { timeout: 30_000 }, () => {
  /** Stream lazy che emette 64KB per pull (fino a 512 chunk = 32MB DISPONIBILI) e
   *  registra il MASSIMO numero di chunk tirati da UN singolo stream. Codice fixato
   *  (readTextTruncated, cap 500KB) → ogni stream cancella dopo ~8 chunk. Codice
   *  pre-fix (arrayBuffer integrale) → ogni stream tira tutti i 512. */
  function countingHtmlStream(stats: { maxChunks: number }): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 512) {
          controller.close();
          return;
        }
        sent += 1;
        stats.maxChunks = Math.max(stats.maxChunks, sent);
        controller.enqueue(new Uint8Array(64 * 1024)); // <body> di zeri (decode lenient)
      },
    });
  }

  it('🚨 ATTACCO: homepage con body ENORME → OGNI lettura si ferma al cap (no arrayBuffer integrale)', async () => {
    const stats = { maxChunks: 0 };
    m.validateUrl.mockReturnValue({ ok: true });
    m.webSearch.mockResolvedValue({ results: [], provider: 'ddg' });
    m.fetchMock.mockImplementation((url: unknown) => {
      if (String(url).includes('robots.txt'))
        return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(
        new Response(countingHtmlStream(stats), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    });
    const { discoverContacts } = await import('./contact-discovery.service.js');
    await discoverContacts('https://example-oom-cap.com/?u=oom-stream-2');
    // Indipendente dal NUMERO di pagine: nessun SINGOLO stream supera ~8 chunk (512KB).
    // Pre-fix (arrayBuffer): ogni stream tira tutti i 512 chunk (32MB).
    expect(stats.maxChunks).toBeLessThan(64);
  });
});
