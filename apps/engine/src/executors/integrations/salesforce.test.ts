/**
 * Test 2026-grade — salesforce CRM integration executor.
 *
 * 🚨 BUSINESS-CRITICAL: production CRM API path (SOQL + 6 operations).
 *
 * Coverage:
 *  - operation router: query/create/update/upsert/delete/get
 *  - 🚨 invalid_payload guards: operation missing, sobject missing,
 *    soql missing, recordId missing per ogni op
 *  - 🚨 credentials incomplete (5 campi) → INVALID_CREDENTIALS
 *  - 🚨 401 refresh flow: refreshAccessToken via /services/oauth2/token →
 *    saveIntegration vault → retry sfFetch con nuovo token
 *  - 🚨 OAuth refresh failed (non 2xx, no access_token) → throw OAUTH_REFRESH_FAILED
 *  - 4xx Salesforce error parsing (array errors[] con message+errorCode)
 *  - 5xx → retryable=true
 *  - 🚨 SOQL injection-safe: query? param URL-encoded
 *  - recordJson parsing: string JSON / object / null/empty
 *  - output shape: ok/data/records/count/totalSize/recordId/created
 *  - API_VERSION v60 in path
 */
import type * as CommonNS from './common.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

const m = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  requireIntegration: vi.fn(),
  saveIntegration: vi.fn(),
}));

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: (...a: unknown[]) => m.safeFetch(...a),
}));
vi.mock('@/services/integrations/store.js', () => ({
  saveIntegration: (...a: unknown[]) => m.saveIntegration(...a),
}));
vi.mock('./common.js', async () => {
  const real = await vi.importActual<typeof CommonNS>('./common.js');
  return {
    ...real,
    requireIntegration: (...a: unknown[]) => m.requireIntegration(...a),
  };
});

import { salesforceExecutor } from './salesforce.js';

const ctx: NodeExecutionContext = {
  tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1', secrets: {},
} as NodeExecutionContext;

const fullCreds = {
  instanceUrl: 'https://acme.my.salesforce.com',
  accessToken: 'tok-1',
  refreshToken: 'rt-1',
  clientId: 'cid',
  clientSecret: 'csec',
};

/** Mock Response REALISTICO: `headers` + `text()` (il reader cappato legge testo e
 *  poi parsa, come una Response vera). Un mock `.json()`-only non basta più. */
const mkRes = (body: unknown, opts: { ok?: boolean; status?: number; statusText?: string } = {}): unknown => {
  const serialized = JSON.stringify(body ?? {});
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: new Headers(),
    text: async (): Promise<string> => serialized,
    json: async (): Promise<unknown> => body,
  };
};
const okResponse = (body: unknown): unknown => mkRes(body);

beforeEach(() => {
  m.safeFetch.mockReset();
  m.requireIntegration.mockReset();
  m.saveIntegration.mockReset();
  m.requireIntegration.mockReturnValue({ credentials: fullCreds });
});

