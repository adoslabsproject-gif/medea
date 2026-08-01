/**
 * Test del nodo `action_odoo_lookup_partner`.
 *
 * Mock di safe-fetch identico al pattern di action_odoo_rpc/index.test.ts.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  odooLookupPartnerExecutor,
  buildDomain,
  normaliseVat,
  normalisePhone,
} from './executor.js';
import { odooLookupPartnerNodeDef } from './definition.js';
import { OdooLookupPartnerConfigSchema } from './schema.js';
import { __clearOdooAuthCacheForTests } from '../../lib/odoo/xml-rpc-client.js';
import { ValidationError } from '../../core/node-error.js';

vi.mock('@flowforge/safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
  assertUrlSafe: vi.fn(),
}));
const { safeFetchWithRedirects } = await import('@flowforge/safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };

function rsp(text: string, status = 200): Response {
  return new Response(text, { status });
}
function intRsp(n: number): Response {
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><int>${n}</int></value></param></params></methodResponse>`);
}
function arrayOfStructsRsp(items: Record<string, unknown>[]): Response {
  const inner = items.map((it) => {
    const members = Object.entries(it).map(([k, v]) => {
      let valueXml = '';
      if (typeof v === 'number') valueXml = `<value><int>${v}</int></value>`;
      else if (typeof v === 'string') valueXml = `<value><string>${v}</string></value>`;
      else valueXml = `<value><string>${String(v)}</string></value>`;
      return `<member><name>${k}</name>${valueXml}</member>`;
    }).join('');
    return `<value><struct>${members}</struct></value>`;
  }).join('');
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>${inner}</data></array></value></param></params></methodResponse>`);
}

const AUTH = {
  baseUrl: 'https://odoo.example', database: 'db',
  login: 'admin', password: 'pwd',
};

beforeEach(() => { mockedFetch.mockReset(); __clearOdooAuthCacheForTests(); });

describe('OdooLookupPartnerConfigSchema', () => {
  it('rejects empty all-identifiers config', () => {
    const r = OdooLookupPartnerConfigSchema.safeParse({ ...AUTH });
    expect(r.success).toBe(false);
  });

  it('accepts a config with only email', () => {
    const r = OdooLookupPartnerConfigSchema.safeParse({ ...AUTH, email: 'x@y.it' });
    expect(r.success).toBe(true);
  });

  it('rejects createIfMissing without email OR name', () => {
    const r = OdooLookupPartnerConfigSchema.safeParse({ ...AUTH, vat: '12345', createIfMissing: 'true' });
    expect(r.success).toBe(false);
  });

  it('coerces empty-string identifiers to undefined', () => {
    const r = OdooLookupPartnerConfigSchema.safeParse({ ...AUTH, email: 'x@y.it', vat: '', phone: '', name: '' });
    expect(r.success).toBe(true);
  });
});

describe('buildDomain', () => {
  it('uses email FIRST when both email and vat present', () => {
    const d = buildDomain({ ...AUTH, email: 'a@b.it', vat: '123' } as never);
    expect(d).toEqual([['email', '=ilike', 'a@b.it']]);
  });

  it('falls back to phone when only phone set', () => {
    const d = buildDomain({ ...AUTH, phone: '333 1234567' } as never);
    expect(d).toEqual([['phone', '=', '3331234567']]);
  });

  it('appends company_id when set', () => {
    const d = buildDomain({ ...AUTH, email: 'x@y.it', companyId: 3 } as never);
    expect(d).toEqual([['email', '=ilike', 'x@y.it'], ['company_id', '=', 3]]);
  });
});

describe('normaliseVat / normalisePhone', () => {
  it('strips IT prefix + spaces from VAT', () => {
    expect(normaliseVat(' IT 12345678901 ')).toBe('12345678901');
  });
  it('keeps only digits / + in phone', () => {
    expect(normalisePhone('+39 333 1234567')).toBe('+393331234567');
  });
});

describe('odooLookupPartnerExecutor — happy paths', () => {
  it('found=true when search_read returns a hit', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));       // authenticate
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([{ id: 42, name: 'Mario Rossi', email: 'mario@x.it' }]));
    const r = await odooLookupPartnerExecutor(
      { ...AUTH, email: 'mario@x.it' }, {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.found).toBe(true);
    expect(o.partnerId).toBe(42);
    expect((o.partner as { name: string }).name).toBe('Mario Rossi');
  });

  it('found=false when search returns empty + no createIfMissing', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([]));
    const r = await odooLookupPartnerExecutor(
      { ...AUTH, email: 'nobody@x.it' }, {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.found).toBe(false);
    expect(o.created).toBe(false);
    expect(o.partnerId).toBeNull();
  });

  it('createIfMissing → create + read returns created=true', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));              // auth
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([]));  // search miss
    mockedFetch.mockResolvedValueOnce(intRsp(99));             // create → new id 99
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([{ id: 99, name: 'Mario', email: 'mario@x.it' }]));

    const r = await odooLookupPartnerExecutor(
      { ...AUTH, email: 'mario@x.it', name: 'Mario', createIfMissing: 'true' }, {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.found).toBe(false);
    expect(o.created).toBe(true);
    expect(o.partnerId).toBe(99);
  });

  it('rejects empty-all config at parse time', async () => {
    await expect(odooLookupPartnerExecutor({ ...AUTH }, {}, ctx))
      .rejects.toThrow(ValidationError);
  });
});

describe('🔒 outputContract ↔ executor — ANTI-DRIFT (no aspirazionale)', () => {
  const fields = odooLookupPartnerNodeDef.outputContract?.fields ?? [];
  const contractKeys = new Set(fields.map((f) => f.name));

  it('il contract esiste e dichiara ESATTAMENTE i campi top-level reali', () => {
    expect(contractKeys).toEqual(new Set(['found', 'created', 'partnerId', 'partner']));
  });

  it('🚨 partnerId nel contract documenta il NULL (number | null) — il valore che Liara allucinava come 0', () => {
    const pid = fields.find((f) => f.name === 'partnerId');
    expect(pid?.type).toContain('null');
    expect(pid?.desc.toLowerCase()).toContain('null');
    // il contract NON deve mai suggerire 0 come "non trovato"
    expect(JSON.stringify(odooLookupPartnerNodeDef.outputContract)).not.toContain('=0');
  });

  it('🔒 HIT: chiavi top-level dell\'output reale == campi del contract', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([{ id: 42, name: 'Mario' }]));
    const r = await odooLookupPartnerExecutor({ ...AUTH, email: 'a@b.it' }, {}, ctx);
    expect(new Set(Object.keys(r.output as object))).toEqual(contractKeys);
  });

  it('🔒 MISS+!create: stesse chiavi + partnerId/partner = NULL (verità contro allucinazione)', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([]));
    const r = await odooLookupPartnerExecutor({ ...AUTH, email: 'no@b.it' }, {}, ctx);
    const o = r.output as Record<string, unknown>;
    expect(new Set(Object.keys(o))).toEqual(contractKeys);
    expect(o.partnerId).toBeNull();
    expect(o.partner).toBeNull();
  });

  it('🔒 CREATE: stesse chiavi top-level del contract', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([]));
    mockedFetch.mockResolvedValueOnce(intRsp(99));
    mockedFetch.mockResolvedValueOnce(arrayOfStructsRsp([{ id: 99, name: 'Mario' }]));
    const r = await odooLookupPartnerExecutor(
      { ...AUTH, email: 'm@x.it', name: 'Mario', createIfMissing: 'true' }, {}, ctx,
    );
    expect(new Set(Object.keys(r.output as object))).toEqual(contractKeys);
  });
});
