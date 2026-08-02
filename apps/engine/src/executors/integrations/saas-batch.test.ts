import type * as StoreNS from '@/services/integrations/store.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coerceString } from '@/lib/coerce.js';

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: vi.fn(),
}));

vi.mock('@/services/integrations/store.js', async () => {
  const actual = await vi.importActual<typeof StoreNS>('@/services/integrations/store.js');
  return { ...actual, getIntegration: vi.fn() };
});

import { googleSheetsExecutor } from './google-sheets.js';
import { discordExecutor } from './discord.js';
import { airtableExecutor } from './airtable.js';
import { trelloExecutor } from './trello.js';
import { calendlyExecutor } from './calendly.js';
import { typeformExecutor } from './typeform.js';
import { shopifyExecutor } from './shopify.js';
import { mailchimpExecutor } from './mailchimp.js';
import { twilioExecutor } from './twilio.js';
import * as twilioGuards from './twilio-guards.js';
import { sendgridExecutor } from './sendgrid.js';
import { asanaExecutor } from './asana.js';
import { dropboxExecutor } from './dropbox.js';
import { boxExecutor } from './box.js';
import { gcsExecutor } from './gcs.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { getIntegration } from '@/services/integrations/store.js';

const mockFetch = vi.mocked(safeOutboundFetch);
const mockGetIntegration = vi.mocked(getIntegration);

const ctx = { tenantId: 'tenant-test', runId: 'r1', nodeId: 'n1' } as never;

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Google Sheets ──────────────────────────────────────────────────
describe('googleSheetsExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'google_sheets',
      tenantId: 'tenant-test',
      label: null,
      credentials: { accessToken: 'gsa_test' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
  });

  it('getValues → ritorna rows', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({
        values: [
          ['A1', 'B1'],
          ['A2', 'B2'],
        ],
        range: 'Foglio1!A1:B2',
      }),
    );
    const r = await googleSheetsExecutor(
      { operation: 'getValues', spreadsheetId: 'sheet1', range: 'Foglio1!A1:B2' },
      null,
      ctx,
    );
    const out = r.output as { rows: unknown[][]; count: number };
    expect(out.rows).toHaveLength(2);
    expect(out.count).toBe(2);
  });

  it('appendValues → POST con valueInputOption', async () => {
    mockFetch.mockResolvedValue(jsonResp({ updates: { updatedCells: 4 } }));
    await googleSheetsExecutor(
      {
        operation: 'appendValues',
        spreadsheetId: 'sheet1',
        range: 'Foglio1!A1',
        valuesJson: '[["X","Y"]]',
        valueInputOption: 'RAW',
      },
      null,
      ctx,
    );
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain(':append');
    expect(url).toContain('valueInputOption=RAW');
  });

  it('credentials mancanti → INVALID_CREDENTIALS', async () => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'google_sheets',
      tenantId: 'tenant-test',
      label: null,
      credentials: {},
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
    await expect(
      googleSheetsExecutor({ operation: 'getValues', spreadsheetId: 's', range: 'A1' }, null, ctx),
    ).rejects.toThrow(/accessToken assente/i);
  });
});

