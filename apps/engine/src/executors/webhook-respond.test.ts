/**
 * webhook-respond executor — unit tests covering ALL 7 respondWith modes.
 *
 * Each test pins one contract that the HTTP handler downstream relies on.
 * If a test changes, routes/webhooks.ts almost certainly needs an update too.
 */

import { describe, it, expect } from 'vitest';
import { webhookRespondExecutor, WEBHOOK_RESPONSE_KEY } from './webhook-respond.js';

type ExecCtx = Parameters<typeof webhookRespondExecutor>[2];
const ctx: ExecCtx = {
  tenantId: 'acme',
  runId: 'r1',
  workflowId: 'wf1',
  nodeId: 'n1',
} as unknown as ExecCtx;

function payload(
  result: Awaited<ReturnType<typeof webhookRespondExecutor>>,
): Record<string, unknown> {
  const out = result.output as Record<string, unknown>;
  return out[WEBHOOK_RESPONSE_KEY] as Record<string, unknown>;
}

describe('webhookRespondExecutor — JSON mode (default)', () => {
  it('produces a 200 JSON envelope by default', async () => {
    const result = await webhookRespondExecutor({}, { ok: true, count: 3 }, ctx);
    const resp = payload(result);
    expect(resp.status).toBe(200);
    expect(resp.contentType).toBe('application/json');
    expect(resp.body).toBe('{"ok":true,"count":3}');
    expect(resp.bodyIsBase64).toBe(false);
  });

  it('honors explicit body when set', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', body: '{"manual":true}' },
      { ignored: 1 },
      ctx,
    );
    expect(payload(result).body).toBe('{"manual":true}');
  });

  it('honors statusPreset', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', statusPreset: '201 Created' },
      {},
      ctx,
    );
    expect(payload(result).status).toBe(201);
  });
});

describe('webhookRespondExecutor — text mode', () => {
  it('returns text/plain with input as body', async () => {
    const result = await webhookRespondExecutor({ respondWith: 'text' }, 'hello world', ctx);
    const resp = payload(result);
    expect(resp.contentType).toBe('text/plain; charset=utf-8');
    expect(resp.body).toBe('hello world');
  });
});

describe('webhookRespondExecutor — html mode', () => {
  it('returns text/html with explicit body', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'html', body: '<h1>Hi</h1>' },
      null,
      ctx,
    );
    const resp = payload(result);
    expect(resp.contentType).toBe('text/html; charset=utf-8');
    expect(resp.body).toBe('<h1>Hi</h1>');
  });
});

describe('webhookRespondExecutor — redirect mode', () => {
  it('defaults to 302 with Location header', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'redirect', redirectLocation: 'https://example.com/done' },
      {},
      ctx,
    );
    const resp = payload(result);
    expect(resp.status).toBe(302);
    expect((resp.headers as Record<string, string>).Location).toBe('https://example.com/done');
    expect(resp.body).toBe('');
  });

  it('honors explicit statusPreset (301 Moved)', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'redirect', redirectLocation: '/here', statusPreset: '301 Moved Permanently' },
      {},
      ctx,
    );
    expect(payload(result).status).toBe(301);
  });

  it('🚨🚨 OPEN-REDIRECT/XSS: schema pericoloso → throw (no javascript:/data:)', async () => {
    for (const loc of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
    ]) {
      await expect(
        webhookRespondExecutor({ respondWith: 'redirect', redirectLocation: loc }, {}, ctx),
      ).rejects.toThrow(/redirectLocation non valido/u);
    }
  });

  it('🚨 protocol-relative //evil.com → throw (porterebbe su host esterno)', async () => {
    await expect(
      webhookRespondExecutor(
        { respondWith: 'redirect', redirectLocation: '//evil.com/phish' },
        {},
        ctx,
      ),
    ).rejects.toThrow(/redirectLocation non valido/u);
  });

  it('✅ http(s) assoluto e path relativo "/..." consentiti', async () => {
    const abs = payload(
      await webhookRespondExecutor(
        { respondWith: 'redirect', redirectLocation: 'https://ok.example/x' },
        {},
        ctx,
      ),
    );
    expect((abs.headers as Record<string, string>).Location).toBe('https://ok.example/x');
    const rel = payload(
      await webhookRespondExecutor(
        { respondWith: 'redirect', redirectLocation: '/dashboard' },
        {},
        ctx,
      ),
    );
    expect((rel.headers as Record<string, string>).Location).toBe('/dashboard');
  });
});

