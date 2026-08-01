/**
 * Test del nodo `action_odoo_create_lead`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { odooCreateLeadExecutor, buildValues } from './executor.js';
import { OdooCreateLeadConfigSchema, type OdooCreateLeadConfig } from './schema.js';
import { __clearOdooAuthCacheForTests } from '../../lib/odoo/xml-rpc-client.js';

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
function tagRsp(id: number, name: string): Response {
  // crm.tag.name_create returns (id, name) array.
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>
<value><int>${id}</int></value>
<value><string>${name}</string></value>
</data></array></value></param></params></methodResponse>`);
}
function structArrayRsp(items: Record<string, unknown>[]): Response {
  const inner = items.map((it) => {
    const members = Object.entries(it).map(([k, v]) => {
      const valueXml = typeof v === 'number'
        ? `<value><int>${v}</int></value>`
        : `<value><string>${String(v)}</string></value>`;
      return `<member><name>${k}</name>${valueXml}</member>`;
    }).join('');
    return `<value><struct>${members}</struct></value>`;
  }).join('');
  return rsp(`<?xml version="1.0"?><methodResponse><params><param><value><array><data>${inner}</data></array></value></param></params></methodResponse>`);
}

const AUTH = { baseUrl: 'https://odoo.example', database: 'db', login: 'admin', password: 'p' };

beforeEach(() => { mockedFetch.mockReset(); __clearOdooAuthCacheForTests(); });

describe('OdooCreateLeadConfigSchema', () => {
  it('requires name', () => {
    expect(OdooCreateLeadConfigSchema.safeParse(AUTH).success).toBe(false);
  });

  it('parses tagNames CSV into array', () => {
    const r = OdooCreateLeadConfigSchema.safeParse({
      ...AUTH, name: 'L1', tagNames: 'a, b; c\nd',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tagNames).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects bad email', () => {
    const r = OdooCreateLeadConfigSchema.safeParse({ ...AUTH, name: 'X', emailFrom: 'not-an-email' });
    expect(r.success).toBe(false);
  });

  it('accepts empty-string optional fields (template engine fallback)', () => {
    const r = OdooCreateLeadConfigSchema.safeParse({
      ...AUTH, name: 'X', emailFrom: '', phone: '', description: '',
    });
    expect(r.success).toBe(true);
  });

  it('clamps probability to 0..100', () => {
    expect(OdooCreateLeadConfigSchema.safeParse({ ...AUTH, name: 'x', probability: 150 }).success).toBe(false);
  });
});

describe('buildValues', () => {
  it('emits many2many command for tag_ids', () => {
    const cfg = { name: 'X' } as OdooCreateLeadConfig;
    const v = buildValues(cfg, [1, 2, 3]);
    expect(v.tag_ids).toEqual([[6, 0, [1, 2, 3]]]);
  });

  it('omits empty optionals', () => {
    const cfg = { name: 'X' } as OdooCreateLeadConfig;
    const v = buildValues(cfg, []);
    expect(Object.keys(v)).toEqual(['name']);
  });

  it('maps emailFrom → email_from', () => {
    const cfg = { name: 'X', emailFrom: 'a@b' } as OdooCreateLeadConfig;
    const v = buildValues(cfg, []);
    expect(v.email_from).toBe('a@b');
  });
});

describe('odooCreateLeadExecutor — happy path', () => {
  it('creates lead with 2 tags — search miss → name_create', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));                       // auth
    mockedFetch.mockResolvedValueOnce(structArrayRsp([]));              // tag1 search → miss
    mockedFetch.mockResolvedValueOnce(tagRsp(10, 'urgente'));           // tag1 name_create
    mockedFetch.mockResolvedValueOnce(structArrayRsp([]));              // tag2 search → miss
    mockedFetch.mockResolvedValueOnce(tagRsp(11, 'fiscale'));           // tag2 name_create
    mockedFetch.mockResolvedValueOnce(intRsp(500));                     // lead create
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 500, name: 'Mario 730' }])); // read

    const r = await odooCreateLeadExecutor(
      { ...AUTH, name: 'Mario 730', tagNames: 'urgente,fiscale' }, {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.success).toBe(true);
    expect(o.leadId).toBe(500);
    expect((o.tagIds as readonly number[])).toEqual([10, 11]);
  });

  it('reuses existing tag — search HIT → skip name_create (no duplicate error)', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));                       // auth
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 99 }]));   // tag search → HIT id=99
    mockedFetch.mockResolvedValueOnce(intRsp(500));                     // lead create
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 500, name: 'X' }])); // read

    const r = await odooCreateLeadExecutor(
      { ...AUTH, name: 'X', tagNames: 'urgente' }, {}, ctx,
    );
    expect(((r.output as Record<string, unknown>).tagIds as readonly number[])).toEqual([99]);
    // name_create NEVER called (would have been mockResolvedValueOnce #5)
  });

  it('skips tag resolution when no tags', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));     // auth
    mockedFetch.mockResolvedValueOnce(intRsp(123));   // create
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 123, name: 'X' }])); // read

    const r = await odooCreateLeadExecutor({ ...AUTH, name: 'X' }, {}, ctx);
    expect((r.output as Record<string, unknown>).leadId).toBe(123);
  });
});
