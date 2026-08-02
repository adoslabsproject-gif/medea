/**
 * tenantCollabExecutor — test bug-bounty (non green-confirming).
 *
 * Caccia ai bug reali del bridge cross-tenant:
 *   • bypass dell'allowlist (host lookalike, porta, credenziali in-URL,
 *     path traversal fuori da /api/v1/webhooks/)
 *   • firma HMAC NON stabile sui retry (= doppio processing lato ricevente)
 *   • retry su 4xx (= flood del destinatario su config sbagliata)
 *   • leak del token (negli errori di rete e nell'audit)
 *   • audit GDPR col payload dentro (violazione data minimization)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

const auditAppend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = auditAppend;
  },
}));

import { tenantCollabExecutor } from './tenant-collab.js';
import {
  COLLAB_CORRELATION_HEADER,
  COLLAB_IDEMPOTENCY_HEADER,
  COLLAB_SIGNATURE_HEADER,
  COLLAB_SOURCE_HEADER,
  COLLAB_TIMESTAMP_HEADER,
} from './tenant-collab-protocol.js';

const TOKEN = 'tok-collab-0123456789abcdef';
const URL_OK = 'https://acme.app.automazionezeli.com/api/v1/webhooks/wf-123/whtok-abcdef123456';

const ctx = {
  tenantId: 'tenant-a',
  workflowId: 'wf-src',
  runId: 'run-1',
  nodeId: 'node-1',
  defId: 'action_tenant_collab',
  secrets: {},
} as unknown as Parameters<typeof tenantCollabExecutor>[2];

const baseCfg = { collaborationUrl: URL_OK, connectionToken: TOKEN };

function ok202(): Response {
  return new Response(JSON.stringify({ ok: true, runId: 'recipient-run' }), { status: 202 });
}

const origFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  auditAppend.mockClear();
  fetchMock = vi.fn().mockResolvedValue(ok202());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('allowlist SSRF — il nodo NON è un HTTP generico', () => {
  const rejected = [
    ['host esterno', 'https://evil.com/api/v1/webhooks/wf/t'],
    [
      'suffix lookalike (dominio attacker)',
      'https://acme.app.automazionezeli.com.evil.io/api/v1/webhooks/wf/t',
    ],
    ['apex senza slug tenant', 'https://app.automazionezeli.com/api/v1/webhooks/wf/t'],
    ['schema http', 'http://acme.app.automazionezeli.com/api/v1/webhooks/wf/t'],
    ['porta esplicita', 'https://acme.app.automazionezeli.com:8443/api/v1/webhooks/wf/t'],
    ['credenziali in-URL', 'https://x.app.automazionezeli.com@evil.com/api/v1/webhooks/wf/t'],
    [
      'path fuori dai webhook (API admin)',
      'https://acme.app.automazionezeli.com/api/v1/admin/tenants',
    ],
    ['path webhook vuoto', 'https://acme.app.automazionezeli.com/api/v1/webhooks/'],
  ] as const;

  it.each(rejected)('rifiuta %s SENZA toccare la rete', async (_label, url) => {
    await expect(
      tenantCollabExecutor({ ...baseCfg, collaborationUrl: url }, {}, ctx),
    ).rejects.toThrow(/COLLAB_URL_NOT_ALLOWED|action_tenant_collab/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accetta un webhook FlowForge valido e POSTa esattamente quell'URL", async () => {
    const r = await tenantCollabExecutor(baseCfg, { hello: 'world' }, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(URL_OK);
    const out = r.output as { delivered: boolean; status: number; targetHost: string };
    expect(out.delivered).toBe(true);
    expect(out.status).toBe(202);
    expect(out.targetHost).toBe('acme.app.automazionezeli.com');
  });
});

describe('firma HMAC — contratto ts.body + stabilità sui retry', () => {
  it('firma verificabile: hmac-sha256(token, `${ts}.${body}`)', async () => {
    await tenantCollabExecutor({ ...baseCfg, payloadJson: '{"a":1}' }, {}, ctx);
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
    const ts = init.headers[COLLAB_TIMESTAMP_HEADER];
    const sig = init.headers[COLLAB_SIGNATURE_HEADER];
    expect(ts).toMatch(/^\d+$/);
    const expected = createHmac('sha256', TOKEN).update(`${ts}.${init.body}`).digest('hex');
    expect(sig).toBe(expected);
    expect(Math.abs(Number(ts) - Math.floor(Date.now() / 1000))).toBeLessThan(10);
  });

  it('firma e timestamp IDENTICI sul retry (at-most-once lato ricevente)', async () => {
    // SNAPSHOT degli header per-chiamata: l'executor passa lo stesso oggetto
    // headers a ogni fetch — senza copia, mock.calls vedrebbe solo lo stato
    // finale e una firma ri-calcolata sul retry passerebbe inosservata
    // (bug di aliasing scovato dal mutation-check 2026-06-12).
    const seenHeaders: Record<string, string>[] = [];
    const responses = [new Response('boom', { status: 503 }), ok202()];
    fetchMock.mockImplementation((_url: string, init: { headers: Record<string, string> }) => {
      seenHeaders.push({ ...init.headers });
      return Promise.resolve(responses[seenHeaders.length - 1]);
    });
    const r = await tenantCollabExecutor(baseCfg, { x: 1 }, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const h1 = seenHeaders[0]!;
    const h2 = seenHeaders[1]!;
    expect(h1[COLLAB_SIGNATURE_HEADER]).toBe(h2[COLLAB_SIGNATURE_HEADER]);
    expect(h1[COLLAB_TIMESTAMP_HEADER]).toBe(h2[COLLAB_TIMESTAMP_HEADER]);
    expect(h1[COLLAB_IDEMPOTENCY_HEADER]).toBe(h2[COLLAB_IDEMPOTENCY_HEADER]);
    expect((r.output as { attempts: number }).attempts).toBe(2);
  }, 10_000);

  it('signPayload=false → nessun header firma, output.signed=false', async () => {
    const r = await tenantCollabExecutor(
      { collaborationUrl: URL_OK, signPayload: 'false' },
      {},
      ctx,
    );
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers[COLLAB_SIGNATURE_HEADER]).toBeUndefined();
    expect(headers[COLLAB_TIMESTAMP_HEADER]).toBeUndefined();
    expect((r.output as { signed: boolean }).signed).toBe(false);
  });

  it('firma attiva + token corto/assente → errore CHIARO senza rete', async () => {
    await expect(
      tenantCollabExecutor({ collaborationUrl: URL_OK, connectionToken: 'corto' }, {}, ctx),
    ).rejects.toThrow(/token di connessione/);
    await expect(tenantCollabExecutor({ collaborationUrl: URL_OK }, {}, ctx)).rejects.toThrow(
      /token/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('idempotenza + header di correlazione', () => {
  it('idempotency key deterministica per (tenant,run,nodo) e diversa per nodi diversi', async () => {
    await tenantCollabExecutor(baseCfg, {}, ctx);
    await tenantCollabExecutor(baseCfg, {}, ctx);
    const ctx2 = { ...(ctx as object), nodeId: 'node-2' } as typeof ctx;
    await tenantCollabExecutor(baseCfg, {}, ctx2);
    const keys = fetchMock.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers[COLLAB_IDEMPOTENCY_HEADER],
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("idempotencyKey custom (ID di business) vince sull'auto", async () => {
    await tenantCollabExecutor({ ...baseCfg, idempotencyKey: 'order-42' }, {}, ctx);
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers[COLLAB_IDEMPOTENCY_HEADER]).toBe('order-42');
  });

  it('source tenant + correlation id propagati al ricevente', async () => {
    const r = await tenantCollabExecutor(baseCfg, {}, ctx);
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers[COLLAB_SOURCE_HEADER]).toBe('tenant-a');
    expect(headers[COLLAB_CORRELATION_HEADER]).toBe(
      (r.output as { correlationId: string }).correlationId,
    );
  });
});

describe('retry policy — transitori sì, config sbagliata MAI', () => {
  it('4xx del ricevente: NESSUN retry + messaggio che spiega cosa sistemare', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(tenantCollabExecutor(baseCfg, {}, ctx)).rejects.toThrow(
      /RIFIUTATO la firma|token/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maxRetries=0 → un solo tentativo anche su 5xx', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 500 }));
    await expect(tenantCollabExecutor({ ...baseCfg, maxRetries: '0' }, {}, ctx)).rejects.toThrow(
      /destinatario in errore/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('errore di rete: retried e il messaggio NON contiene i segreti', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error(`connect ECONNRESET ${URL_OK}?token=${TOKEN}`))
      .mockResolvedValueOnce(ok202());
    const r = await tenantCollabExecutor(baseCfg, {}, ctx);
    expect((r.output as { attempts: number }).attempts).toBe(2);
  }, 10_000);

  it('errore di rete definitivo: token e webhook-token scrubbed dal messaggio', async () => {
    fetchMock.mockRejectedValue(new Error(`getaddrinfo EAI_AGAIN for ${URL_OK} key=${TOKEN}`));
    let lastErr: Error | undefined;
    try {
      await tenantCollabExecutor({ ...baseCfg, maxRetries: '0' }, {}, ctx);
    } catch (e) {
      lastErr = e as Error;
    }
    expect(lastErr).toBeInstanceOf(Error);
    expect(lastErr!.message).not.toContain(TOKEN);
    expect(lastErr!.message).not.toContain('whtok-abcdef123456');
    expect(lastErr!.message).toContain('***');
  });
});

describe('payload — parsing, fallback input, cap dimensione', () => {
  it('payloadJson non-JSON → INVALID_PAYLOAD senza rete', async () => {
    await expect(
      tenantCollabExecutor({ ...baseCfg, payloadJson: '{rotto' }, {}, ctx),
    ).rejects.toThrow(/non è JSON valido/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("payloadJson vuoto → inoltra l'input del nodo", async () => {
    await tenantCollabExecutor(baseCfg, { from: 'upstream', n: 7 }, ctx);
    const body = (fetchMock.mock.calls[0]![1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({ from: 'upstream', n: 7 });
  });

  it('payload > 1MB → PAYLOAD_TOO_LARGE senza rete', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) });
    await expect(tenantCollabExecutor({ ...baseCfg, payloadJson: big }, {}, ctx)).rejects.toThrow(
      /PAYLOAD|cap/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('audit GDPR — data-transfer tracciato, payload MAI', () => {
  it('successo → collab.data_transfer.sent con sha256+byte del payload, NON il contenuto', async () => {
    const secret = { iban: 'IT60X0542811101000000123456' };
    await tenantCollabExecutor({ ...baseCfg, payloadJson: JSON.stringify(secret) }, {}, ctx);
    expect(auditAppend).toHaveBeenCalledTimes(1);
    const rec = auditAppend.mock.calls[0]![0] as {
      action: string;
      resourceType: string;
      tenantId: string;
      metadata: Record<string, unknown>;
    };
    expect(rec.action).toBe('collab.data_transfer.sent');
    expect(rec.resourceType).toBe('tenant_collab');
    expect(rec.tenantId).toBe('tenant-a');
    const body = JSON.stringify(secret);
    expect(rec.metadata.payloadSha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(rec.metadata.payloadBytes).toBe(Buffer.byteLength(body));
    expect(JSON.stringify(rec)).not.toContain('IT60X0542811101000000123456');
  });

  it('audit con URL REDATTO: il token webhook non finisce nella scatola nera', async () => {
    await tenantCollabExecutor(baseCfg, {}, ctx);
    const rec = auditAppend.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(rec.metadata.targetUrl).toBe(
      'https://acme.app.automazionezeli.com/api/v1/webhooks/wf-123/***',
    );
    expect(JSON.stringify(rec)).not.toContain('whtok-abcdef123456');
    expect(JSON.stringify(rec)).not.toContain(TOKEN);
  });

  it("fallimento → collab.data_transfer.failed con errorCode+httpStatus, e l'errore RIMBALZA", async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 403 }));
    await expect(tenantCollabExecutor(baseCfg, {}, ctx)).rejects.toThrow();
    expect(auditAppend).toHaveBeenCalledTimes(1);
    const rec = auditAppend.mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(rec.action).toBe('collab.data_transfer.failed');
    expect(rec.metadata.httpStatus).toBe(403);
    expect(rec.metadata.errorCode).toBe('RECIPIENT_REJECTED');
  });

  it("audit in errore → l'invio (già partito) NON fallisce, ma warning visibile", async () => {
    auditAppend.mockRejectedValueOnce(new Error('disk full'));
    const r = await tenantCollabExecutor(baseCfg, {}, ctx);
    expect((r.output as { delivered: boolean }).delivered).toBe(true);
    expect(r.warnings?.[0]).toMatch(/audit GDPR.*NON registrato/);
  });
});

describe('waitForResponse', () => {
  it("true (default) → risposta del ricevente nell'output", async () => {
    const r = await tenantCollabExecutor(baseCfg, {}, ctx);
    expect((r.output as { response: unknown }).response).toEqual({
      ok: true,
      runId: 'recipient-run',
    });
  });

  it('false → fire-and-forget: conta solo la consegna', async () => {
    const r = await tenantCollabExecutor({ ...baseCfg, waitForResponse: 'false' }, {}, ctx);
    const out = r.output as { response: unknown; delivered: boolean; status: number };
    expect(out.response).toBeNull();
    expect(out.delivered).toBe(true);
    expect(out.status).toBe(202);
  });
});