describe('🚨 operation routing', () => {
  it('query → SOQL su /services/data/v60.0/query?q=...', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ records: [{ Id: '001' }], totalSize: 1, done: true }));
    const r = await salesforceExecutor({
      operation: 'query', soql: 'SELECT Id FROM Account LIMIT 1',
    }, {}, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      expect.stringContaining('/services/data/v60.0/query?q=SELECT'),
      expect.objectContaining({ method: 'GET' }),
    );
    const out = r.output as { records: unknown[]; count: number; totalSize: number };
    expect(out.records).toHaveLength(1);
    expect(out.count).toBe(1);
    expect(out.totalSize).toBe(1);
  });

  it('🚨 query URL-encode SOQL con WHERE clauses (no injection)', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ records: [], totalSize: 0, done: true }));
    await salesforceExecutor({
      operation: 'query', soql: "SELECT Id FROM Account WHERE Name='O''Reilly'",
    }, {}, ctx);
    const url = m.safeFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('%3D'); // '=' encoded
    expect(url).toContain('%20'); // spazi encoded
    expect(url).not.toContain(' '); // no spazi raw
  });

  it('create → POST /sobjects/Account con body parsato', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ id: 'a001', success: true }));
    const r = await salesforceExecutor({
      operation: 'create', sobject: 'Account', recordJson: '{"Name":"Acme"}',
    }, {}, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      expect.stringContaining('/sobjects/Account'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ Name: 'Acme' }),
      }),
    );
    const out = r.output as { recordId: string; created: boolean };
    expect(out.recordId).toBe('a001');
    expect(out.created).toBe(true);
  });

  it('update → PATCH /sobjects/Account/<id>', async () => {
    m.safeFetch.mockResolvedValue(mkRes({}, { status: 204, statusText: 'No Content' }));
    const r = await salesforceExecutor({
      operation: 'update', sobject: 'Account', recordId: 'a001', recordJson: '{"Name":"NEW"}',
    }, {}, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      expect.stringContaining('/sobjects/Account/a001'),
      expect.objectContaining({ method: 'PATCH' }),
    );
    const out = r.output as { recordId: string };
    expect(out.recordId).toBe('a001');
  });

  it('upsert → PATCH /sobjects/Account/<extField>/<value> URL-encoded', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ id: 'a002', created: true }));
    await salesforceExecutor({
      operation: 'upsert', sobject: 'Account',
      externalIdField: 'ExternalRef__c', externalIdValue: 'cust/1',
      recordJson: { Name: 'X' },
    }, {}, ctx);
    const url = m.safeFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('/sobjects/Account/ExternalRef__c/cust%2F1');
  });

  it('delete → DELETE /sobjects/<id>', async () => {
    m.safeFetch.mockResolvedValue(mkRes({}, { status: 204, statusText: 'No Content' }));
    const r = await salesforceExecutor({
      operation: 'delete', sobject: 'Account', recordId: 'a001',
    }, {}, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'DELETE' }),
    );
    const out = r.output as { data: { deleted: boolean }; recordId: string };
    expect(out.data.deleted).toBe(true);
    expect(out.recordId).toBe('a001');
  });

  it('get → GET /sobjects/<sobject>/<id>', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ Id: 'a001', Name: 'Acme' }));
    const r = await salesforceExecutor({
      operation: 'get', sobject: 'Account', recordId: 'a001',
    }, {}, ctx);
    const out = r.output as { data: { Name: string }; recordId: string };
    expect(out.data.Name).toBe('Acme');
    expect(out.recordId).toBe('a001');
  });
});

describe('🚨 validation guards', () => {
  it('🚨 operation mancante → throw INVALID_PAYLOAD', async () => {
    await expect(salesforceExecutor({}, {}, ctx))
      .rejects.toThrow(/"operation" obbligatorio/u);
  });

  it('🚨 operation unsupported → throw', async () => {
    await expect(salesforceExecutor({ operation: 'merge' }, {}, ctx))
      .rejects.toThrow(/operation "merge" non supportata/u);
  });

  it('🚨 query senza soql → throw', async () => {
    await expect(salesforceExecutor({ operation: 'query' }, {}, ctx))
      .rejects.toThrow(/"soql" obbligatorio per query/u);
  });

  it('🚨 create senza sobject → throw', async () => {
    await expect(salesforceExecutor({ operation: 'create' }, {}, ctx))
      .rejects.toThrow(/"sobject" obbligatorio per create/u);
  });

  it('🚨 update senza recordId → throw', async () => {
    await expect(salesforceExecutor({ operation: 'update', sobject: 'Account' }, {}, ctx))
      .rejects.toThrow(/update richiede sobject \+ recordId/u);
  });

  it('🚨 upsert senza externalIdField/Value → throw', async () => {
    await expect(salesforceExecutor({
      operation: 'upsert', sobject: 'Account', externalIdField: 'X',
    }, {}, ctx)).rejects.toThrow(/upsert richiede.*externalIdValue/u);
  });

  it('🚨 delete senza recordId → throw', async () => {
    await expect(salesforceExecutor({ operation: 'delete', sobject: 'Account' }, {}, ctx))
      .rejects.toThrow(/delete richiede.*recordId/u);
  });

  it('🚨 get senza recordId → throw', async () => {
    await expect(salesforceExecutor({ operation: 'get', sobject: 'Account' }, {}, ctx))
      .rejects.toThrow(/get richiede.*recordId/u);
  });
});