// ─── Discord ──────────────────────────────────────────────────
describe('discordExecutor', () => {
  it('webhook mode → POST a URL discord.com', async () => {
    mockFetch.mockResolvedValue(jsonResp({ id: 'm1', channel_id: 'c1' }));
    const r = await discordExecutor(
      { mode: 'webhook', webhookUrl: 'https://discord.com/api/webhooks/123/abc', content: 'hello' },
      null,
      ctx,
    );
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('discord.com/api/webhooks');
    expect((r.output as { messageId: string }).messageId).toBe('m1');
  });

  it('webhook URL invalido → INVALID_PAYLOAD', async () => {
    await expect(
      discordExecutor(
        { mode: 'webhook', webhookUrl: 'https://evil.example/hook', content: 'x' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/webhookUrl invalido/i);
  });

  it('content + embedJson vuoti → INVALID_PAYLOAD', async () => {
    await expect(
      discordExecutor(
        { mode: 'webhook', webhookUrl: 'https://discord.com/api/webhooks/1/a' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/content o embedJson richiesto/i);
  });

  it('bot mode → header Authorization Bot', async () => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'discord',
      tenantId: 'tenant-test',
      label: null,
      credentials: { botToken: 'BOT_XXX' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
    mockFetch.mockResolvedValue(jsonResp({ id: 'm2', channel_id: 'c2' }));
    await discordExecutor({ mode: 'bot', channelId: 'c2', content: 'via bot' }, null, ctx);
    const headers = (mockFetch.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bot BOT_XXX');
  });
});

// ─── Airtable ──────────────────────────────────────────────────
describe('airtableExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'airtable',
      tenantId: 'tenant-test',
      label: null,
      credentials: { personalAccessToken: 'pat_xxx' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
  });

  it('listRecords con paginazione → accumula across pages', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResp({ records: [{ id: 'r1' }, { id: 'r2' }], offset: 'next-page' }),
      )
      .mockResolvedValueOnce(jsonResp({ records: [{ id: 'r3' }] })); // no offset → fine
    const r = await airtableExecutor(
      { operation: 'listRecords', baseId: 'appXXX', tableName: 'Tasks' },
      null,
      ctx,
    );
    expect((r.output as { records: unknown[] }).records).toHaveLength(3);
  });

  it('createRecord con typecast', async () => {
    mockFetch.mockResolvedValue(jsonResp({ id: 'recXXX', fields: { Name: 'Task' } }));
    await airtableExecutor(
      {
        operation: 'createRecord',
        baseId: 'appXXX',
        tableName: 'Tasks',
        fieldsJson: '{"Name":"Task"}',
      },
      null,
      ctx,
    );
    const body = JSON.parse(coerceString(mockFetch.mock.calls[0]?.[1]?.body ?? '{}')) as {
      fields: unknown;
      typecast: boolean;
    };
    expect(body.fields).toEqual({ Name: 'Task' });
    expect(body.typecast).toBe(true);
  });
});

// ─── Trello ──────────────────────────────────────────────────
describe('trelloExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'trello',
      tenantId: 'tenant-test',
      label: null,
      credentials: { apiKey: 'KEY', oauthToken: 'TKN' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
  });

  it('createCard → POST /cards con auth in query', async () => {
    mockFetch.mockResolvedValue(jsonResp({ id: 'card1', idList: 'l1' }));
    await trelloExecutor(
      {
        operation: 'createCard',
        listId: 'l1',
        name: 'Bug',
        desc: 'desc',
        due: '2026-06-30T17:00:00Z',
      },
      null,
      ctx,
    );
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('api.trello.com/1/cards');
    expect(url).toContain('key=KEY');
    expect(url).toContain('token=TKN');
    expect(url).toContain('idList=l1');
  });

  it('createCard senza listId → INVALID_PAYLOAD', async () => {
    await expect(trelloExecutor({ operation: 'createCard', name: 'X' }, null, ctx)).rejects.toThrow(
      /listId obbligatorio/i,
    );
  });

  it('getBoardLists → GET /boards/.../lists', async () => {
    mockFetch.mockResolvedValue(jsonResp([{ id: 'l1', name: 'To do' }]));
    const r = await trelloExecutor({ operation: 'getBoardLists', boardId: 'b1' }, null, ctx);
    expect((r.output as { lists: unknown[] }).lists).toHaveLength(1);
  });
});

