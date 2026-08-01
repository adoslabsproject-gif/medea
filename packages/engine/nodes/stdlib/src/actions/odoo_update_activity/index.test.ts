/**
 * Test del nodo `action_odoo_update_activity`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { odooUpdateActivityExecutor } from './executor.js';
import { OdooUpdateActivityConfigSchema } from './schema.js';
import { __clearOdooAuthCacheForTests } from '../../lib/odoo/xml-rpc-client.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved per estensione futura (interface compat)
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

const AUTH = { baseUrl: 'https://odoo.example', database: 'db', login: 'a', password: 'p' };

beforeEach(() => { mockedFetch.mockReset(); __clearOdooAuthCacheForTests(); });

describe('OdooUpdateActivityConfigSchema', () => {
  it('requires resModel + resId + summary', () => {
    expect(OdooUpdateActivityConfigSchema.safeParse(AUTH).success).toBe(false);
  });

  it('requires activityTypeId OR activityTypeName', () => {
    const r = OdooUpdateActivityConfigSchema.safeParse({
      ...AUTH, resModel: 'crm.lead', resId: 5, summary: 'X',
    });
    expect(r.success).toBe(false);
  });

  it('accepts numeric id only', () => {
    const r = OdooUpdateActivityConfigSchema.safeParse({
      ...AUTH, resModel: 'crm.lead', resId: 5, summary: 'X', activityTypeId: 2,
    });
    expect(r.success).toBe(true);
  });

  it('rejects bad date format', () => {
    const r = OdooUpdateActivityConfigSchema.safeParse({
      ...AUTH, resModel: 'crm.lead', resId: 5, summary: 'X', activityTypeId: 1,
      dateDeadline: '10/06/2026',
    });
    expect(r.success).toBe(false);
  });
});

describe('odooUpdateActivityExecutor', () => {
  it('creates activity using numeric activityTypeId (skips name lookup)', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));        // auth
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 100 }]));  // ir.model lookup
    mockedFetch.mockResolvedValueOnce(intRsp(987));      // create mail.activity

    const r = await odooUpdateActivityExecutor(
      { ...AUTH, resModel: 'crm.lead', resId: 5, summary: 'Verifica', activityTypeId: 2 },
      {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.activityId).toBe(987);
    expect(o.activityTypeId).toBe(2);
  });

  it('resolves activityTypeName via search_read', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));                       // auth
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 4 }]));     // activity type lookup
    mockedFetch.mockResolvedValueOnce(structArrayRsp([{ id: 100 }]));   // ir.model lookup
    mockedFetch.mockResolvedValueOnce(intRsp(500));                     // create

    const r = await odooUpdateActivityExecutor(
      { ...AUTH, resModel: 'res.partner', resId: 1, summary: 'X', activityTypeName: 'To Do' },
      {}, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.activityTypeId).toBe(4);
    expect(o.activityId).toBe(500);
  });

  it('throws ValidationError when name doesn\'t match any type', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(structArrayRsp([])); // no type matched

    await expect(odooUpdateActivityExecutor(
      { ...AUTH, resModel: 'crm.lead', resId: 1, summary: 'X', activityTypeName: 'Missing' },
      {}, ctx,
    )).rejects.toThrow(/ACTIVITY_TYPE_NOT_FOUND/);
  });

  it('throws ValidationError when resModel unknown', async () => {
    mockedFetch.mockResolvedValueOnce(intRsp(7));
    mockedFetch.mockResolvedValueOnce(structArrayRsp([])); // ir.model missing
    await expect(odooUpdateActivityExecutor(
      { ...AUTH, resModel: 'unknown.model', resId: 1, summary: 'X', activityTypeId: 1 },
      {}, ctx,
    )).rejects.toThrow(/MODEL_NOT_FOUND/);
  });
});
