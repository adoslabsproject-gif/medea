/**
 * Test 2026-grade — http executor (orchestrator v3).
 *
 * 🚨 SSRF DEFENSE: assertUrlSafe prima del fetch + manual redirect chain
 *    con validateUrlForFetch su OGNI hop. Bug = SSRF via 302 → internal IP.
 *
 * 🚨 ABORT PROPAGATION: context.abortSignal → AbortController interno per
 *    cancel utente immediato (no hang quando user click "Cancel run").
 *
 * 🚨 RETRY-ON-STATUS: retryOnStatus CSV "500,502,503" → withRetry triggera
 *    nuovo round. 4xx NON retry (default).
 *
 * 🚨 PAGINATION 4 STRATEGIES: page-number / offset-limit / cursor / link-header.
 *    Invalid mode → ValidationError.
 *
 * 🚨 statusCodeOnly: skip body read (saves bandwidth/memory grandi response).
 *
 * 🚨 allowSelfSigned IGNORED + warn (#201 P0-2 — fail-safe).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { makeBinaryRef, isBinaryData, type BinaryData } from '@medea/engine-core-schema';

vi.mock('@medea/engine-safe-fetch', () => ({
  assertUrlSafe: vi.fn(),
  validateUrlForFetch: vi.fn(() => ({ ok: true })),
  // H1: il loop di redirect dell'executor importa la lista di strip cross-host (single
  // source of truth). Valore REALE (non vi.fn) — è una costante, non un comportamento.
  CROSS_HOST_STRIP_HEADERS: ['authorization', 'cookie', 'proxy-authorization', 'x-csrf-token'],
}));

const { httpExecutor } = await import('./executor.js');
const safeFetch = await import('@medea/engine-safe-fetch');
const { clearOAuth2TokenCache } = await import('./oauth2.js');

const baseCfg = {
  method: 'GET' as const,
  url: 'https://api.example.com/data',
  authMode: 'none' as const,
  bodyType: 'none' as const,
  responseFormat: 'auto' as const,
  paginationMode: 'none' as const,
  timeoutMs: 5000,
  retryCount: 0,
  retryInitialDelayMs: 100,
  retryBackoffFactor: 2,
  followRedirects: true,
  throwOnError: false,
};

const mockResponse = (over: Partial<Response> & { jsonBody?: unknown; textBody?: string } = {}) => {
  const headers = new Headers(over.headers ?? { 'content-type': 'application/json' });
  return {
    status: over.status ?? 200,
    statusText: over.statusText ?? 'OK',
    ok: (over.status ?? 200) < 400,
    headers,
    text: async () => over.textBody ?? JSON.stringify(over.jsonBody ?? { data: 'ok' }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
};

const ctx = (over: Record<string, unknown> = {}) => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  workflowId: 'wf-1', runId: 'run-1', nodeId: 'node-1', tenantId: 't-1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(safeFetch.validateUrlForFetch).mockReturnValue({ ok: true });
  vi.mocked(safeFetch.assertUrlSafe).mockImplementation(() => {});
});

describe('🚨 SSRF defense', () => {
  it('🚨 assertUrlSafe chiamata PRIMA del primo fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({ jsonBody: { ok: 1 } }));
    await httpExecutor(baseCfg, undefined, ctx());
    expect(safeFetch.assertUrlSafe).toHaveBeenCalledWith('https://api.example.com/data');
  });

  it('🚨 SECURITY: assertUrlSafe throw → executor throw (no fetch)', async () => {
    vi.mocked(safeFetch.assertUrlSafe).mockImplementation(() => {
      throw new Error('SSRF blocked');
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(httpExecutor(baseCfg, undefined, ctx())).rejects.toThrow('SSRF blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('🚨 SECURITY: redirect a URL unsafe → HttpError "redirect bloccato"', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        headers: new Headers({ location: 'https://internal.local/x' }),
      }));
    vi.mocked(safeFetch.validateUrlForFetch).mockReturnValue({ ok: false, reason: 'PRIVATE_IP' });
    await expect(httpExecutor(baseCfg, undefined, ctx())).rejects.toThrow(/redirect bloccato/);
  });
});

describe('🚨 happy path single page', () => {
  it('🚨 GET → output con status/statusText/headers/body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      status: 200, jsonBody: { value: 42 },
    }));
    const r = await httpExecutor(baseCfg, undefined, ctx());
    expect(r.output).toMatchObject({
      status: 200, statusText: 'OK',
      body: { value: 42 },
    });
    expect(typeof r.durationMs).toBe('number');
  });

  it('🚨 statusCodeOnly=true → output SENZA body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    const r = await httpExecutor({ ...baseCfg, statusCodeOnly: true }, undefined, ctx());
    expect(r.output).not.toHaveProperty('body');
  });

  it('🚨 followRedirects=true: 302 → 200 (re-validate next URL)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/final' }),
      }))
      .mockResolvedValueOnce(mockResponse({ jsonBody: { final: true } }));
    const r = await httpExecutor(baseCfg, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((r.output as Record<string, unknown>).body).toEqual({ final: true });
  });

  it('🚨 OOM: il body del redirect intermedio viene CANCELLATO, MAI letto in RAM (anti-OOM)', async () => {
    // Vettore reale: un server risponde 3xx con un body enorme. Drenarlo con
    // res.text() lo bufferizzerebbe TUTTO senza cap → OOM (readBodyWithCap copre
    // solo la risposta finale). Il drain DEVE cancellare lo stream, non leggerlo.
    const cancelSpy = vi.fn(async () => undefined);
    const textSpy = vi.fn(async () => { throw new Error('🚨 body letto in RAM senza cap (OOM vector)'); });
    const redirectRes = {
      status: 302, statusText: 'Found', ok: false,
      headers: new Headers({ location: 'https://api.example.com/final' }),
      body: { cancel: cancelSpy } as unknown as ReadableStream,
      text: textSpy,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectRes)
      .mockResolvedValueOnce(mockResponse({ jsonBody: { final: true } }));
    const r = await httpExecutor(baseCfg, undefined, ctx());
    expect((r.output as Record<string, unknown>).body).toEqual({ final: true });
    expect(cancelSpy).toHaveBeenCalledTimes(1);   // stream cancellato (costo 0)
    expect(textSpy).not.toHaveBeenCalled();        // MAI bufferizzato in RAM
  });

  // ── H1: cross-host auth-strip. Il loop di redirect inline (necessario per il
  // dispatcher per-host) deve replicare lo strip cross-host di safeFetchWithRedirects,
  // altrimenti il Bearer/API-key del cliente viaggia verso un host attacker-controlled.
  it('🚨 H1 SECURITY: redirect verso host DIVERSO → Authorization NON inviata al 2° fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        headers: new Headers({ location: 'https://evil.attacker.org/callback' }),
      }))
      .mockResolvedValueOnce(mockResponse({ jsonBody: { ok: true } }));
    const cfg = { ...baseCfg, authMode: 'bearer' as const, bearerToken: 'secret-token' };
    await httpExecutor(cfg, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 1° fetch (host iniziale) → Authorization presente.
    const firstHeaders = (fetchSpy.mock.calls[0]![1]!).headers as Headers;
    expect(firstHeaders.get('authorization')).toBe('Bearer secret-token');
    // 2° fetch (host DIVERSO) → Authorization RIMOSSA (anti furto token).
    const secondHeaders = (fetchSpy.mock.calls[1]![1]!).headers as Headers;
    expect(secondHeaders.get('authorization')).toBeNull();
  });

  it('🚨 H1 anti-regressione: redirect SAME-host → Authorization PRESERVATA', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({
        status: 302,
        headers: new Headers({ location: 'https://api.example.com/final' }),
      }))
      .mockResolvedValueOnce(mockResponse({ jsonBody: { ok: true } }));
    const cfg = { ...baseCfg, authMode: 'bearer' as const, bearerToken: 'secret-token' };
    await httpExecutor(cfg, undefined, ctx());
    const secondHeaders = (fetchSpy.mock.calls[1]![1]!).headers as Headers;
    expect(secondHeaders.get('authorization')).toBe('Bearer secret-token');
  });

  it('🚨 followRedirects=false: 302 → ritorna 302 senza follow', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      status: 302,
      headers: new Headers({ location: 'https://api.example.com/final' }),
    }));
    const r = await httpExecutor({ ...baseCfg, followRedirects: false }, undefined, ctx());
    expect((r.output as Record<string, unknown>).status).toBe(302);
  });

  it('🚨 throwOnError=true + !ok → throw HttpError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      status: 500, statusText: 'Server Error',
    }));
    await expect(httpExecutor({ ...baseCfg, throwOnError: true }, undefined, ctx()))
      .rejects.toThrow();
  });

  it('🚨 throwOnError=false + 500 → output con status 500 (no throw)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      status: 500, statusText: 'Server Error',
    }));
    const r = await httpExecutor(baseCfg, undefined, ctx());
    expect((r.output as Record<string, unknown>).status).toBe(500);
  });
});

describe('🚨 retry on status', () => {
  it('🚨 retryOnStatus "503" → retry su 503 (poi success)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 200, jsonBody: { ok: true } }));
    const r = await httpExecutor({
      ...baseCfg, retryOnStatus: '503', retryCount: 1, retryInitialDelayMs: 1,
    }, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((r.output as Record<string, unknown>).status).toBe(200);
  });

  it('🚨 4xx NON in retryOnStatus → NO retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ status: 404 }));
    await httpExecutor({ ...baseCfg, retryOnStatus: '500', retryCount: 3 }, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── retryStrategy: un solo livello (review nodi). Il retry INTERNO del nodo è attivo
  //    solo quando l'owner è il nodo (auto/node). Con 'workflow'/'none' il nodo NON
  //    ritenta (lo farebbe l'engine, qui non presente) → singola fetch.
  it('🚨 retryStrategy=workflow → il nodo NON ritenta internamente (engine owner): 1 sola fetch su 503', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ status: 503 }));
    const r = await httpExecutor({ ...baseCfg, retryStrategy: 'workflow', retryOnStatus: '503', retryCount: 3, retryInitialDelayMs: 1 }, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(1); // niente retry interno
    expect((r.output as Record<string, unknown>).status).toBe(503); // throwOnError default false → response ritornata
  });

  it('🚨 retryStrategy=none → nessun retry interno: 1 sola fetch su 503', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ status: 503 }));
    await httpExecutor({ ...baseCfg, retryStrategy: 'none', retryOnStatus: '503', retryCount: 3, retryInitialDelayMs: 1 }, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('🚨 retryStrategy=auto (default, nodo self-managed) → ritenta internamente: 503→200 = 2 fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 200, jsonBody: { ok: true } }));
    const r = await httpExecutor({ ...baseCfg, retryStrategy: 'auto', retryOnStatus: '503', retryCount: 1, retryInitialDelayMs: 1 }, undefined, ctx());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((r.output as Record<string, unknown>).status).toBe(200);
  });
});

describe('🚨 abort signal propagation', () => {
  it('🚨 context.abortSignal abort → fetch internal abort', async () => {
    const externalAbort = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const initSignal = (init)?.signal;
      return new Promise((_resolve, reject) => {
        initSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        // simula long request
      });
    });
    const promise = httpExecutor(baseCfg, undefined, ctx({ abortSignal: externalAbort.signal }));
    externalAbort.abort();
    await expect(promise).rejects.toThrow();
  });
});

describe('🚨 allowSelfSigned — gated alla allowlist host-interni (#201 preservato per i pubblici)', () => {
  // Sentinel dispatcher per asserire QUALE viene passato a fetch.
  const INSECURE = { __kind: 'insecure-tls' };
  const PERMISSIVE = { __kind: 'permissive' };
  // Resolver che simula il runtime: 'internal.box' è allowlisted, il resto no.
  const resolver = (host: string, allowSelfSigned: boolean): { allowlisted: boolean; dispatcher?: unknown } =>
    host === 'internal.box'
      ? { allowlisted: true, dispatcher: allowSelfSigned ? INSECURE : PERMISSIVE }
      : { allowlisted: false };

  it('🚨 #201: host PUBBLICO + allowSelfSigned=true → IGNORATO (warn), SSRF attivo, NESSUN dispatcher (TLS verificato)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    const c = ctx({ resolveOutboundDispatcher: resolver });
    await httpExecutor({ ...baseCfg, allowSelfSigned: true }, undefined, c);
    expect(c.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('allowSelfSigned=true IGNORATO'),
      expect.objectContaining({ node: 'action_http' }),
    );
    expect(safeFetch.assertUrlSafe).toHaveBeenCalled(); // SSRF guard attivo sul pubblico
    const init = fetchSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('dispatcher'); // niente bypass TLS sul pubblico
  });

  it('🚨 host ALLOWLISTED + allowSelfSigned=true → dispatcher INSECURE-TLS, SSRF saltato, NESSUN warn', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    const c = ctx({ resolveOutboundDispatcher: resolver });
    await httpExecutor({ ...baseCfg, url: 'https://internal.box/x', allowSelfSigned: true }, undefined, c);
    expect(c.logger.warn).not.toHaveBeenCalled();
    expect(safeFetch.assertUrlSafe).not.toHaveBeenCalled(); // trust esplicito → SSRF saltato
    const init = fetchSpy.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(INSECURE);
  });

  it('🚨 host ALLOWLISTED + allowSelfSigned=false → dispatcher PERMISSIVO (raggiunge interno) ma TLS ancora verificato', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    const c = ctx({ resolveOutboundDispatcher: resolver });
    await httpExecutor({ ...baseCfg, url: 'https://internal.box/x', allowSelfSigned: false }, undefined, c);
    const init = fetchSpy.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(PERMISSIVE); // NON insecure → TLS verificato
  });

  it('🚨 SENZA resolver (context legacy) → comportamento #201: SSRF attivo, allowSelfSigned ignorato, no dispatcher', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    await httpExecutor({ ...baseCfg, allowSelfSigned: true }, undefined, ctx());
    expect(safeFetch.assertUrlSafe).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('dispatcher');
  });
});

describe('🚨 response format', () => {
  it('🚨 format=json: text parsato JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      headers: new Headers({ 'content-type': 'application/json' }),
      textBody: '{"a":1}',
    }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'json' }, undefined, ctx());
    expect((r.output as Record<string, unknown>).body).toEqual({ a: 1 });
  });

  it('🚨 format=text: ritorna stringa raw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      headers: new Headers({ 'content-type': 'text/plain' }),
      textBody: 'plain text response',
    }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'text' }, undefined, ctx());
    expect((r.output as Record<string, unknown>).body).toBe('plain text response');
  });

  it('🚨 format=json + body non valido → fallback testo (no throw)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse({
      headers: new Headers({ 'content-type': 'application/json' }),
      textBody: 'NOT-JSON{',
    }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'json' }, undefined, ctx());
    expect((r.output as Record<string, unknown>).body).toBe('NOT-JSON{');
  });

  it('🚨 format=auto + octet-stream → handle BinaryData (ref-primario; senza store = inline base64)', async () => {
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    const arrBuf = new TextEncoder().encode('binary data').buffer;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200, statusText: 'OK', ok: true, headers,
      text: async () => '',
      arrayBuffer: async () => arrBuf,
    } as unknown as Response);
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'auto' }, undefined, ctx()); // no writeBinary
    const body = (r.output as Record<string, unknown>).body as { __ffBinary?: boolean; encoding?: string; data?: string };
    expect(body.__ffBinary).toBe(true);            // handle, non più stringa base64
    expect(body.encoding).toBe('base64');          // inline (fail-soft, no store)
    expect(Buffer.from(body.data ?? '', 'base64').toString()).toBe('binary data');
  });
});

describe('🚨 max redirects guard', () => {
  it('🚨 oltre MAX_REDIRECTS (5) → ritorna ultima response (no infinite loop)', async () => {
    // 7 hop di redirect; loop si ferma dopo 5
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({
      status: 302,
      headers: new Headers({ location: 'https://api.example.com/loop' }),
    }));
    const r = await httpExecutor(baseCfg, undefined, ctx());
    // MAX_REDIRECTS=5 → 6 chiamate (initial + 5 redirects)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(6);
    expect((r.output as Record<string, unknown>).status).toBe(302);
  });
});

describe('🚨 pagination invalid mode', () => {
  it('🚨 paginationMode inesistente → ValidationError', async () => {
    await expect(httpExecutor({
      ...baseCfg, paginationMode: 'bogus-mode',
    }, undefined, ctx())).rejects.toThrow();
  });
});

describe('🚨 method + body', () => {
  it('🚨 GET/HEAD: NO body sent (RFC 7231)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    await httpExecutor({
      ...baseCfg, method: 'GET', bodyType: 'json', body: { x: 1 },
    }, undefined, ctx());
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.body).toBeUndefined();
  });

  it('🚨 POST + json body → header Content-Type application/json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse());
    await httpExecutor({
      ...baseCfg, method: 'POST', bodyType: 'json', body: { x: 1 },
    }, undefined, ctx());
    const init = fetchSpy.mock.calls[0]![1]!;
    // R6: gli header sono ora una Headers (case-insensitive) → si leggono con .get().
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });
});

describe('🚨 zod validation', () => {
  it('🚨 url mancante → throw (Zod min(1))', async () => {
    await expect(httpExecutor({ method: 'GET', url: '' }, undefined, ctx()))
      .rejects.toThrow();
  });
});

describe('🚨 GAP2 FLIP — responseFormat=binary → handle BinaryData (ref-primario)', () => {
  // Response binaria con byte arbitrari (incl. NUL/high) + header controllati.
  function binResponse(bytes: Buffer, headers: Record<string, string>): Response {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return {
      status: 200, statusText: 'OK', ok: true,
      headers: new Headers(headers),
      text: async (): Promise<string> => bytes.toString('binary'),
      arrayBuffer: async (): Promise<ArrayBuffer> => ab,
    } as unknown as Response;
  }
  // writeBinary fake col CONTRATTO reale (sha256 content-address); cattura input.
  type WriteBinaryFn = (data: Buffer, meta: { mimeType: string; fileName?: string }) => Promise<BinaryData>;
  function fakeWriteBinary(): { fn: WriteBinaryFn; captured: { data?: Buffer; meta?: { mimeType: string; fileName?: string } } } {
    const captured: { data?: Buffer; meta?: { mimeType: string; fileName?: string } } = {};
    const fn: WriteBinaryFn = async (data, meta): Promise<BinaryData> => {
      captured.data = data; captured.meta = meta;
      return makeBinaryRef({ mimeType: meta.mimeType, ref: createHash('sha256').update(data).digest('hex'), size: data.byteLength, ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}) });
    };
    return { fn, captured };
  }

  it('🚨 binary CON writeBinary → body è BinaryData ref; byte+mime+filename corretti', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]); // %PDF + NUL + high byte
    const { fn, captured } = fakeWriteBinary();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(bytes, {
      'content-type': 'application/pdf; charset=binary',
      'content-disposition': 'attachment; filename="report.pdf"',
    }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'binary' }, undefined, ctx({ writeBinary: fn }));
    const body = (r.output as { body: unknown }).body;
    expect(isBinaryData(body)).toBe(true);
    const bin = body as BinaryData;
    expect(bin.encoding).toBe('ref');
    expect(bin.mimeType).toBe('application/pdf');   // charset strippato
    expect(bin.fileName).toBe('report.pdf');
    expect(bin.ref).toMatch(/^[0-9a-f]{64}$/u);
    // l'executor ha letto l'arrayBuffer e passato i BYTE giusti allo store
    expect(captured.data?.equals(bytes)).toBe(true);
  });

  it('🚨 binary SENZA writeBinary → fallback BinaryData inline base64 (mai crash)', async () => {
    const bytes = Buffer.from([0x01, 0x02, 0x00, 0xfe]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(bytes, { 'content-type': 'image/png' }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'binary' }, undefined, ctx()); // no writeBinary
    const bin = (r.output as { body: BinaryData }).body;
    expect(isBinaryData(bin)).toBe(true);
    expect(bin.encoding).toBe('base64');
    expect(bin.mimeType).toBe('image/png');
    expect(Buffer.from(bin.data!, 'base64').equals(bytes)).toBe(true);
  });

  it('🚨 SECURITY: filename Content-Disposition con path-traversal → sanitizzato a basename', async () => {
    const { fn, captured } = fakeWriteBinary();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(Buffer.from([0x00]), {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="../../../etc/passwd"',
    }));
    await httpExecutor({ ...baseCfg, responseFormat: 'binary' }, undefined, ctx({ writeBinary: fn }));
    expect(captured.meta?.fileName).toBe('passwd'); // basename → niente ../
  });

  it('🚨 filename*=UTF-8 (RFC 6266) decodificato', async () => {
    const { fn, captured } = fakeWriteBinary();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(Buffer.from([0x00]), {
      'content-type': 'application/octet-stream',
      'content-disposition': "attachment; filename*=UTF-8''fattura%20n%2042.pdf",
    }));
    await httpExecutor({ ...baseCfg, responseFormat: 'binary' }, undefined, ctx({ writeBinary: fn }));
    expect(captured.meta?.fileName).toBe('fattura n 42.pdf');
  });

  it('🚨 auto + application/octet-stream → ANCHE handle (auto-detection, niente base64 string)', async () => {
    const bytes = Buffer.from([0x09, 0x08, 0x07]);
    const { fn, captured } = fakeWriteBinary();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(bytes, { 'content-type': 'application/octet-stream' }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'auto' }, undefined, ctx({ writeBinary: fn }));
    expect(isBinaryData((r.output as { body: unknown }).body)).toBe(true);
    expect(captured.data?.equals(bytes)).toBe(true); // i byte sono andati allo store
  });

  it('🚨 NON-binario invariato: responseFormat=text → stringa (MAI handle, writeBinary mai chiamato)', async () => {
    const spy = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(binResponse(Buffer.from('hello world'), { 'content-type': 'text/plain' }));
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'text' }, undefined, ctx({ writeBinary: spy }));
    expect((r.output as { body: unknown }).body).toBe('hello world');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('🚨 GAP2 FLIP — bodyType=binary: UPLOAD dei byte di un handle BinaryData in input', () => {
  const inlineBin = (buf: Buffer, mime: string): unknown =>
    ({ __ffBinary: true, encoding: 'base64', mimeType: mime, size: buf.length, data: buf.toString('base64') });

  it('🚨 input BinaryData inline → fetch body = byte risolti + Content-Type dal mimeType', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init): Promise<Response> => {
      captured = init; return mockResponse({ jsonBody: { ok: 1 } });
    });
    await httpExecutor({ ...baseCfg, method: 'POST', bodyType: 'binary' }, inlineBin(bytes, 'application/pdf'), ctx());
    expect(Buffer.from(captured!.body as Uint8Array).equals(bytes)).toBe(true);
    expect((captured!.headers as Headers).get('Content-Type')).toBe('application/pdf');
  });

  it('🚨 input BinaryData ref → readBinary risolve dal disco → fetch body', async () => {
    const bytes = Buffer.from('upload-from-disk');
    const readBinary = async (_r: string): Promise<Buffer> => bytes;
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init): Promise<Response> => {
      captured = init; return mockResponse({ jsonBody: { ok: 1 } });
    });
    await httpExecutor(
      { ...baseCfg, method: 'POST', bodyType: 'binary' },
      { __ffBinary: true, encoding: 'ref', mimeType: 'application/octet-stream', size: bytes.length, ref: 'a'.repeat(64) },
      ctx({ readBinary }),
    );
    expect(Buffer.from(captured!.body as Uint8Array).equals(bytes)).toBe(true);
  });

  it('🚨 bodyType=binary senza handle in input → nessun body binario (fail-soft, non crasha)', async () => {
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init): Promise<Response> => {
      captured = init; return mockResponse({ jsonBody: { ok: 1 } });
    });
    await httpExecutor({ ...baseCfg, method: 'POST', bodyType: 'binary' }, { notBinary: true }, ctx());
    expect(captured!.body).toBeUndefined(); // placeholder {} → nessun body
  });
});

describe('🚨 cap dimensione risposta (anti-OOM/DoS — fix 2026-06-17, era promesso ma MAI enforced)', () => {
  /** Response con body STREAM controllabile + headers, senza content-length. */
  function streamResponse(chunks: Uint8Array[], headers: Record<string, string>): { res: Response; cancel: ReturnType<typeof vi.fn> } {
    const cancel = vi.fn(async () => undefined);
    let i = 0;
    const reader = {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
        i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
      cancel,
    };
    const res = {
      status: 200, ok: true, statusText: 'OK',
      headers: new Headers(headers),
      body: { getReader: () => reader },
      arrayBuffer: vi.fn(), text: vi.fn(),
    } as unknown as Response;
    return { res, cancel };
  }

  it('🚨 content-length OLTRE il cap → errore SUBITO, body MAI letto (no OOM)', async () => {
    const arrayBuffer = vi.fn();
    const text = vi.fn();
    const bodyCancel = vi.fn(async () => undefined);
    const res = {
      status: 200, ok: true, statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(80 * 1024 * 1024) }),
      arrayBuffer, text, body: { cancel: bodyCancel },
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res);
    await expect(httpExecutor({ ...baseCfg, responseFormat: 'binary' }, undefined, ctx()))
      .rejects.toThrow(/troppo grande/i);
    expect(arrayBuffer).not.toHaveBeenCalled(); // mai bufferizzato
    expect(text).not.toHaveBeenCalled();
  });

  it('🚨 body in STREAMING oltre il cap (content-length assente/bugiardo) → errore + stream CANCELLATO', async () => {
    const chunk = new Uint8Array(700 * 1024); // 700 KB
    const { res, cancel } = streamResponse([chunk, chunk, chunk], { 'content-type': 'application/octet-stream' }); // 2.1 MB
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res);
    await expect(httpExecutor({ ...baseCfg, responseFormat: 'binary', maxResponseMb: 1 }, undefined, ctx()))
      .rejects.toThrow(/troppo grande/i);
    expect(cancel).toHaveBeenCalled(); // niente accumulo infinito in RAM
  });

  it('body entro il cap → letto correttamente (text via stream)', async () => {
    const { res } = streamResponse([new TextEncoder().encode('ciao mondo')], { 'content-type': 'text/plain' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res);
    const r = await httpExecutor({ ...baseCfg, responseFormat: 'text' }, undefined, ctx());
    expect((r.output as { body: unknown }).body).toBe('ciao mondo');
  });

  it('🚨 cap override per-call (maxResponseMb=1) rispettato: 1.4 MB → errore', async () => {
    const chunk = new Uint8Array(700 * 1024); // 700 KB
    const { res } = streamResponse([chunk, chunk], { 'content-type': 'text/plain' }); // 1.4 MB > cap 1 MB
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res);
    await expect(httpExecutor({ ...baseCfg, responseFormat: 'text', maxResponseMb: 1 }, undefined, ctx()))
      .rejects.toThrow(/troppo grande/i);
  });

  it('🔒 cap NON-retriable: non viene ri-tentato (retryCount>0 → 1 sola fetch)', async () => {
    const chunk = new Uint8Array(2 * 1024 * 1024); // 2 MB > cap 1
    const { res } = streamResponse([chunk], { 'content-type': 'application/octet-stream' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    await expect(httpExecutor({ ...baseCfg, responseFormat: 'binary', maxResponseMb: 1, retryCount: 3 }, undefined, ctx()))
      .rejects.toThrow(/troppo grande/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // deterministico → 0 retry
  });
});

describe('🚨 OAuth2 client_credentials (integrazione executor)', () => {
  beforeEach(() => { clearOAuth2TokenCache(); });

  const oauthCfg = {
    ...baseCfg,
    authMode: 'oauth2' as const,
    oauth2TokenUrl: 'https://login.example.com/token',
    oauth2ClientId: 'cid',
    oauth2ClientSecret: 'sec',
    oauth2AuthStyle: 'header' as const,
  };
  const tokenRes = (token: string) => new Response(
    JSON.stringify({ access_token: token, expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  it('🚨 ottiene il token, POI inietta Authorization: Bearer sulla request reale', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenRes('TKN-1'))
      .mockResolvedValueOnce(mockResponse({ jsonBody: { data: 'ok' } }));

    await httpExecutor(oauthCfg, {}, ctx());

    // 1ª fetch = token endpoint; 2ª = request reale col Bearer ottenuto.
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://login.example.com/token');
    expect(fetchSpy.mock.calls[1]![0]).toBe('https://api.example.com/data');
    const mainInit = fetchSpy.mock.calls[1]![1]!;
    expect((mainInit.headers as Headers).get('Authorization')).toBe('Bearer TKN-1');
  });

  it('🚨 SSRF: anche il token endpoint passa per assertUrlSafe (host non allowlisted)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenRes('T'))
      .mockResolvedValueOnce(mockResponse());
    await httpExecutor(oauthCfg, {}, ctx());
    expect(safeFetch.assertUrlSafe).toHaveBeenCalledWith('https://login.example.com/token');
  });

  it('🚨 token endpoint 401 → executor throw, NESSUNA request reale parte', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('bad_client', { status: 401, statusText: 'Unauthorized' }));
    await expect(httpExecutor(oauthCfg, {}, ctx())).rejects.toThrow(/OAuth2 token endpoint 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // solo il token, mai la request reale
  });
});