describe('webhookRespondExecutor — binary mode', () => {
  it('returns base64 body with binaryContentType and Content-Disposition', async () => {
    const b64 = Buffer.from('hello pdf').toString('base64');
    const result = await webhookRespondExecutor(
      {
        respondWith: 'binary',
        binaryData: b64,
        binaryContentType: 'application/pdf',
        binaryFilename: 'report.pdf',
      },
      {},
      ctx,
    );
    const resp = payload(result);
    expect(resp.contentType).toBe('application/pdf');
    expect(resp.body).toBe(b64);
    expect(resp.bodyIsBase64).toBe(true);
    expect((resp.headers as Record<string, string>)['Content-Disposition']).toBe(
      'attachment; filename="report.pdf"',
    );
  });

  it('sanitizes filename quotes', async () => {
    const result = await webhookRespondExecutor(
      {
        respondWith: 'binary',
        binaryData: 'AA==',
        binaryFilename: 'evil"injection".pdf',
      },
      {},
      ctx,
    );
    expect((payload(result).headers as Record<string, string>)['Content-Disposition']).toBe(
      'attachment; filename="evilinjection.pdf"',
    );
  });

  // GAP2 FLIP — il consumer accetta un handle BinaryData in input (ref-primario).
  const inlineBin = (buf: Buffer): unknown => ({
    __ffBinary: true,
    encoding: 'base64',
    mimeType: 'application/pdf',
    size: buf.length,
    data: buf.toString('base64'),
  });

  it('🚨 input BinaryData inline → body = base64 dei byte risolti', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const result = await webhookRespondExecutor({ respondWith: 'binary' }, inlineBin(bytes), ctx);
    const resp = payload(result);
    expect(resp.bodyIsBase64).toBe(true);
    expect(Buffer.from(resp.body as string, 'base64').equals(bytes)).toBe(true);
  });

  it('🚨 input BinaryData ref → readBinary risolve dal disco → body base64', async () => {
    const bytes = Buffer.from('disk-pdf-bytes');
    const readBinary = async (_r: string): Promise<Buffer> => bytes;
    const refBin = {
      __ffBinary: true,
      encoding: 'ref',
      mimeType: 'application/pdf',
      size: bytes.length,
      ref: 'a'.repeat(64),
    };
    const result = await webhookRespondExecutor({ respondWith: 'binary' }, refBin, {
      ...ctx,
      readBinary,
    } as unknown as ExecCtx);
    expect(Buffer.from(payload(result).body as string, 'base64').equals(bytes)).toBe(true);
  });

  it('🚨 PRECEDENZA: input binary vince su config.binaryData', async () => {
    const real = Buffer.from('REAL-BYTES');
    const result = await webhookRespondExecutor(
      { respondWith: 'binary', binaryData: Buffer.from('LEGACY').toString('base64') },
      inlineBin(real),
      ctx,
    );
    expect(Buffer.from(payload(result).body as string, 'base64').toString()).toBe('REAL-BYTES');
  });
});

describe('webhookRespondExecutor — empty mode', () => {
  it('returns 204 with no body', async () => {
    const result = await webhookRespondExecutor({ respondWith: 'empty' }, {}, ctx);
    const resp = payload(result);
    expect(resp.status).toBe(204);
    expect(resp.body).toBe('');
  });
});

describe('webhookRespondExecutor — custom mode', () => {
  it('honors explicit contentType + customBody', async () => {
    const result = await webhookRespondExecutor(
      {
        respondWith: 'custom',
        contentType: 'application/xml',
        customBody: '<root><ok/></root>',
      },
      { ignored: true },
      ctx,
    );
    const resp = payload(result);
    expect(resp.contentType).toBe('application/xml');
    expect(resp.body).toBe('<root><ok/></root>');
  });
});

describe('webhookRespondExecutor — status resolution', () => {
  it('uses Custom status field when preset = Custom', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', statusPreset: 'Custom (specifica sotto)', status: 418 },
      {},
      ctx,
    );
    expect(payload(result).status).toBe(418);
  });

  it('clamps invalid status to mode default', async () => {
    const r1 = await webhookRespondExecutor({ respondWith: 'json', status: 0 }, {}, ctx);
    const r2 = await webhookRespondExecutor({ respondWith: 'json', status: 999 }, {}, ctx);
    const r3 = await webhookRespondExecutor({ respondWith: 'json', status: 'banana' }, {}, ctx);
    expect(payload(r1).status).toBe(200);
    expect(payload(r2).status).toBe(200);
    expect(payload(r3).status).toBe(200);
  });
});