// ─── Calendly ──────────────────────────────────────────────────
describe('calendlyExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'calendly',
      tenantId: 'tenant-test',
      label: null,
      credentials: { personalAccessToken: 'CAL_TOK' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
  });

  it('listScheduledEvents → query scope user + status', async () => {
    mockFetch.mockResolvedValue(jsonResp({ collection: [{ uri: 'e1' }, { uri: 'e2' }] }));
    const r = await calendlyExecutor(
      {
        operation: 'listScheduledEvents',
        userUri: 'https://api.calendly.com/users/UUID',
        status: 'active',
      },
      null,
      ctx,
    );
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('user=https');
    expect(url).toContain('status=active');
    expect((r.output as { events: unknown[] }).events).toHaveLength(2);
  });

  it('cancelEvent → POST a /cancellation con reason', async () => {
    mockFetch.mockResolvedValue(jsonResp({ resource: { uri: 'e1' } }));
    await calendlyExecutor(
      {
        operation: 'cancelEvent',
        eventUri: 'https://api.calendly.com/scheduled_events/E1',
        cancelReason: 'Conflict',
      },
      null,
      ctx,
    );
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('/cancellation');
    const body = JSON.parse(coerceString(mockFetch.mock.calls[0]?.[1]?.body ?? '{}')) as {
      reason: string;
    };
    expect(body.reason).toBe('Conflict');
  });

  it('🚨🚨 ANTI-ESFILTRAZIONE: eventUri=attacker.com → blocco e PAT MAI spedito', async () => {
    await expect(
      calendlyExecutor(
        { operation: 'getEvent', eventUri: 'https://attacker.com/steal' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/host non consentito|HOST_NOT_ALLOWED/u);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('🚨 suffix-confusion api.calendly.com.attacker.com → bloccato', async () => {
    await expect(
      calendlyExecutor(
        { operation: 'getInvitee', inviteeUri: 'https://api.calendly.com.attacker.com/x' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/host non consentito|HOST_NOT_ALLOWED/u);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Typeform ──────────────────────────────────────────────────
describe('typeformExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      id: 'i1',
      provider: 'typeform',
      tenantId: 'tenant-test',
      label: null,
      credentials: { personalAccessToken: 'TF_TOK' },
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      createdByUserId: null,
    });
  });

  it('listResponses → query completed=true + sinceDate', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ items: [{ token: 'r1' }, { token: 'r2' }], total_items: 2 }),
    );
    const r = await typeformExecutor(
      {
        operation: 'listResponses',
        formId: 'f1',
        sinceDate: '2026-06-01T00:00:00Z',
        pageSize: '25',
      },
      null,
      ctx,
    );
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('/forms/f1/responses');
    expect(url).toContain('completed=true');
    expect(url).toContain('since=');
    expect((r.output as { responses: unknown[]; total: number }).total).toBe(2);
  });

  it('deleteResponses → DELETE con responseId', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await typeformExecutor(
      { operation: 'deleteResponses', formId: 'f1', responseId: 'rid1' },
      null,
      ctx,
    );
    expect(mockFetch.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('listForms → ritorna items + total_items', async () => {
    mockFetch.mockResolvedValue(jsonResp({ items: [{ id: 'f1' }], total_items: 1 }));
    const r = await typeformExecutor({ operation: 'listForms' }, null, ctx);
    expect((r.output as { forms: unknown[]; total: number }).forms).toHaveLength(1);
    expect((r.output as { total: number }).total).toBe(1);
  });
});

describe('shopifyExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      credentials: { shopDomain: 'test-store.myshopify.com', accessToken: 'shpat_abc123' },
    } as never);
  });

  it('getOrder → ritorna order + chiama Admin API con token header', async () => {
    mockFetch.mockResolvedValue(jsonResp({ order: { id: 450789469, name: '#1001' } }));
    const r = await shopifyExecutor({ operation: 'getOrder', orderId: '450789469' }, null, ctx);
    expect((r.output as { order: { id: number } }).order.id).toBe(450789469);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('test-store.myshopify.com/admin/api/2024-01/orders/450789469.json');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_abc123');
  });

  it('createOrder → POST con wrapper {order} + ritorna orderId', async () => {
    mockFetch.mockResolvedValue(jsonResp({ order: { id: 999 } }));
    const r = await shopifyExecutor(
      {
        operation: 'createOrder',
        orderJson: '{"email":"x@y.it","line_items":[{"variant_id":1,"quantity":2}]}',
      },
      null,
      ctx,
    );
    expect((r.output as { orderId: number }).orderId).toBe(999);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(coerceString(init.body)).toContain('"order"');
  });

  it('listProducts → ritorna products + count, limit clampato a 250', async () => {
    mockFetch.mockResolvedValue(jsonResp({ products: [{ id: 1 }, { id: 2 }] }));
    const r = await shopifyExecutor({ operation: 'listProducts', limit: '9999' }, null, ctx);
    expect((r.output as { count: number }).count).toBe(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('limit=250');
  });

  it('shopDomain non-myshopify → IntegrationError (anti-injection)', async () => {
    mockGetIntegration.mockReturnValue({
      credentials: { shopDomain: 'evil.com/admin', accessToken: 'shpat_x' },
    } as never);
    await expect(
      shopifyExecutor({ operation: 'getOrder', orderId: '1' }, null, ctx),
    ).rejects.toThrow(/shopDomain non valido/);
  });

  it('getOrder senza orderId → IntegrationError', async () => {
    await expect(shopifyExecutor({ operation: 'getOrder' }, null, ctx)).rejects.toThrow(
      /orderId obbligatorio/,
    );
  });
});

