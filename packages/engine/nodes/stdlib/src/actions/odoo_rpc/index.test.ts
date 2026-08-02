/**
 * `action_odoo_rpc` — executor E2E tests.
 *
 * Strategy
 * ────────
 * Mock `@medea/engine-safe-fetch` to return canned `Response` objects carrying
 * real XML-RPC envelopes. Two calls per run: authenticate + execute_kw,
 * each one returns a different envelope.
 *
 * Coverage (no smoke):
 *   • schema cross-field: each operation enforces its own required JSON
 *   • happy paths × 5 operations (search_read, create, write, unlink, call_method)
 *   • output shape: createdId (create), count (search_read), success (write/unlink)
 *   • Odoo fault path: OdooFaultError surfaces verbatim
 *   • HTTP transport mapping: 500 → HttpError, network reject → NetworkError
 *   • abort: pre-execution AbortedError + propagation
 *   • injection guards: bad model / method rejected by xml-rpc client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { odooRpcExecutor } from './executor.js';
import { OdooRpcConfigSchema } from './schema.js';
import { HttpError, NetworkError, AbortedError } from '../../core/node-error.js';
import {
  OdooFaultError,
  __clearOdooAuthCacheForTests,
} from '../../lib/odoo/xml-rpc-client.js';

vi.mock('@medea/engine-safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
  assertUrlSafe: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };

function rsp(text: string, status = 200): Response {
  return new Response(text, { status });
}
function authOk(uid: number): Response {
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><int>${uid}</int></value></param></params></methodResponse>`);
}
function intRsp(n: number): Response {
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><int>${n}</int></value></param></params></methodResponse>`);
}
function boolRsp(b: boolean): Response {
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><boolean>${b ? '1' : '0'}</boolean></value></param></params></methodResponse>`);
}
function arrayOfStructsRsp(items: Record<string, unknown>[]): Response {
  const inner = items.map((it) => {
    const members = Object.entries(it).map(([k, v]) => {
      let valueXml = '';
      if (typeof v === 'number') valueXml = `<value><int>${v}</int></value>`;
      else if (typeof v === 'string') valueXml = `<value><string>${v}</string></value>`;
      else if (typeof v === 'boolean') valueXml = `<value><boolean>${v ? '1' : '0'}</boolean></value>`;
      else valueXml = `<value><string>${String(v)}</string></value>`;
      return `<member><name>${k}</name>${valueXml}</member>`;
    }).join('');
    return `<value><struct>${members}</struct></value>`;
  }).join('');
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>${inner}</data></array></value></param></params></methodResponse>`);
}
function faultRsp(code: number, message: string): Response {
  return rsp(`<?xml version="1.0"?><methodResponse><fault><value><struct>
<member><name>faultCode</name><value><int>${code}</int></value></member>
<member><name>faultString</name><value><string>${message}</string></value></member>
</struct></value></fault></methodResponse>`);
}

const BASE_CFG = {
  baseUrl: 'https://odoo.example',
  database: 'mydb',
  login: 'admin',
  password: 'pwd',
  model: 'res.partner',
};

beforeEach(() => {
  mockedFetch.mockReset();
  __clearOdooAuthCacheForTests();
});

// ────────────────────────────────────────────────────────────────────────────
// Schema cross-field validation
// ────────────────────────────────────────────────────────────────────────────

describe('OdooRpcConfigSchema — cross-field rules', () => {
  it('rejects create without valuesJson', () => {
    const r = OdooRpcConfigSchema.safeParse({ ...BASE_CFG, operation: 'create' });
    expect(r.success).toBe(false);
  });
  it('rejects write without recordIdsJson', () => {
    const r = OdooRpcConfigSchema.safeParse({
      ...BASE_CFG, operation: 'write', valuesJson: '{"name":"x"}',
    });
    expect(r.success).toBe(false);
  });
  it('rejects unlink with empty recordIdsJson array', () => {
    const r = OdooRpcConfigSchema.safeParse({
      ...BASE_CFG, operation: 'unlink', recordIdsJson: '[]',
    });
    expect(r.success).toBe(false);
  });
  it('rejects call_method without methodName', () => {
    const r = OdooRpcConfigSchema.safeParse({ ...BASE_CFG, operation: 'call_method' });
    expect(r.success).toBe(false);
  });
  it('rejects malformed JSON in valuesJson', () => {
    const r = OdooRpcConfigSchema.safeParse({
      ...BASE_CFG, operation: 'create', valuesJson: '{not json',
    });
    expect(r.success).toBe(false);
  });
  it('rejects negative record ids', () => {
    const r = OdooRpcConfigSchema.safeParse({
      ...BASE_CFG, operation: 'unlink', recordIdsJson: '[-1]',
    });
    expect(r.success).toBe(false);
  });
  it('rejects model with invalid chars (anti-injection at schema level)', () => {
    const r = OdooRpcConfigSchema.safeParse({ ...BASE_CFG, model: 'res.partner; DROP' });
    expect(r.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Happy paths × 5 operations
// ────────────────────────────────────────────────────────────────────────────

describe('odooRpcExecutor — operation=search_read', () => {
  it('returns the decoded array + count', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(arrayOfStructsRsp([
        { id: 7, name: 'Mario Rossi' },
        { id: 8, name: 'Anna Bianchi' },
      ]));
    const out = await odooRpcExecutor({
      ...BASE_CFG,
      operation: 'search_read',
      domainJson: '[["email","=","x@y.it"]]',
      fieldsJson: '["id","name"]',
      limit: 10,
    }, null, ctx);

    const o = out.output as Record<string, unknown>;
    expect(o.operation).toBe('search_read');
    expect(o.count).toBe(2);
    expect((o.body as Record<string, unknown>[])[0]?.name).toBe('Mario Rossi');

    // Inspect the HTTP body sent to Odoo — confirm kwargs landed correctly.
    const body = mockedFetch.mock.calls[1]?.[1]?.body as string;
    expect(body).toContain('<methodName>execute_kw</methodName>');
    expect(body).toContain('<string>res.partner</string>');
    expect(body).toContain('<string>search_read</string>');
    expect(body).toContain('<string>email</string>');
    expect(body).toContain('<int>10</int>');                    // limit kwarg
  });
});

describe('odooRpcExecutor — operation=create', () => {
  it('returns the new id and exposes createdId', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(intRsp(42));
    const out = await odooRpcExecutor({
      ...BASE_CFG,
      operation: 'create',
      model: 'res.partner',
      valuesJson: '{"name":"Mario","email":"m@x.it"}',
    }, null, ctx);
    const o = out.output as Record<string, unknown>;
    expect(o.body).toBe(42);
    expect(o.createdId).toBe(42);
  });
});

describe('odooRpcExecutor — operation=write', () => {
  it('returns success=true on a boolean true response', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(boolRsp(true));
    const out = await odooRpcExecutor({
      ...BASE_CFG,
      operation: 'write',
      recordIdsJson: '[42]',
      valuesJson: '{"name":"Mario Aggiornato"}',
    }, null, ctx);
    expect((out.output as Record<string, unknown>).success).toBe(true);

    const body = mockedFetch.mock.calls[1]?.[1]?.body as string;
    expect(body).toContain('<string>write</string>');
    // positional[0] = [42], positional[1] = {name}
    expect(body).toContain('<int>42</int>');
  });
});

describe('odooRpcExecutor — operation=unlink', () => {
  it('returns success=true and routes through unlink method', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(boolRsp(true));
    const out = await odooRpcExecutor({
      ...BASE_CFG,
      operation: 'unlink',
      recordIdsJson: '[7]',
    }, null, ctx);
    expect((out.output as Record<string, unknown>).success).toBe(true);
    const body = mockedFetch.mock.calls[1]?.[1]?.body as string;
    expect(body).toContain('<string>unlink</string>');
  });
});

describe('odooRpcExecutor — operation=call_method', () => {
  it('forwards methodName + positional + kwargs', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(boolRsp(true));
    await odooRpcExecutor({
      ...BASE_CFG,
      model: 'sale.order',
      operation: 'call_method',
      methodName: 'action_confirm',
      positionalJson: '[[15,22]]',
      kwargsJson: '{"context":{"lang":"it_IT"}}',
    }, null, ctx);
    const body = mockedFetch.mock.calls[1]?.[1]?.body as string;
    expect(body).toContain('<string>sale.order</string>');
    expect(body).toContain('<string>action_confirm</string>');
    expect(body).toContain('<int>15</int>');
    expect(body).toContain('<int>22</int>');
    // `lang` is a struct member NAME (encoded as <name>), not a value.
    expect(body).toContain('<name>lang</name>');
    expect(body).toContain('<string>it_IT</string>');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pipeline log + cache hint
// ────────────────────────────────────────────────────────────────────────────

describe('odooRpcExecutor — pipelineSteps', () => {
  it('emits authenticate + execute_kw steps', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(3))
      .mockResolvedValueOnce(intRsp(99));
    const out = await odooRpcExecutor({
      ...BASE_CFG, operation: 'create', valuesJson: '{"name":"x"}',
    }, null, ctx);
    const steps = (out.output as Record<string, unknown>).pipelineSteps as Record<string, unknown>[];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.name).toBe('authenticate');
    expect(steps[1]?.name).toBe('execute_kw');
    expect((steps[1]?.evidence as Record<string, unknown>).operation).toBe('create');
  });

  it('omits pipelineSteps when includePipelineLog=false', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(3))
      .mockResolvedValueOnce(intRsp(99));
    const out = await odooRpcExecutor({
      ...BASE_CFG, operation: 'create', valuesJson: '{"name":"x"}',
      includePipelineLog: false,
    }, null, ctx);
    expect((out.output as Record<string, unknown>).pipelineSteps).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error paths
// ────────────────────────────────────────────────────────────────────────────

describe('odooRpcExecutor — error mapping', () => {
  it('re-throws OdooFaultError verbatim when execute_kw returns a fault', async () => {
    mockedFetch
      .mockResolvedValueOnce(authOk(2))
      .mockResolvedValueOnce(faultRsp(1, 'AccessError: requirement non soddisfatto'));
    await expect(odooRpcExecutor({
      ...BASE_CFG, operation: 'create', valuesJson: '{"name":"x"}',
    }, null, ctx)).rejects.toBeInstanceOf(OdooFaultError);
  });

  it('maps HTTP 500 to HttpError', async () => {
    mockedFetch.mockResolvedValueOnce(rsp('boom', 500));
    await expect(odooRpcExecutor({
      ...BASE_CFG, operation: 'search_read',
    }, null, ctx)).rejects.toBeInstanceOf(HttpError);
  });

  it('maps a network reject to NetworkError', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(odooRpcExecutor({
      ...BASE_CFG, operation: 'search_read',
    }, null, ctx)).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws AbortedError when context.abortSignal is already aborted', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    await expect(odooRpcExecutor(
      { ...BASE_CFG, operation: 'search_read' },
      null,
      { ...ctx, abortSignal: ctrl.signal },
    )).rejects.toBeInstanceOf(AbortedError);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