describe('🚨 credentials guards', () => {
  it('🚨 missing instanceUrl → INVALID_CREDENTIALS', async () => {
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, instanceUrl: '' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/credentials incomplete/u);
  });

  it('🚨 missing accessToken → INVALID_CREDENTIALS', async () => {
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, accessToken: '' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/credentials incomplete/u);
  });

  it('🚨 missing refreshToken → INVALID_CREDENTIALS (no recovery possibile)', async () => {
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, refreshToken: '' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/credentials incomplete/u);
  });

  it('🚨 missing clientId/Secret → INVALID_CREDENTIALS', async () => {
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, clientId: '' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/credentials incomplete/u);
  });
});

describe('🚨 401 OAuth refresh flow', () => {
  it('🚨 401 → refresh access_token + retry con nuovo token + persist vault', async () => {
    // First fetch: 401
    m.safeFetch
      .mockResolvedValueOnce(mkRes({}, { ok: false, status: 401, statusText: 'Unauthorized' }))
      // OAuth refresh: ok
      .mockResolvedValueOnce(okResponse({ access_token: 'tok-NEW' }))
      // Retry: ok
      .mockResolvedValueOnce(okResponse({ records: [], totalSize: 0, done: true }));

    await salesforceExecutor({ operation: 'query', soql: 'SELECT Id FROM Account' }, {}, ctx);
    expect(m.safeFetch).toHaveBeenCalledTimes(3);

    const refreshCall = m.safeFetch.mock.calls[1];
    expect(refreshCall?.[0]).toContain('/services/oauth2/token');
    expect(refreshCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect((refreshCall?.[1] as { body: string }).body).toContain('grant_type=refresh_token');

    const retryCall = m.safeFetch.mock.calls[2];
    expect((retryCall?.[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok-NEW');

    expect(m.saveIntegration).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'salesforce', tenantId: 't1',
      credentials: expect.objectContaining({ accessToken: 'tok-NEW' }),
    }));
  });

  it('🚨 refresh ritorna no access_token → throw OAUTH_REFRESH_FAILED', async () => {
    m.safeFetch
      .mockResolvedValueOnce(mkRes({}, { ok: false, status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(okResponse({ error: 'invalid_grant' }));
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/no access_token in response.*invalid_grant/u);
  });

  it('🚨 refresh HTTP error → throw OAUTH_REFRESH_FAILED', async () => {
    // Sequenza per ogni retry di withRetry:
    //  1. 401 → trigger refresh
    //  2. refresh 500 → throw OAUTH_REFRESH_FAILED
    // withRetry può ri-invocare il blocco N volte → mock loop via implementation
    let callIdx = 0;
    m.safeFetch.mockImplementation((url: string) => {
      callIdx += 1;
      if (url.includes('/oauth2/token')) {
        return Promise.resolve(mkRes({}, { ok: false, status: 500, statusText: 'Server Error' }));
      }
      return Promise.resolve(mkRes({}, { ok: false, status: 401, statusText: 'Unauthorized' }));
    });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/OAuth refresh failed: HTTP 500/u);
    expect(callIdx).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('saveIntegration fail post-refresh NON blocca: best-effort persist', async () => {
    m.safeFetch
      .mockResolvedValueOnce(mkRes({}, { ok: false, status: 401, statusText: '' }))
      .mockResolvedValueOnce(okResponse({ access_token: 'tok-NEW' }))
      .mockResolvedValueOnce(okResponse({ records: [], totalSize: 0, done: true }));
    m.saveIntegration.mockImplementation(() => { throw new Error('vault offline'); });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx)).resolves.toBeDefined();
  });
});

describe('🚨 HTTP error mapping', () => {
  it('🚨 4xx errors array Salesforce → message+errorCode parsed', async () => {
    m.safeFetch.mockResolvedValue(mkRes(
      [{ message: 'Invalid field', errorCode: 'INVALID_FIELD' }],
      { ok: false, status: 400, statusText: 'Bad Request' },
    ));
    await expect(salesforceExecutor({ operation: 'query', soql: 'SELECT badfield' }, {}, ctx))
      .rejects.toThrow(/HTTP 400.*Invalid field.*INVALID_FIELD/u);
  });

  it('🚨 5xx retryable → withRetry kicks in (alla fine throws dopo retries)', async () => {
    m.safeFetch.mockResolvedValue(mkRes({}, { ok: false, status: 503, statusText: 'Service Unavailable' }));
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/HTTP 503/u);
    // withRetry default = >1 attempt
    expect(m.safeFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('non-JSON error body → fallback HTTP <status> <text>', async () => {
    // Body NON-JSON (es. pagina HTML del gateway): readJsonCapped legge il testo e
    // JSON.parse fallisce → il parser d'errore va in catch e usa lo status testuale.
    m.safeFetch.mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway',
      headers: new Headers(), text: async (): Promise<string> => '<html>502 Bad Gateway</html>',
    });
    await expect(salesforceExecutor({ operation: 'query', soql: 'X' }, {}, ctx))
      .rejects.toThrow(/HTTP 502 Bad Gateway/u);
  }, 15_000);
});

describe('recordJson parsing', () => {
  it('recordJson object passthrough', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ id: 'a', success: true }));
    await salesforceExecutor({
      operation: 'create', sobject: 'Account', recordJson: { Name: 'X' },
    }, {}, ctx);
    const body = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({ Name: 'X' });
  });

  it('recordJson empty/null/undefined → empty object', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ id: 'a', success: true }));
    await salesforceExecutor({
      operation: 'create', sobject: 'Account',
    }, {}, ctx);
    const body = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({});
  });

  it('🚨 recordJson string array → INVALID_PAYLOAD (not object)', async () => {
    await expect(salesforceExecutor({
      operation: 'create', sobject: 'Account', recordJson: '[1,2,3]',
    }, {}, ctx)).rejects.toThrow(/recordJson parse error/u);
  });

  it('🚨 recordJson string invalid JSON → INVALID_PAYLOAD', async () => {
    await expect(salesforceExecutor({
      operation: 'create', sobject: 'Account', recordJson: '{broken',
    }, {}, ctx)).rejects.toThrow(/recordJson parse error/u);
  });
});