describe('mailchimpExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { apiKey: 'abc123def456-us21' } } as never);
  });

  it('addMember → PUT idempotent su subscriberHash MD5 + datacenter dal suffisso', async () => {
    mockFetch.mockResolvedValue(jsonResp({ id: 'hash1', status: 'subscribed' }));
    const r = await mailchimpExecutor(
      {
        operation: 'addMember',
        listId: 'list1',
        email: 'Mario.Rossi@Example.IT',
        status: 'pending',
      },
      null,
      ctx,
    );
    expect((r.output as { status: string }).status).toBe('subscribed');
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('us21.api.mailchimp.com/3.0/lists/list1/members/');
    // subscriberHash = MD5 lowercase email → 32 hex char (idempotenza)
    expect(url).toMatch(/\/members\/[a-f0-9]{32}$/);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('addTag → POST tags con status active', async () => {
    mockFetch.mockResolvedValue(jsonResp({}, 200));
    const r = await mailchimpExecutor(
      { operation: 'addTag', listId: 'list1', email: 'x@y.it', tag: 'lead-2026' },
      null,
      ctx,
    );
    expect((r.output as { tagged: boolean; tag: string }).tagged).toBe(true);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('/tags');
  });

  it('apiKey senza datacenter → IntegrationError (anti-config-errata)', async () => {
    mockGetIntegration.mockReturnValue({ credentials: { apiKey: 'no-datacenter-here' } } as never);
    await expect(
      mailchimpExecutor({ operation: 'addMember', listId: 'l1', email: 'x@y.it' }, null, ctx),
    ).rejects.toThrow(/datacenter/);
  });

  it('addMember senza email → IntegrationError', async () => {
    await expect(
      mailchimpExecutor({ operation: 'addMember', listId: 'l1' }, null, ctx),
    ).rejects.toThrow(/email obbligatoria/);
  });

  it('listId mancante → IntegrationError', async () => {
    await expect(
      mailchimpExecutor({ operation: 'addMember', email: 'x@y.it' }, null, ctx),
    ).rejects.toThrow(/listId/);
  });
});