describe('webhookRespondExecutor — CORS', () => {
  it('sets Access-Control-Allow-Origin when corsOrigin is configured', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', corsOrigin: 'https://app.example.com' },
      { ok: true },
      ctx,
    );
    expect((payload(result).headers as Record<string, string>)['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    );
  });

  it('does not set CORS when empty', async () => {
    const result = await webhookRespondExecutor({ respondWith: 'json' }, {}, ctx);
    expect(
      (payload(result).headers as Record<string, string>)['Access-Control-Allow-Origin'],
    ).toBeUndefined();
  });
});

describe('webhookRespondExecutor — headersJson', () => {
  it('parses headersJson into a string-string map', async () => {
    const result = await webhookRespondExecutor(
      {
        respondWith: 'json',
        headersJson: JSON.stringify({ 'Cache-Control': 'no-cache', 'X-Custom': 'v' }),
      },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['X-Custom']).toBe('v');
  });

  it('ignores malformed headersJson', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', headersJson: 'this is not json' },
      {},
      ctx,
    );
    expect(payload(result).headers).toEqual({});
  });
});

describe('🚨 webhookRespondExecutor — header injection / response splitting (CWE-113)', () => {
  it('strippa CR/LF/NUL dal VALORE di un header (no Set-Cookie iniettato)', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', headersJson: JSON.stringify({ 'X-Foo': 'ok\r\nSet-Cookie: evil=1' }) },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    // MUTATION: senza sanitizeHeaderValue → 'ok\r\nSet-Cookie: evil=1' → rosso.
    expect(headers['X-Foo']).toBe('okSet-Cookie: evil=1');
    expect(JSON.stringify(headers)).not.toMatch(/[\r\n]/);
    expect(headers['Set-Cookie']).toBeUndefined();
  });

  it('scarta un header col NOME non-token (CRLF/spazi/`:` nella chiave)', async () => {
    const result = await webhookRespondExecutor(
      {
        respondWith: 'json',
        headersJson: JSON.stringify({ 'X-Bad\r\nSet-Cookie': 'evil', 'X-Ok': 'v' }),
      },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    expect(headers['X-Ok']).toBe('v');
    expect(Object.keys(headers).some((k) => /[\r\n]/.test(k))).toBe(false);
    expect(headers['Set-Cookie']).toBeUndefined();
  });

  it('strippa CRLF da corsOrigin (Access-Control-Allow-Origin)', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'json', corsOrigin: 'https://ok.example\r\nX-Injected: 1' },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    expect(headers['Access-Control-Allow-Origin']).toBe('https://ok.exampleX-Injected: 1');
    expect(JSON.stringify(headers)).not.toMatch(/[\r\n]/);
  });

  it('redirect Location con CRLF-injection → REJECT (contratto rafforzato: URL invalido dopo strip)', async () => {
    // Prima: si strippava il CRLF e si teneva l'URL mangled (`https://ok.exampleSet-Cookie: x=1`).
    // Ora safeRedirectLocation valida l'URL DOPO lo strip: quell'input è un URL non
    // valido → throw. Più sicuro: nessuna Location malformata raggiunge il browser.
    await expect(
      webhookRespondExecutor(
        { respondWith: 'redirect', redirectLocation: 'https://ok.example\r\nSet-Cookie: x=1' },
        {},
        ctx,
      ),
    ).rejects.toThrow(/redirectLocation non valido/u);
  });

  it('redirect Location valida con CRLF in coda → strip + accettata', async () => {
    const result = await webhookRespondExecutor(
      { respondWith: 'redirect', redirectLocation: 'https://ok.example/path\r\n' },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    expect(headers.Location).toBe('https://ok.example/path');
    expect(JSON.stringify(headers)).not.toMatch(/[\r\n]/);
  });

  it('strippa CRLF dal filename in Content-Disposition (binary)', async () => {
    const result = await webhookRespondExecutor(
      {
        respondWith: 'binary',
        binaryData: 'AAAA',
        binaryFilename: 'report\r\nSet-Cookie: x=1.pdf',
      },
      {},
      ctx,
    );
    const headers = payload(result).headers as Record<string, string>;
    expect(JSON.stringify(headers)).not.toMatch(/[\r\n]/);
    expect(headers['Content-Disposition']).not.toMatch(/[\r\n]/);
  });
});
