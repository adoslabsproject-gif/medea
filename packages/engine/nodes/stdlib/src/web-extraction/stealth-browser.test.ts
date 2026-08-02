/**
 * Test reali per stealth-browser. NO smoke fake.
 * Asseriscono: fingerprint resolution, validation, request body shape,
 * error paths, output shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stealthBrowserNode, resolveFingerprint } from './stealth-browser.js';

// Mocka SOLO safeFetchWithRedirects; tiene il VERO assertUrlSafe (#2 — deve validare
// davvero la pagina navigata) via importOriginal.
vi.mock('@medea/engine-safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@medea/engine-safe-fetch')>();
  return { ...actual, safeFetchWithRedirects: vi.fn() };
});

const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = {
  tenantId: 't1',
  workflowId: 'w1',
  runId: 'r1',
  nodeId: 'n1',
  secrets: {},
  llmProviders: {},
} as const;

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.MEDEA_STEALTH_ENDPOINT;
  delete process.env.MEDEA_BROWSER_ENDPOINT;
});

describe('resolveFingerprint', () => {
  it('preset valido → ritorna esattamente quel preset', () => {
    const fp = resolveFingerprint('desktop-chrome-it');
    expect(fp.locale).toBe('it-IT');
    expect(fp.timezone).toBe('Europe/Rome');
    expect(fp.viewport.width).toBe(1920);
    expect(fp.platform).toBe('Win32');
  });

  it('preset invalido → fallback desktop-chrome-it', () => {
    const fp = resolveFingerprint('does-not-exist');
    expect(fp.locale).toBe('it-IT');
    expect(fp.platform).toBe('Win32');
  });

  it('mobile-safari-it ha viewport iPhone', () => {
    const fp = resolveFingerprint('mobile-safari-it');
    expect(fp.viewport.width).toBe(390);
    expect(fp.viewport.height).toBe(844);
    expect(fp.ua).toContain('iPhone');
  });

  it('random pesca da pool (UA valida sempre presente)', () => {
    const fp = resolveFingerprint('random');
    expect(fp.ua).toBeTruthy();
    expect(fp.ua).toContain('Mozilla');
    expect(fp.viewport.width).toBeGreaterThan(0);
    expect(fp.viewport.height).toBeGreaterThan(0);
    expect(['it-IT', 'en-US']).toContain(fp.locale);
  });

  it('random su 100 iterazioni copre ALMENO 2 preset diversi (statistical)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const fp = resolveFingerprint('random');
      seen.add(fp.ua);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe('stealthBrowserNode.def', () => {
  it('def id === action_browser_stealth', () => {
    expect(stealthBrowserNode.def.id).toBe('action_browser_stealth');
    expect(stealthBrowserNode.def.type).toBe('action');
  });

  it('outputs include screenshotBase64 + harBase64 + fingerprintUsed', () => {
    expect(stealthBrowserNode.def.outputs).toContain('screenshotBase64');
    expect(stealthBrowserNode.def.outputs).toContain('harBase64');
    expect(stealthBrowserNode.def.outputs).toContain('fingerprintUsed');
  });

  it('fingerprintPreset field ha 6 options (1 random + 5 preset)', () => {
    const f = stealthBrowserNode.def.configFields?.find((x) => x.key === 'fingerprintPreset');
    expect(f).toBeDefined();
    expect(f && 'options' in f ? f.options?.length : 0).toBe(6);
    expect(f && 'options' in f ? f.options : []).toContain('random');
    expect(f && 'options' in f ? f.options : []).toContain('mobile-safari-it');
  });

  it('url field e\\` required', () => {
    const urlField = stealthBrowserNode.def.configFields?.find((x) => x.key === 'url');
    expect(urlField?.required).toBe(true);
  });
});

describe('stealthBrowserNode.executor', () => {
  it('url vuoto → throw "url required"', async () => {
    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await expect(stealthBrowserNode.executor({}, null, ctx)).rejects.toThrow(/url required/);
  });

  it('endpoint vuoto + no env → throw con istruzioni BYO', async () => {
    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await expect(
      stealthBrowserNode.executor({ url: 'https://test.com' }, null, ctx),
    ).rejects.toThrow(/Stealth browser endpoint not configured/);
  });

  // 🚨 #2 SSRF-by-proxy: la PAGINA navigata (config.url) deve essere validata, non solo
  // l'endpoint. Un IP privato/IMDS via il browser BYO = SSRF.
  it('🚨 SSRF: url=IMDS (169.254.169.254) → throw, NESSUNA fetch al browser', async () => {
    process.env.MEDEA_BROWSER_ENDPOINT = 'https://browser.example.com';
    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await expect(
      stealthBrowserNode.executor({ url: 'http://169.254.169.254/latest/meta-data' }, null, ctx),
    ).rejects.toThrow();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('endpoint da env MEDEA_BROWSER_ENDPOINT fallback funziona', async () => {
    process.env.MEDEA_BROWSER_ENDPOINT = 'https://fallback.example.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ html: '<html>ok</html>', cookies: [], finalUrl: 'https://test.com' }),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    const res = await stealthBrowserNode.executor({ url: 'https://test.com' }, null, ctx);
    expect((res.output as { html: string }).html).toBe('<html>ok</html>');
    expect(mockedFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockedFetch.mock.calls[0]!;
    expect(calledUrl).toBe('https://fallback.example.com/stealth-render');
  });

  it('endpoint config ha priorita\\` su env', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://env-endpoint.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ html: 'x', cookies: [], finalUrl: 'x' }),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://test.com', endpoint: 'https://config-endpoint.com' },
      null,
      ctx,
    );
    const [calledUrl] = mockedFetch.mock.calls[0]!;
    expect(calledUrl).toBe('https://config-endpoint.com/stealth-render');
  });

  it('apiKey → Authorization header Bearer', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://test.com', apiKey: 'sk-secret-123' },
      null,
      ctx,
    );
    const opts = mockedFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer sk-secret-123');
  });

  it('request body contiene fingerprint + stealthPlugins + URL', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://target.com', fingerprintPreset: 'mobile-safari-it' },
      null,
      ctx,
    );
    const opts = mockedFetch.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(opts.body) as {
      url: string;
      fingerprint: { userAgent: string; viewport: { width: number } };
      stealthPlugins: string[];
    };
    expect(body.url).toBe('https://target.com');
    expect(body.fingerprint.viewport.width).toBe(390);
    expect(body.fingerprint.userAgent).toContain('iPhone');
    expect(body.stealthPlugins.length).toBeGreaterThanOrEqual(10);
    expect(body.stealthPlugins).toContain('navigator.webdriver');
    expect(body.stealthPlugins).toContain('canvas.fingerprint');
  });

  it('scrollLazy + scrollSteps clampa a 30 max', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://t.com', scrollLazy: true, scrollSteps: 9999 },
      null,
      ctx,
    );
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as {
      scrollLazy: { steps: number };
    };
    expect(body.scrollLazy.steps).toBe(30);
  });

  it('blockResources CSV → array trim/filter', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://t.com', blockResources: ' image , font ,  , media' },
      null,
      ctx,
    );
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as {
      blockResources: string[];
    };
    expect(body.blockResources).toEqual(['image', 'font', 'media']);
  });

  it('extraHeaders JSON string → parsed', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await stealthBrowserNode.executor(
      { url: 'https://t.com', extraHeaders: '{"X-Custom":"v1"}' },
      null,
      ctx,
    );
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as {
      extraHeaders: Record<string, string>;
    };
    expect(body.extraHeaders['X-Custom']).toBe('v1');
  });

  it('endpoint non-ok → throw con status + body slice', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway internal',
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    await expect(stealthBrowserNode.executor({ url: 'https://t.com' }, null, ctx)).rejects.toThrow(
      /Stealth browser failed: 502.*Bad Gateway/,
    );
  });

  it('output ha tutti i campi attesi + fingerprintUsed esposto', async () => {
    process.env.MEDEA_STEALTH_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        html: '<h1>OK</h1>',
        cookies: ['s=1'],
        finalUrl: 'https://t.com/final',
        screenshotBase64: 'iVBOR...',
        harBase64: 'eyJ...',
        metrics: { ttfbMs: 120, loadMs: 800, scriptCount: 10, xhrCount: 5 },
      }),
    } as unknown as Response);

    if (!stealthBrowserNode.executor) throw new Error('executor mancante');
    const res = await stealthBrowserNode.executor(
      { url: 'https://t.com', fingerprintPreset: 'desktop-chrome-en' },
      null,
      ctx,
    );
    const out = res.output as Record<string, unknown>;
    expect(out.html).toBe('<h1>OK</h1>');
    expect(out.cookies).toEqual(['s=1']);
    expect(out.finalUrl).toBe('https://t.com/final');
    expect(out.screenshotBase64).toBe('iVBOR...');
    expect(out.harBase64).toBe('eyJ...');
    expect(out.metrics).toMatchObject({ ttfbMs: 120, scriptCount: 10 });
    expect(out.fingerprintUsed).toMatchObject({ locale: 'en-US' });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