describe('twilioExecutor', () => {
  const sid = 'AC' + 'a'.repeat(32);
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({
      credentials: { accountSid: sid, authToken: 'tok-secret', fromNumber: '+390212345678' },
    } as never);
    twilioGuards.__testHooks__.sendBuckets.clear(); // bucket rate-limit globale → reset per test
  });

  it('sendSms → POST form-encoded a Messages.json + Basic auth + E.164', async () => {
    mockFetch.mockResolvedValue(jsonResp({ sid: 'SM1', status: 'queued' }));
    const r = await twilioExecutor(
      { operation: 'sendSms', to: '+393331234567', body: 'Ciao' },
      null,
      ctx,
    );
    expect((r.output as { messageSid: string; status: string }).messageSid).toBe('SM1');
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain(`/Accounts/${sid}/Messages.json`);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toContain(
      'x-www-form-urlencoded',
    );
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(coerceString(init.body)).toContain('To=%2B393331234567');
  });

  it('sendWhatsapp → prefisso whatsapp: su To e From', async () => {
    mockFetch.mockResolvedValue(jsonResp({ sid: 'MM1', status: 'sent' }));
    const r = await twilioExecutor(
      { operation: 'sendWhatsapp', to: '+393331234567', body: 'Hi' },
      null,
      ctx,
    );
    expect((r.output as { to: string }).to).toBe('whatsapp:+393331234567');
    expect(coerceString((mockFetch.mock.calls[0]?.[1] as RequestInit).body)).toContain('whatsapp');
  });

  it('to non-E.164 → IntegrationError (anti-errore numero)', async () => {
    await expect(
      twilioExecutor({ operation: 'sendSms', to: '3331234567', body: 'x' }, null, ctx),
    ).rejects.toThrow(/E\.164/);
  });

  it('accountSid malformato → IntegrationError', async () => {
    mockGetIntegration.mockReturnValue({
      credentials: { accountSid: 'BADSID', authToken: 't' },
    } as never);
    await expect(
      twilioExecutor({ operation: 'sendSms', to: '+393331234567', body: 'x' }, null, ctx),
    ).rejects.toThrow(/accountSid non valido/);
  });

  it('sendSms senza body → IntegrationError', async () => {
    await expect(
      twilioExecutor({ operation: 'sendSms', to: '+393331234567' }, null, ctx),
    ).rejects.toThrow(/body/);
  });

  it('🚨🚨 TOLL-FRAUD: oltre il cap invii/min → RATE_LIMITED, nessun nuovo POST a Twilio', async () => {
    process.env.MEDEA_TWILIO_MAX_SENDS_PER_MIN = '3';
    twilioGuards.__testHooks__.sendBuckets.clear();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResp({ sid: 'SM', status: 'queued' }))); // Response fresca per call
    // i primi 3 passano
    for (let i = 0; i < 3; i++) {
      await twilioExecutor({ operation: 'sendSms', to: '+393331234567', body: `m${i}` }, null, ctx);
    }
    const callsAfter3 = mockFetch.mock.calls.length;
    // il 4° è bloccato PRIMA della fetch
    await expect(
      twilioExecutor({ operation: 'sendSms', to: '+393331234567', body: 'over' }, null, ctx),
    ).rejects.toThrow(/toll-fraud|Limite invii|RATE_LIMITED/u);
    expect(mockFetch.mock.calls.length).toBe(callsAfter3); // nessun POST aggiuntivo
    delete process.env.MEDEA_TWILIO_MAX_SENDS_PER_MIN;
  });

  it('🚨 getMessage NON consuma il budget anti toll-fraud (sola lettura)', async () => {
    process.env.MEDEA_TWILIO_MAX_SENDS_PER_MIN = '1';
    twilioGuards.__testHooks__.sendBuckets.clear();
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResp({ sid: 'SM1', status: 'delivered' })),
    );
    // molte letture non devono mai triggerare il rate-limit
    for (let i = 0; i < 5; i++) {
      await twilioExecutor({ operation: 'getMessage', messageSid: 'SM1' }, null, ctx);
    }
    // e un invio resta ancora possibile (il budget invii è intatto)
    await expect(
      twilioExecutor({ operation: 'sendSms', to: '+393331234567', body: 'x' }, null, ctx),
    ).resolves.toBeDefined();
    delete process.env.MEDEA_TWILIO_MAX_SENDS_PER_MIN;
  });
});