describe('🚨 R1 — niente leak di listener su context.abortSignal', () => {
  it('singola request → add e remove BILANCIATI (no accumulo)', async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ jsonBody: { ok: 1 } }));
    await httpExecutor(baseCfg, undefined, ctx({ abortSignal: ac.signal }));
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), expect.anything());
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length); // ogni add → un remove
  });

  it('🚨 RETRY (3 tentativi sullo STESSO signal) → 3 add E 3 remove, zero accumulo', async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse({ status: 500 }))
      .mockResolvedValueOnce(mockResponse({ status: 500 }))
      .mockResolvedValueOnce(mockResponse({ jsonBody: { ok: 1 } }));
    await httpExecutor(
      { ...baseCfg, retryStrategy: 'node', retryCount: 2, retryOnStatus: '500', retryInitialDelayMs: 0 },
      undefined, ctx({ abortSignal: ac.signal }),
    );
    expect(addSpy.mock.calls.length).toBe(3);    // 3 fetchOnce sullo stesso signal
    expect(removeSpy.mock.calls.length).toBe(3); // tutti rimossi (pre-fix: 0 remove → leak)
  });
});

describe('🚨 R6 — header case-insensitive (no doppio Content-Type)', () => {
  it('headersJson con content-type lowercase + body json → un solo CT, l\'esplicito vince', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse());
    await httpExecutor({
      ...baseCfg, method: 'POST', bodyType: 'json', body: { x: 1 },
      headersJson: JSON.stringify({ 'content-type': 'application/vnd.custom+json' }),
    }, undefined, ctx());
    const h = fetchSpy.mock.calls[0]![1]!.headers as Headers;
    // Headers è case-insensitive → 'content-type' esplicito copre il 'Content-Type'
    // del body (niente doppio header in uscita).
    expect(h.get('content-type')).toBe('application/vnd.custom+json');
  });
});
