/**
 * Test 2026-grade — executors/integrations/hubspot.ts (CRM v3 API).
 *
 * 🚨 PAT TOKEN STRICT: accessToken DEVE iniziare con "pat-" (formato HubSpot).
 *    Token mal-formato → INVALID_CREDENTIALS (no API call wasted).
 *
 * 🚨 7 operations: createContact / updateContact / getContact / listContacts
 *    / createDeal / updateDeal / createCompany.
 *
 * 🚨 EMAIL → ID LOOKUP: updateContact e getContact possono usare email
 *    invece di objectId (HubSpot idProperty=email).
 *
 * 🚨 LIMIT CLAMP: listContacts limit 1..100 (HubSpot cap).
 *
 * 🚨 propertiesJson: string JSON / object / vuoto. Array → throw INVALID_PAYLOAD.
 *
 * 🚨 RETRYABLE: 5xx + 429 → retry. 4xx → no retry (config error).
 *
 * 🚨 204 No Content → return {} (no JSON.parse crash).
 *
 * 🚨 ABORT SIGNAL: forwardato a hsFetch quando present.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
const getIntegrationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));
vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: getIntegrationMock,
}));
// SAFETY: backoff withRetry fa sleep reale (default 1s/2s/4s) → timeout test.
// Skip-sleep mock fa "instant retry" (totale rounds = retries+1 = 4).
vi.mock('node:timers/promises', () => ({
  setTimeout: async () => undefined,
}));

const { hubspotExecutor } = await import('./hubspot.js');
const { IntegrationError } = await import('./common.js');

const ctx = () =>
  ({
    runId: 'r',
    workflowId: 'w',
    nodeId: 'n',
    tenantId: 't1',
    defId: 'community_hubspot',
    llmProviders: [],
    nodeOutputs: {},
    secrets: {},
  }) as never;

function mockRes(
  body: unknown,
  opts: { status?: number; ok?: boolean; statusText?: string } = {},
): Response {
  const status = opts.status ?? 200;
  const json = async () => body;
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    statusText: opts.statusText ?? 'OK',
    headers: new Headers(),
    json,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default integration: pat- token valido
  getIntegrationMock.mockReturnValue({
    id: 'int-1',
    provider: 'hubspot',
    label: null,
    credentials: { accessToken: 'pat-VALID-xxx' },
  });
});

describe('🚨 operation validation', () => {
  it('🚨 operation missing → throw INVALID_PAYLOAD', async () => {
    await expect(hubspotExecutor({ operation: '' } as never, null, ctx())).rejects.toThrow(
      /operation.+obbligatorio/u,
    );
  });

  it('🚨 operation sconosciuta → INVALID_PAYLOAD con name', async () => {
    safeFetchMock.mockResolvedValue(mockRes({ id: '1' }));
    await expect(
      hubspotExecutor({ operation: 'deleteEverything' } as never, null, ctx()),
    ).rejects.toThrow(/deleteEverything.+non supportata/u);
  });

  it('🚨 operation trim whitespace', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor({ operation: '  createContact  ' } as never, null, ctx());
    expect(safeFetchMock).toHaveBeenCalled();
  });
});

describe('🚨 PAT token validation', () => {
  it('🚨 accessToken NON inizia con "pat-" → INVALID_CREDENTIALS', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int-1',
      provider: 'hubspot',
      label: null,
      credentials: { accessToken: 'sk-wrong-prefix' },
    });
    await expect(
      hubspotExecutor({ operation: 'createContact' } as never, null, ctx()),
    ).rejects.toThrow(/INVALID_CREDENTIALS|pat-/u);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 accessToken vuoto → INVALID_CREDENTIALS', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int-1',
      provider: 'hubspot',
      label: null,
      credentials: { accessToken: '' },
    });
    await expect(
      hubspotExecutor({ operation: 'createContact' } as never, null, ctx()),
    ).rejects.toThrow(/INVALID_CREDENTIALS|pat-/u);
  });

  it('🚨 integration NON configurato → NOT_CONFIGURED', async () => {
    getIntegrationMock.mockReturnValue(null);
    await expect(
      hubspotExecutor({ operation: 'createContact' } as never, null, ctx()),
    ).rejects.toThrow(/NOT_CONFIGURED|not configured/u);
  });
});

describe('🚨 createContact', () => {
  it('🚨 happy: POST /crm/v3/objects/contacts con properties', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-42', properties: { email: 'a@b.com' } }));
    const r = await hubspotExecutor(
      {
        operation: 'createContact',
        propertiesJson: '{"email":"a@b.com","firstname":"Alice"}',
      } as never,
      null,
      ctx(),
    );
    const out = r.output as { objectId: string; data: { id: string } };
    expect(out.objectId).toBe('c-42');
    expect(out.data.id).toBe('c-42');
    const url = safeFetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts');
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      properties: { email: 'a@b.com', firstname: 'Alice' },
    });
  });

  it('🚨 email param injected nelle properties se non già presente', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        email: 'b@c.com',
        propertiesJson: '{"firstname":"Bob"}',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      properties: Record<string, string>;
    };
    expect(body.properties.email).toBe('b@c.com');
    expect(body.properties.firstname).toBe('Bob');
  });

  it('🚨 email NON sovrascrive properties.email se già presente', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        email: 'param@x.com',
        propertiesJson: '{"email":"prop@y.com"}',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      properties: Record<string, string>;
    };
    expect(body.properties.email).toBe('prop@y.com');
  });

  it('🚨 Authorization Bearer pat- header injected', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pat-VALID-xxx');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('🚨 updateContact con email lookup', () => {
  it('🚨 objectId esplicito → PATCH diretto', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-99', properties: {} }));
    const r = await hubspotExecutor(
      {
        operation: 'updateContact',
        objectId: 'c-99',
        propertiesJson: '{"firstname":"Updated"}',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const url = safeFetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/crm/v3/objects/contacts/c-99');
    expect((r.output as { objectId: string }).objectId).toBe('c-99');
  });

  it('🚨 SOLO email → lookup PRIMA poi PATCH', async () => {
    // Lookup
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-lookup-99' }));
    // PATCH
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-lookup-99', properties: {} }));
    const r = await hubspotExecutor(
      {
        operation: 'updateContact',
        email: 'find@me.com',
        propertiesJson: '{}',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    // First call: lookup with idProperty=email
    expect(safeFetchMock.mock.calls[0]![0]).toContain('idProperty=email');
    expect(safeFetchMock.mock.calls[0]![0]).toContain('find%40me.com'); // URL encoded
    // Second call: PATCH with resolved id
    expect(safeFetchMock.mock.calls[1]![0]).toContain('/contacts/c-lookup-99');
    expect((safeFetchMock.mock.calls[1]![1] as RequestInit).method).toBe('PATCH');
    expect((r.output as { objectId: string }).objectId).toBe('c-lookup-99');
  });

  it('🚨 né objectId né email → INVALID_PAYLOAD', async () => {
    await expect(
      hubspotExecutor({ operation: 'updateContact' } as never, null, ctx()),
    ).rejects.toThrow(/objectId o email/u);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 SECURITY: email con char speciali → URL encoded', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'updateContact',
        email: 'user+test@x.com',
        propertiesJson: '{}',
      } as never,
      null,
      ctx(),
    );
    // %2B per "+", %40 per "@"
    expect(safeFetchMock.mock.calls[0]![0]).toContain('user%2Btest%40x.com');
  });
});

describe('🚨 getContact', () => {
  it('🚨 objectId → GET diretto NO idProperty', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'getContact',
        objectId: 'c-1',
      } as never,
      null,
      ctx(),
    );
    const url = safeFetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/c-1');
    expect(url).not.toContain('idProperty');
  });

  it('🚨 email → GET con idProperty=email + encode', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'getContact',
        email: 'a@b.com',
      } as never,
      null,
      ctx(),
    );
    const url = safeFetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('?idProperty=email');
    expect(url).toContain('a%40b.com');
  });

  it('🚨 né email né objectId → INVALID_PAYLOAD', async () => {
    await expect(
      hubspotExecutor({ operation: 'getContact' } as never, null, ctx()),
    ).rejects.toThrow(/email o objectId/u);
  });
});

describe('🚨 listContacts CLAMP', () => {
  it('🚨 limit default 50', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [{ id: '1' }] }));
    await hubspotExecutor({ operation: 'listContacts' } as never, null, ctx());
    const url = safeFetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=50');
  });

  it('🚨 limit clamp >100 → 100 (cap HubSpot API)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [] }));
    await hubspotExecutor({ operation: 'listContacts', limit: 99999 } as never, null, ctx());
    expect(safeFetchMock.mock.calls[0]![0]).toContain('limit=100');
  });

  it('🚨 limit clamp <1 → 1', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [] }));
    await hubspotExecutor({ operation: 'listContacts', limit: -5 } as never, null, ctx());
    expect(safeFetchMock.mock.calls[0]![0]).toContain('limit=1');
  });

  it('🚨 count = results.length', async () => {
    safeFetchMock.mockResolvedValueOnce(
      mockRes({ results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    );
    const r = await hubspotExecutor({ operation: 'listContacts' } as never, null, ctx());
    expect((r.output as { count: number }).count).toBe(3);
  });
});

describe('🚨 createDeal / updateDeal / createCompany', () => {
  it('🚨 createDeal: POST /crm/v3/objects/deals', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'd-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'createDeal',
        propertiesJson: '{"dealname":"Big Deal","amount":"5000"}',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/crm/v3/objects/deals');
    expect((safeFetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('🚨 updateDeal SENZA objectId → INVALID_PAYLOAD', async () => {
    await expect(
      hubspotExecutor({ operation: 'updateDeal' } as never, null, ctx()),
    ).rejects.toThrow(/updateDeal richiede objectId/u);
  });

  it('🚨 updateDeal happy: PATCH', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'd-2', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'updateDeal',
        objectId: 'd-2',
        propertiesJson: '{"dealstage":"closedwon"}',
      } as never,
      null,
      ctx(),
    );
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/deals/d-2');
  });

  it('🚨 createCompany: POST /crm/v3/objects/companies', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'co-1', properties: {} }));
    await hubspotExecutor(
      {
        operation: 'createCompany',
        propertiesJson: '{"name":"Acme"}',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/crm/v3/objects/companies');
  });
});

describe('🚨 parseProperties — JSON safety', () => {
  it('🚨 propertiesJson string valida → parsed', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        propertiesJson: '{"a":1,"b":"x"}',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      properties: { a: number; b: string };
    };
    expect(body.properties).toEqual({ a: 1, b: 'x' });
  });

  it('🚨 propertiesJson object → as-is', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        propertiesJson: { direct: 'object' },
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      properties: Record<string, string>;
    };
    expect(body.properties.direct).toBe('object');
  });

  it('🚨 propertiesJson vuoto/null/undefined → {}', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        propertiesJson: '',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      properties: Record<string, unknown>;
    };
    expect(body.properties).toEqual({});
  });

  it('🚨 SECURITY: propertiesJson ARRAY → throw INVALID_PAYLOAD', async () => {
    await expect(
      hubspotExecutor(
        {
          operation: 'createContact',
          propertiesJson: '[1,2,3]',
        } as never,
        null,
        ctx(),
      ),
    ).rejects.toThrow(/parse error|must be a JSON object/u);
  });

  it('🚨 propertiesJson malformato → throw INVALID_PAYLOAD', async () => {
    await expect(
      hubspotExecutor(
        {
          operation: 'createContact',
          propertiesJson: '{not-json',
        } as never,
        null,
        ctx(),
      ),
    ).rejects.toThrow(/parse error/u);
  });
});

describe('🚨 hsFetch — error handling', () => {
  it('🚨 401 → IntegrationError httpStatus 401 retryable=false', async () => {
    safeFetchMock.mockResolvedValueOnce(
      mockRes(
        { message: 'Unauthorized', category: 'INVALID_AUTHENTICATION' },
        { status: 401, ok: false, statusText: 'Unauthorized' },
      ),
    );
    try {
      await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.httpStatus).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.code).toBe('API_HTTP_ERROR');
      expect(err.message).toContain('Unauthorized');
      expect(err.message).toContain('INVALID_AUTHENTICATION');
    }
  });

  it('🚨 500 → retryable=true (server side)', async () => {
    safeFetchMock.mockResolvedValue(
      mockRes('Internal Server Error', { status: 500, ok: false, statusText: 'Internal' }),
    );
    try {
      await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.retryable).toBe(true);
    }
  });

  it('🚨 429 → retryable=true (rate limit)', async () => {
    safeFetchMock.mockResolvedValue(mockRes('Too Many Requests', { status: 429, ok: false }));
    try {
      await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.retryable).toBe(true);
    }
  });

  it('🚨 204 No Content → {} (no JSON.parse crash)', async () => {
    // 204 risposta su una mutation che non ritorna body
    // L'executor wrappa con r.id quindi 204 + assert objectId=undefined
    safeFetchMock.mockResolvedValueOnce(mockRes(null, { status: 204, ok: true }));
    const r = await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
    const out = r.output as { objectId: string | null | undefined; data: unknown };
    // r.id è undefined → resolvedId assegnato a undefined (TS strict ammette)
    expect(out.objectId == null).toBe(true); // null o undefined OK
  });

  it('🚨 error body NON JSON → fallback al messaggio plain', async () => {
    // 502 è retryable → withRetry fa 4 attempts. mockResolvedValue (no Once)
    // così tutte le chiamate rispondono 502 → IntegrationError finale.
    safeFetchMock.mockResolvedValue(
      mockRes('HTML error page', { status: 502, ok: false, statusText: 'Bad Gateway' }),
    );
    try {
      await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.message).toContain('502');
      expect(err.message).toContain('Bad Gateway');
    }
  });
});

describe('🚨 output shape contract', () => {
  it('🚨 ok=true + data + objectId + count', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1', properties: { email: 'x' } }));
    const r = await hubspotExecutor({ operation: 'createContact' } as never, null, ctx());
    expect(r.output).toMatchObject({
      ok: true,
      objectId: 'c-1',
      count: 0, // non-list operation
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('🚨 list operations: count > 0, objectId null', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [{ id: 'a' }, { id: 'b' }] }));
    const r = await hubspotExecutor({ operation: 'listContacts' } as never, null, ctx());
    expect(r.output).toMatchObject({ ok: true, count: 2, objectId: null });
  });
});

describe('🚨 integrationLabel scoping', () => {
  it('🚨 label string → forwardato a getIntegration', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        integrationLabel: 'work-account',
      } as never,
      null,
      ctx(),
    );
    expect(getIntegrationMock).toHaveBeenCalledWith({
      provider: 'hubspot',
      tenantId: 't1',
      label: 'work-account',
    });
  });

  it('🚨 label vuoto → null (default scoping)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'c-1' }));
    await hubspotExecutor(
      {
        operation: 'createContact',
        integrationLabel: '',
      } as never,
      null,
      ctx(),
    );
    expect(getIntegrationMock).toHaveBeenCalledWith({
      provider: 'hubspot',
      tenantId: 't1',
      label: null,
    });
  });
});