describe('sendgridExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { apiKey: 'SG.abc.def' } } as never);
  });

  it('sendEmail → POST mail/send con content + Bearer; 202 empty body → accepted', async () => {
    // SendGrid risponde 202 SENZA body → verifica robustezza gateway (text-first).
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
    const r = await sendgridExecutor(
      {
        operation: 'sendEmail',
        to: 'a@b.it',
        from: 'noreply@x.it',
        subject: 'Ciao',
        body: 'Test',
        contentType: 'text/html',
      },
      null,
      ctx,
    );
    expect((r.output as { accepted: boolean }).accepted).toBe(true);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('api.sendgrid.com/v3/mail/send');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SG.abc.def');
    const sent = JSON.parse(coerceString(init.body)) as {
      content: { type: string }[];
      subject: string;
    };
    expect(sent.content[0]?.type).toBe('text/html');
    expect(sent.subject).toBe('Ciao');
  });

  it('sendTemplate → template_id + dynamic_template_data', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
    await sendgridExecutor(
      {
        operation: 'sendTemplate',
        to: 'a@b.it',
        from: 'x@y.it',
        templateId: 'd-123',
        dynamicDataJson: '{"nome":"Mario"}',
      },
      null,
      ctx,
    );
    const sent = JSON.parse(coerceString((mockFetch.mock.calls[0]?.[1] as RequestInit).body)) as {
      template_id: string;
      personalizations: { dynamic_template_data: Record<string, unknown> }[];
    };
    expect(sent.template_id).toBe('d-123');
    expect(sent.personalizations[0]?.dynamic_template_data.nome).toBe('Mario');
  });

  it('email destinatario non valida → IntegrationError', async () => {
    await expect(
      sendgridExecutor(
        { operation: 'sendEmail', to: 'non-una-email', from: 'x@y.it', subject: 's', body: 'b' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/email valida/);
  });

  it('sendEmail senza subject → IntegrationError', async () => {
    await expect(
      sendgridExecutor(
        { operation: 'sendEmail', to: 'a@b.it', from: 'x@y.it', body: 'b' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/subject obbligatorio/);
  });

  it('sendTemplate senza templateId → IntegrationError', async () => {
    await expect(
      sendgridExecutor({ operation: 'sendTemplate', to: 'a@b.it', from: 'x@y.it' }, null, ctx),
    ).rejects.toThrow(/templateId obbligatorio/);
  });
});

describe('asanaExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { accessToken: '1/abc123' } } as never);
  });

  it('createTask → POST /tasks con wrapper {data} + Bearer + projects array', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ data: { gid: 'T1', permalink_url: 'https://app.asana.com/0/T1' } }),
    );
    const r = await asanaExecutor(
      {
        operation: 'createTask',
        name: 'Richiamare cliente',
        notes: 'urgente',
        projectId: '111,222',
        dueOn: '2026-06-30',
      },
      null,
      ctx,
    );
    expect((r.output as { taskId: string }).taskId).toBe('T1');
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('app.asana.com/api/1.0/tasks');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer 1/abc123');
    const sent = JSON.parse(coerceString(init.body)) as {
      data: { projects: string[]; due_on: string };
    };
    expect(sent.data.projects).toEqual(['111', '222']);
    expect(sent.data.due_on).toBe('2026-06-30');
  });

  it('addComment → POST /tasks/:id/stories', async () => {
    mockFetch.mockResolvedValue(jsonResp({ data: { gid: 'C1' } }));
    const r = await asanaExecutor(
      { operation: 'addComment', taskId: 'T1', commentText: 'fatto' },
      null,
      ctx,
    );
    expect((r.output as { commentId: string }).commentId).toBe('C1');
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('/tasks/T1/stories');
  });

  it('dueOn formato errato → IntegrationError', async () => {
    await expect(
      asanaExecutor({ operation: 'createTask', name: 'x', dueOn: '30-06-2026' }, null, ctx),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('createTask senza name → IntegrationError', async () => {
    await expect(asanaExecutor({ operation: 'createTask', notes: 'x' }, null, ctx)).rejects.toThrow(
      /name.*obbligatorio/,
    );
  });

  it('accessToken assente → IntegrationError', async () => {
    mockGetIntegration.mockReturnValue({ credentials: {} } as never);
    await expect(asanaExecutor({ operation: 'getTask', taskId: 'T1' }, null, ctx)).rejects.toThrow(
      /accessToken.*assente/,
    );
  });
});

describe('dropboxExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { accessToken: 'sl.token' } } as never);
  });

  it('listFolder root → POST list_folder con path vuoto + Bearer', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ entries: [{ name: 'a' }, { name: 'b' }], has_more: false }),
    );
    const r = await dropboxExecutor({ operation: 'listFolder', path: '/' }, null, ctx);
    expect((r.output as { count: number }).count).toBe(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      'api.dropboxapi.com/2/files/list_folder',
    );
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sl.token');
    expect(JSON.parse(coerceString(init.body)).path).toBe(''); // root normalizzato a ""
  });

  it('createFolder → path normalizzato con / iniziale', async () => {
    mockFetch.mockResolvedValue(jsonResp({ metadata: { id: 'id:1', path_display: '/Fatture' } }));
    const r = await dropboxExecutor({ operation: 'createFolder', path: 'Fatture' }, null, ctx);
    expect((r.output as { path: string }).path).toBe('/Fatture');
    expect(JSON.parse(coerceString((mockFetch.mock.calls[0]?.[1] as RequestInit).body)).path).toBe(
      '/Fatture',
    );
  });

  it('createSharedLink → ritorna sharedUrl', async () => {
    mockFetch.mockResolvedValue(jsonResp({ url: 'https://www.dropbox.com/s/abc' }));
    const r = await dropboxExecutor({ operation: 'createSharedLink', path: '/doc.pdf' }, null, ctx);
    expect((r.output as { sharedUrl: string }).sharedUrl).toBe('https://www.dropbox.com/s/abc');
  });

  it('createFolder senza path → IntegrationError', async () => {
    await expect(dropboxExecutor({ operation: 'createFolder' }, null, ctx)).rejects.toThrow(
      /path obbligatorio/,
    );
  });
});

