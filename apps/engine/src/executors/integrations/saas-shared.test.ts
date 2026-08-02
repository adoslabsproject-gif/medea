/**
 * Test 2026-grade — executors/integrations/saas-shared.ts (jsonFetch + parsers).
 *
 * 🚨 jsonFetch: auth Bearer auto, JSON vs form encoding, timeout 20s default,
 *    204 → {}, 2xx empty body → {} (no JSON.parse crash), throw IntegrationError
 *    su !ok con httpStatus + retryable=true SOLO 5xx + 429.
 *
 * 🚨 parseJsonObj: array → throw INVALID_PAYLOAD, null/undefined/empty → {}.
 *
 * 🚨 parseSheetValues: 2D array native, JSON string, {values:[[..]]} wrapper.
 *
 * 🚨 getIntegrationLabel: string truthy → label, else null (no false-y leak).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));

const { jsonFetch, parseJsonObj, getIntegrationLabel, parseSheetValues } =
  await import('./saas-shared.js');
const { IntegrationError } = await import('./common.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function mockRes(
  body: unknown,
  opts: { status?: number; ok?: boolean; statusText?: string } = {},
): Response {
  const status = opts.status ?? 200;
  const text = body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    statusText: opts.statusText ?? 'OK',
    headers: new Headers(), // una Response reale ha SEMPRE headers (il cap legge content-length)
    text: async () => text,
  } as Response;
}

describe('🚨 jsonFetch — Bearer auth + body encoding', () => {
  it('🚨 token → Authorization: Bearer X', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('slack', 'https://api/x', 'my-token');
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('🚨 token null → NO Authorization header', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('slack', 'https://api/x', null);
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('🚨 custom Authorization override → NON sovrascritto', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('slack', 'https://api/x', 'token-from-arg', {
      headers: { Authorization: 'CustomAuth XYZ' },
    });
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('CustomAuth XYZ');
  });

  it('🚨 body presente + asForm=false → Content-Type application/json', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('x', 'https://api/x', null, {
      method: 'POST',
      body: { a: 1 },
    });
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('🚨 body + asForm=true → Content-Type application/x-www-form-urlencoded', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('x', 'https://api/x', null, {
      method: 'POST',
      body: 'key=value',
      asForm: true,
    });
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.body).toBe('key=value');
  });

  it('🚨 method default GET', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ ok: true }));
    await jsonFetch('x', 'https://api/x', null);
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
  });
});

describe('🚨 jsonFetch — response handling', () => {
  it('🚨 204 No Content → {} (no body parsing)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes(null, { status: 204 }));
    const r = await jsonFetch('x', 'https://api/x', null);
    expect(r).toEqual({});
  });

  it('🚨 2xx con body vuoto → {} (SendGrid 202 Accepted)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes(null, { status: 202 }));
    const r = await jsonFetch('x', 'https://api/x', null);
    expect(r).toEqual({});
  });

  it('🚨 200 con JSON valido → parsed', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 42, name: 'foo' }));
    const r = await jsonFetch<{ id: number; name: string }>('x', 'https://api/x', null);
    expect(r).toEqual({ id: 42, name: 'foo' });
  });

  it('🚨 4xx → throw IntegrationError + httpStatus + retryable=false', async () => {
    safeFetchMock.mockResolvedValueOnce(
      mockRes({ error: 'bad' }, { status: 400, ok: false, statusText: 'Bad Request' }),
    );
    try {
      await jsonFetch('slack', 'https://api/x', null);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.httpStatus).toBe(400);
      expect(err.retryable).toBe(false);
      expect(err.code).toBe('API_HTTP_ERROR');
      expect(err.message).toContain('400');
    }
  });

  it('🚨 5xx → retryable=true', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes('Internal Error', { status: 503, ok: false }));
    try {
      await jsonFetch('slack', 'https://api/x', null);
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.retryable).toBe(true);
      expect(err.httpStatus).toBe(503);
    }
  });

  it('🚨 429 Rate Limited → retryable=true', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes('Too Many Requests', { status: 429, ok: false }));
    try {
      await jsonFetch('slack', 'https://api/x', null);
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.retryable).toBe(true);
    }
  });

  it('🚨 401/403 → retryable=false (auth issue, no retry)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes('Forbidden', { status: 403, ok: false }));
    try {
      await jsonFetch('slack', 'https://api/x', null);
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.retryable).toBe(false);
    }
  });

  it('🚨 error body troncato a 300 char (no log flood)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes('x'.repeat(1000), { status: 500, ok: false }));
    try {
      await jsonFetch('slack', 'https://api/x', null);
      expect.fail('should throw');
    } catch (e) {
      const err = e as Error;
      // Il messaggio totale: "slack HTTP 500  — xxxxx..." con max 300 char dopo —
      const afterDash = err.message.split('— ')[1] ?? '';
      expect(afterDash.length).toBeLessThanOrEqual(300);
    }
  });

  it('🚨 OOM: body d-errore ENORME in streaming → letto CAPPATO (~8KB) + stream cancellato, MAI tutto in RAM', async () => {
    // Vettore reale: upstream non-2xx (500/429) con body gigante (HTML d-errore /
    // stack). Leggerlo con res.text() lo bufferizzava TUTTO → OOM. readErrorSnippet
    // deve fermarsi al cap e cancellare lo stream.
    const chunk = new Uint8Array(5 * 1024).fill(120); // 5KB di 'x'
    let reads = 0;
    const cancelSpy = vi.fn(async () => undefined);
    const reader = {
      read: async () => {
        reads += 1;
        return reads <= 100 ? { done: false, value: chunk } : { done: true, value: undefined };
      },
      cancel: cancelSpy,
    };
    const hugeErr = {
      status: 500,
      ok: false,
      statusText: 'Server Error',
      headers: new Headers(),
      body: { getReader: () => reader } as unknown as ReadableStream,
      text: async () => {
        throw new Error('🚨 body d-errore letto in RAM senza cap (OOM)');
      },
    } as unknown as Response;
    safeFetchMock.mockResolvedValueOnce(hugeErr);
    await expect(jsonFetch('slack', 'https://api/x', null)).rejects.toBeInstanceOf(
      IntegrationError,
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1); // stream cancellato
    expect(reads).toBeLessThanOrEqual(3); // ~8KB cap → max 2 chunk da 5KB letti, NON 100
  });
});

describe('🚨 parseJsonObj — strict object parsing', () => {
  it('🚨 undefined/null/empty → {}', () => {
    expect(parseJsonObj('x', undefined, 'field')).toEqual({});
    expect(parseJsonObj('x', null, 'field')).toEqual({});
    expect(parseJsonObj('x', '', 'field')).toEqual({});
  });

  it('🚨 object diretto → as-is', () => {
    expect(parseJsonObj('x', { a: 1 }, 'field')).toEqual({ a: 1 });
  });

  it('🚨 JSON string valido → parsed', () => {
    expect(parseJsonObj('x', '{"a":1}', 'field')).toEqual({ a: 1 });
  });

  it('🚨 SECURITY: array → throw INVALID_PAYLOAD (no [] as object)', () => {
    expect(() => parseJsonObj('slack', '[1,2,3]', 'field')).toThrow(IntegrationError);
    try {
      parseJsonObj('slack', '[1,2,3]', 'attachments');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.code).toBe('INVALID_PAYLOAD');
      expect(err.message).toContain('attachments');
    }
  });

  it('🚨 JSON null → throw (typeof null === object MA Array.isArray false → ok null guard)', () => {
    expect(() => parseJsonObj('x', 'null', 'field')).toThrow(IntegrationError);
  });

  it('🚨 JSON string malformato → throw INVALID_PAYLOAD', () => {
    expect(() => parseJsonObj('x', 'NOT-JSON{', 'field')).toThrow(IntegrationError);
  });

  it('🚨 number primitive (NOT string, NOT object) → {} (type guard)', () => {
    expect(parseJsonObj('x', 42 as never, 'field')).toEqual({});
  });
});

describe('🚨 getIntegrationLabel — string safety', () => {
  it('🚨 string truthy → label', () => {
    expect(getIntegrationLabel({ integrationLabel: 'work-account' })).toBe('work-account');
  });

  it('🚨 empty string → null (false-y guard)', () => {
    expect(getIntegrationLabel({ integrationLabel: '' })).toBeNull();
  });

  it('🚨 undefined → null', () => {
    expect(getIntegrationLabel({})).toBeNull();
  });

  it('🚨 non-string (number) → null (type guard)', () => {
    expect(getIntegrationLabel({ integrationLabel: 42 })).toBeNull();
  });

  it('🚨 boolean false → null', () => {
    expect(getIntegrationLabel({ integrationLabel: false })).toBeNull();
  });
});

describe('🚨 parseSheetValues — flexible input formats', () => {
  it('🚨 2D array nativo → as-is', () => {
    const arr = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    expect(parseSheetValues(arr)).toEqual(arr);
  });

  it('🚨 JSON string 2D array → parsed', () => {
    expect(parseSheetValues('[["x","y"],["z","w"]]')).toEqual([
      ['x', 'y'],
      ['z', 'w'],
    ]);
  });

  it('🚨 JSON string {values:[[..]]} wrapper → unwrap values', () => {
    expect(parseSheetValues('{"values":[[1,2],[3,4]]}')).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('🚨 object {values:[[..]]} nativo → unwrap', () => {
    expect(parseSheetValues({ values: [['a']] })).toEqual([['a']]);
  });

  it('🚨 malformed JSON → throw INVALID_PAYLOAD', () => {
    expect(() => parseSheetValues('NOT-JSON{')).toThrow(IntegrationError);
  });

  it('🚨 string empty → throw INVALID_PAYLOAD', () => {
    expect(() => parseSheetValues('')).toThrow(IntegrationError);
  });

  it('🚨 number primitive → throw INVALID_PAYLOAD', () => {
    expect(() => parseSheetValues(42 as never)).toThrow(IntegrationError);
  });

  it('🚨 error message helpful (esempi formato corretto)', () => {
    try {
      parseSheetValues('garbage');
    } catch (e) {
      expect((e as Error).message).toContain('array 2D');
      expect((e as Error).message).toContain('values');
    }
  });
});

describe('🚨 jsonFetch — cap risposta anti-OOM (fix 2026-06-17, protegge 24 connettori)', () => {
  function streamRes(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
    let i = 0;
    const reader = {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i >= chunks.length) return { done: true };
        const value = chunks[i++];
        return value ? { done: false, value } : { done: true };
      },
      cancel: async (): Promise<void> => undefined,
    };
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(headers),
      body: { getReader: () => reader },
      text: async (): Promise<string> => {
        throw new Error("non deve usare text() se c'è body stream");
      },
    } as unknown as Response;
  }

  it('🚨 content-length OLTRE il cap → throw, body MAI letto (no OOM)', async () => {
    const text = vi.fn();
    const bodyCancel = vi.fn(async () => undefined);
    safeFetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(30 * 1024 * 1024) }),
      body: { cancel: bodyCancel },
      text,
    } as unknown as Response);
    await expect(jsonFetch('slack', 'https://api/x', null)).rejects.toThrow(/troppo grande/i);
    expect(text).not.toHaveBeenCalled();
  });

  it('🚨 body in STREAMING oltre il cap (content-length assente) → throw, stream cancellato', async () => {
    const chunks = Array.from({ length: 27 }, () => new Uint8Array(1024 * 1024)); // 27 MB > 25
    safeFetchMock.mockResolvedValueOnce(streamRes(chunks));
    await expect(jsonFetch('slack', 'https://api/x', null)).rejects.toThrow(/troppo grande/i);
  });

  it('entro il cap (stream) → JSON parsato correttamente', async () => {
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValueOnce(
      streamRes([new TextEncoder().encode('{"ok":true,"id":7}')]),
    );
    const r = await jsonFetch<{ ok: boolean; id: number }>('slack', 'https://api/x', null);
    expect(r).toEqual({ ok: true, id: 7 });
  });
});