describe('🚨🚨 ANTI-ESFILTRAZIONE credenziali (host derivato da config)', () => {
  it('instanceUrl=attacker.com → HOST_NOT_ALLOWED e access token MAI spedito', async () => {
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, instanceUrl: 'https://attacker.com' } });
    // path relativo → url = instanceUrl + path → host attaccante.
    await expect(salesforceExecutor({ operation: 'query', soql: 'SELECT Id' }, {}, ctx))
      .rejects.toThrow(/host non consentito|HOST_NOT_ALLOWED/u);
    // la prova del blocco: la fetch (e quindi il Bearer) non è MAI partita.
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('🚨 path assoluto verso host arbitrario non aggira il guard', async () => {
    // un upsert con externalIdValue non basta; il vettore è il branch path.startsWith("http").
    // Lo esercito via un instanceUrl lookalike che NON è *.salesforce.com/force.com.
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, instanceUrl: 'https://acme.my.salesforce.com.evil.net' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'SELECT Id' }, {}, ctx))
      .rejects.toThrow(/host non consentito|HOST_NOT_ALLOWED/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('🚨 refresh OAuth (401) NON POSTa client_secret+refresh_token a host arbitrario', async () => {
    // instanceUrl valido per la 1ª GET, ma il refresh costruisce tokenURL dallo stesso
    // instanceUrl: se fosse arbitrario il segreto permanente partirebbe. Qui verifico il
    // caso valido funziona E che con instanceUrl ostile nemmeno la prima fetch parte.
    m.requireIntegration.mockReturnValue({ credentials: { ...fullCreds, instanceUrl: 'https://evilsalesforce.com' } });
    await expect(salesforceExecutor({ operation: 'query', soql: 'SELECT Id' }, {}, ctx))
      .rejects.toThrow(/host non consentito|HOST_NOT_ALLOWED/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('✅ host Salesforce legittimo (*.my.salesforce.com) passa il guard', async () => {
    m.requireIntegration.mockReturnValue({ credentials: fullCreds }); // acme.my.salesforce.com
    m.safeFetch.mockResolvedValue(okResponse({ records: [], totalSize: 0, done: true }));
    await expect(salesforceExecutor({ operation: 'query', soql: 'SELECT Id' }, {}, ctx)).resolves.toBeDefined();
    expect(m.safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('🚨🚨 PATH-INJECTION: sobject/externalIdField vincolati, recordId encodato', () => {
  it('sobject con metacaratteri di path → INVALID_PAYLOAD (no traversal nell\'API SF)', async () => {
    for (const op of ['create', 'update', 'delete', 'get'] as const) {
      m.safeFetch.mockReset();
      await expect(salesforceExecutor(
        { operation: op, sobject: '../../limits', recordId: 'x', recordJson: '{}' }, {}, ctx,
      )).rejects.toThrow(/sobject.*non valido|identificatore/u);
      expect(m.safeFetch).not.toHaveBeenCalled(); // bloccato prima della fetch
    }
  });

  it('externalIdField con metacaratteri → INVALID_PAYLOAD (upsert)', async () => {
    m.safeFetch.mockReset();
    await expect(salesforceExecutor(
      { operation: 'upsert', sobject: 'Account', externalIdField: 'Ext__c/../../x', externalIdValue: 'v', recordJson: '{}' },
      {}, ctx,
    )).rejects.toThrow(/externalIdField.*non valido|identificatore/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('recordId con "/" → encodeURIComponent (no path-injection, resta UN segmento)', async () => {
    m.safeFetch.mockReset();
    m.safeFetch.mockResolvedValue(mkRes({}, { status: 204, statusText: 'No Content' }));
    await salesforceExecutor({ operation: 'get', sobject: 'Account', recordId: 'a/../b?x=1' }, {}, ctx);
    const url = m.safeFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('/sobjects/Account/');
    expect(url).toContain('%2F'); // '/' encodato
    expect(url).toContain('%3F'); // '?' encodato
    expect(url).not.toMatch(/\/sobjects\/Account\/a\/\.\.\//);
  });

  it('✅ sobject custom valido (Foo__c) passa', async () => {
    m.safeFetch.mockReset();
    m.safeFetch.mockResolvedValue(okResponse({ id: 'a1', success: true }));
    await expect(salesforceExecutor(
      { operation: 'create', sobject: 'Foo__c', recordJson: '{"Name":"x"}' }, {}, ctx,
    )).resolves.toBeDefined();
    expect(String(m.safeFetch.mock.calls[0]?.[0])).toContain('/sobjects/Foo__c');
  });
});

describe('output shape', () => {
  it('include ok/data/records/count/totalSize/recordId/created + durationMs', async () => {
    m.safeFetch.mockResolvedValue(okResponse({ records: [{ Id: 'a' }, { Id: 'b' }], totalSize: 2, done: true }));
    const r = await salesforceExecutor({ operation: 'query', soql: 'SELECT Id' }, {}, ctx);
    expect(r).toMatchObject({
      output: {
        ok: true, count: 2, totalSize: 2, recordId: null, created: false,
      },
      durationMs: expect.any(Number),
    });
  });
});