describe('boxExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { accessToken: 'box-tok' } } as never);
  });

  it('listFolder root → GET /folders/0/items + Bearer + limit', async () => {
    mockFetch.mockResolvedValue(jsonResp({ entries: [{ id: '1' }, { id: '2' }], total_count: 2 }));
    const r = await boxExecutor({ operation: 'listFolder', limit: '5000' }, null, ctx);
    expect((r.output as { count: number; totalCount: number }).count).toBe(2);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('api.box.com/2.0/folders/0/items');
    expect(url).toContain('limit=1000'); // clampato a 1000
    expect(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'Bearer box-tok' });
  });

  it('createFolder → POST con parent.id', async () => {
    mockFetch.mockResolvedValue(jsonResp({ id: '99', name: 'Progetto' }));
    const r = await boxExecutor(
      { operation: 'createFolder', name: 'Progetto', parentId: '7' },
      null,
      ctx,
    );
    expect((r.output as { id: string }).id).toBe('99');
    expect(
      JSON.parse(coerceString((mockFetch.mock.calls[0]?.[1] as RequestInit).body)).parent.id,
    ).toBe('7');
  });

  it('createSharedLink → PUT shared_link.access + ritorna url', async () => {
    mockFetch.mockResolvedValue(jsonResp({ shared_link: { url: 'https://app.box.com/s/x' } }));
    const r = await boxExecutor(
      { operation: 'createSharedLink', itemId: '123', access: 'company' },
      null,
      ctx,
    );
    expect((r.output as { sharedUrl: string }).sharedUrl).toBe('https://app.box.com/s/x');
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(coerceString(init.body)).shared_link.access).toBe('company');
  });

  it('itemId non numerico → IntegrationError (anti-errore ID)', async () => {
    await expect(boxExecutor({ operation: 'getItem', itemId: 'abc' }, null, ctx)).rejects.toThrow(
      /ID numerico Box/,
    );
  });

  it('createFolder senza name → IntegrationError', async () => {
    await expect(
      boxExecutor({ operation: 'createFolder', parentId: '0' }, null, ctx),
    ).rejects.toThrow(/name.*obbligatorio/);
  });
});

describe('gcsExecutor', () => {
  beforeEach(() => {
    mockGetIntegration.mockReturnValue({ credentials: { accessToken: 'ya29.tok' } } as never);
  });

  it('listObjects → GET con prefix + maxResults clampato + Bearer', async () => {
    mockFetch.mockResolvedValue(jsonResp({ items: [{ name: 'a' }], nextPageToken: 'p2' }));
    const r = await gcsExecutor(
      { operation: 'listObjects', bucket: 'mio-bucket', prefix: 'fatture/', maxResults: '9999' },
      null,
      ctx,
    );
    expect((r.output as { count: number }).count).toBe(1);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('storage.googleapis.com/storage/v1/b/mio-bucket/o');
    expect(url).toContain('maxResults=1000'); // clampato
    expect(url).toContain('prefix=fatture');
    expect(
      (mockFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'Bearer ya29.tok' });
  });

  it('deleteObject → DELETE objectName encoded', async () => {
    mockFetch.mockResolvedValue(jsonResp({}, 200));
    const r = await gcsExecutor(
      { operation: 'deleteObject', bucket: 'buck1', objectName: 'fatture/F 1.pdf' },
      null,
      ctx,
    );
    expect((r.output as { deleted: boolean }).deleted).toBe(true);
    expect((mockFetch.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE');
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('fatture%2FF%201.pdf');
  });

  it('bucket non valido (maiuscole) → IntegrationError', async () => {
    await expect(
      gcsExecutor({ operation: 'listObjects', bucket: 'Bucket-MAIUSCOLO' }, null, ctx),
    ).rejects.toThrow(/bucket non valido/);
  });

  it('getObjectMetadata senza objectName → IntegrationError', async () => {
    await expect(
      gcsExecutor({ operation: 'getObjectMetadata', bucket: 'buck1' }, null, ctx),
    ).rejects.toThrow(/objectName obbligatorio/);
  });
});
