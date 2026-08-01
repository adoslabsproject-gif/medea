/**
 * Test 2026-grade — sendEmailExecutor (SMTP send con OAuth2/XOAUTH2,
 * deliverability check, attachments SSRF guard, CRLF sanitization, breaker).
 *
 * 🚨 BUSINESS+SECURITY-CRITICAL: production email path. Test reali con mock
 * di nodemailer.createTransport (intercetta sendMail args) + SystemEmail
 * Service in-memory + DeliverabilityService mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';
import { makeBinaryRef, makeBinaryInline } from '@flowforge/core-schema';

const m = vi.hoisted(() => ({
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
  validateUrl: vi.fn(),
  resolveForExecutor: vi.fn(),
  resolveOAuthForExecutor: vi.fn(),
  updateOAuthAccessToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  deliverabilityCheck: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  createTransport: (...a: unknown[]) => {
    m.createTransport(...a);
    return { sendMail: m.sendMail, close: m.close };
  },
}));

vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()),
  validateUrlForFetch: (...a: unknown[]) => m.validateUrl(...a),
}));

vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: class {
    resolveForExecutor = m.resolveForExecutor;
    resolveOAuthForExecutor = m.resolveOAuthForExecutor;
    updateOAuthAccessToken = m.updateOAuthAccessToken;
  },
}));

vi.mock('@/services/email-deliverability.service.js', () => ({
  EmailDeliverabilityService: class {
    check = m.deliverabilityCheck;
  },
}));

vi.mock('@/services/email-oauth.service.js', () => {
  class EmailOAuthService {
    refreshAccessToken = m.refreshAccessToken;
    static needsRefresh(expiresAt: number): boolean {
      return expiresAt < Date.now() + 60_000;
    }
  }
  return { EmailOAuthService };
});

vi.mock('@/lib/logger.js');

import { sendEmailExecutor } from './nodemailer.js';

const ctx: NodeExecutionContext = {
  tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1',
} as NodeExecutionContext;

const baseConfig = {
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  username: 'user',
  password: 'pwd',
  from: 'me@example.com',
  to: 'you@example.com',
  subject: 'hi',
  body: '<p>body</p>',
  bodyType: 'html',
};

beforeEach(() => {
  m.sendMail.mockReset().mockResolvedValue({
    messageId: '<abc@x>', accepted: ['you@example.com'], rejected: [], response: '250 OK',
  });
  m.close.mockReset();
  m.createTransport.mockReset();
  m.validateUrl.mockReset().mockReturnValue({ ok: true });
  m.resolveForExecutor.mockReset();
  m.resolveOAuthForExecutor.mockReset();
  m.updateOAuthAccessToken.mockReset();
  m.refreshAccessToken.mockReset();
  m.deliverabilityCheck.mockReset();
});

describe('sendEmailExecutor — happy path inline config', () => {
  it('host+from+to+subject inline → sendMail called', async () => {
    const r = await sendEmailExecutor(baseConfig, {}, ctx);
    expect(m.sendMail).toHaveBeenCalledTimes(1);
    expect(m.close).toHaveBeenCalled();
    const out = r.output as { messageId: string; accepted: string[] };
    expect(out.messageId).toBe('<abc@x>');
    expect(out.accepted).toEqual(['you@example.com']);
  });

  it('transport built con starttls + requireTLS=true', async () => {
    await sendEmailExecutor(baseConfig, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.com', port: 587, secure: false, requireTLS: true,
      auth: { user: 'user', pass: 'pwd' },
    }));
  });

  it('security=tls → secure=true + requireTLS=false (SMTPS port 465)', async () => {
    await sendEmailExecutor({ ...baseConfig, security: 'tls', port: 465 }, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      secure: true, requireTLS: false,
    }));
  });

  it('bodyType=html → message.html set', async () => {
    await sendEmailExecutor(baseConfig, {}, ctx);
    expect(m.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      html: '<p>body</p>',
    }));
  });

  it('authMode default (password) → auth user/pass (back-compat)', async () => {
    await sendEmailExecutor(baseConfig, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'user', pass: 'pwd' },
    }));
  });
});

describe('sendEmailExecutor — OAuth2 (XOAUTH2) inline', () => {
  const oauthConfig = {
    host: 'smtp.gmail.com', port: 465, security: 'tls',
    from: 'me@gmail.com', to: 'you@example.com', subject: 'hi', body: '<p>b</p>', bodyType: 'html',
    authMode: 'oauth2',
    oauthUser: 'sender@gmail.com',
    oauthClientId: 'cid.apps.googleusercontent.com',
    oauthClientSecret: 'gocspx-secret',
    oauthRefreshToken: '1//refresh-tok',
  };

  it('🚨 authMode=oauth2 → auth OAuth2 con clientId/secret/refreshToken (no accessToken)', async () => {
    await sendEmailExecutor(oauthConfig, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: {
        type: 'OAuth2',
        user: 'sender@gmail.com',
        clientId: 'cid.apps.googleusercontent.com',
        clientSecret: 'gocspx-secret',
        refreshToken: '1//refresh-tok',
      },
    }));
  });

  it('oauthUser vuoto → fallback allo SMTP username', async () => {
    await sendEmailExecutor({ ...oauthConfig, oauthUser: '', username: 'fallback@gmail.com' }, {}, ctx);
    const arg = m.createTransport.mock.calls[0]![0] as { auth: { user: string } };
    expect(arg.auth.user).toBe('fallback@gmail.com');
  });

  it('🚨 authMode=oauth2 ma refreshToken mancante → throw esplicito, NESSUN invio', async () => {
    await expect(sendEmailExecutor({ ...oauthConfig, oauthRefreshToken: '' }, {}, ctx))
      .rejects.toThrow(/authMode=oauth2.*mancano.*oauthRefreshToken/u);
    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it('🚨 authMode=oauth2 ma clientId+secret mancanti → throw elenca i campi', async () => {
    await expect(sendEmailExecutor({ ...oauthConfig, oauthClientId: '', oauthClientSecret: '' }, {}, ctx))
      .rejects.toThrow(/oauthClientId.*oauthClientSecret/u);
  });
});

describe('sendEmailExecutor — body & rendering', () => {
  it('bodyType=text → message.text set, no html', async () => {
    await sendEmailExecutor({ ...baseConfig, bodyType: 'text', body: 'plain' }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.text).toBe('plain');
    expect(call.html).toBeUndefined();
  });

  it('bodyType=markdown → html+text both set', async () => {
    await sendEmailExecutor({ ...baseConfig, bodyType: 'markdown', body: '# H' }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.html).toBe('# H');
    expect(call.text).toBe('# H');
  });
});

describe('🚨 validation guards', () => {
  it('🚨 missing host → throw all required', async () => {
    await expect(sendEmailExecutor({ ...baseConfig, host: '' }, {}, ctx))
      .rejects.toThrow(/host\/from\/to\/subject all required/u);
  });

  it('🚨 missing to → throw', async () => {
    await expect(sendEmailExecutor({ ...baseConfig, to: '' }, {}, ctx))
      .rejects.toThrow(/all required/u);
  });

  it('🚨 subject con {{...}} unresolved → throw', async () => {
    await expect(sendEmailExecutor({ ...baseConfig, subject: 'Ordine {{order.id}}' }, {}, ctx))
      .rejects.toThrow(/unresolved \{\{\.\.\.\}\} template/u);
  });

  it('🚨 body con {{...}} unresolved → throw', async () => {
    await expect(sendEmailExecutor({ ...baseConfig, body: 'Hi {{user.name}}' }, {}, ctx))
      .rejects.toThrow(/body contains unresolved/u);
  });

  it('subject con {} singolo (non template) → OK', async () => {
    await sendEmailExecutor({ ...baseConfig, subject: 'price: {only one}' }, {}, ctx);
    expect(m.sendMail).toHaveBeenCalled();
  });
});

describe('🚨 systemAccountId — credentials from vault', () => {
  it('🚨 account not found → throw esplicito', async () => {
    m.resolveForExecutor.mockReturnValue(null);
    await expect(sendEmailExecutor({ ...baseConfig, systemAccountId: 'acc-1' }, {}, ctx))
      .rejects.toThrow(/non trovato per il tenant/u);
  });

  it('account password-based → override host/port/security/user/pwd', async () => {
    m.resolveForExecutor.mockReturnValue({
      smtp: { host: 'smtp.vault.com', port: 465, security: 'tls', username: 'vault-user', password: 'vault-pwd' },
      fromAddress: 'noreply@vault.com',
      authType: 'password',
    });
    await sendEmailExecutor({ systemAccountId: 'acc-1', to: 'to@x.com', subject: 's', body: 'b', bodyType: 'text' }, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.vault.com', port: 465, secure: true,
      auth: { user: 'vault-user', pass: 'vault-pwd' },
    }));
  });

  it('🚨 authType=oauth2 + tokens missing → throw re-link', async () => {
    m.resolveForExecutor.mockReturnValue({
      smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls', username: '', password: '' },
      fromAddress: 'me@gmail.com',
      authType: 'oauth2',
    });
    m.resolveOAuthForExecutor.mockReturnValue(null);
    await expect(sendEmailExecutor({ systemAccountId: 'acc-1', to: 'to@x.com', subject: 's', body: 'b', bodyType: 'text' }, {}, ctx))
      .rejects.toThrow(/tokens missing.*re-link/u);
  });

  it('authType=oauth2 + tokens fresh → XOAUTH2 auth con accessToken', async () => {
    m.resolveForExecutor.mockReturnValue({
      smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls', username: '', password: '' },
      fromAddress: 'me@gmail.com',
      authType: 'oauth2',
    });
    m.resolveOAuthForExecutor.mockReturnValue({
      accessToken: 'ya29.fresh', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, email: 'me@gmail.com',
    });
    await sendEmailExecutor({ systemAccountId: 'acc-1', to: 'to@x.com', subject: 's', body: 'b', bodyType: 'text' }, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: { type: 'OAuth2', user: 'me@gmail.com', accessToken: 'ya29.fresh' },
    }));
    expect(m.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('🚨 oauth2 + tokens stale → refresh + persist + send', async () => {
    m.resolveForExecutor.mockReturnValue({
      smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls', username: '', password: '' },
      fromAddress: 'me@gmail.com',
      authType: 'oauth2',
    });
    m.resolveOAuthForExecutor.mockReturnValue({
      accessToken: 'ya29.stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000, email: 'me@gmail.com',
    });
    m.refreshAccessToken.mockResolvedValue({ accessToken: 'ya29.NEW', expiresAt: Date.now() + 3_600_000 });
    await sendEmailExecutor({ systemAccountId: 'acc-1', to: 'to@x.com', subject: 's', body: 'b', bodyType: 'text' }, {}, ctx);
    expect(m.refreshAccessToken).toHaveBeenCalledWith('rt-1');
    expect(m.updateOAuthAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', accountId: 'acc-1', accessToken: 'ya29.NEW',
    }));
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ accessToken: 'ya29.NEW' }),
    }));
  });

  it('🚨 oauth2 refresh fail → throw "OAuth refresh failed"', async () => {
    m.resolveForExecutor.mockReturnValue({
      smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls', username: '', password: '' },
      fromAddress: 'me@gmail.com', authType: 'oauth2',
    });
    m.resolveOAuthForExecutor.mockReturnValue({
      accessToken: 'stale', refreshToken: 'rt', expiresAt: 0, email: 'me@gmail.com',
    });
    m.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(sendEmailExecutor({ systemAccountId: 'acc-1', to: 'to@x.com', subject: 's', body: 'b', bodyType: 'text' }, {}, ctx))
      .rejects.toThrow(/OAuth refresh failed for me@gmail\.com.*invalid_grant/u);
  });
});

describe('🚨 deliverabilityCheck', () => {
  it('off (default) → skip check + no deliverability in output', async () => {
    const r = await sendEmailExecutor(baseConfig, {}, ctx);
    expect(m.deliverabilityCheck).not.toHaveBeenCalled();
    const out = r.output as Record<string, unknown>;
    expect(out.deliverability).toBeUndefined();
  });

  it('strict + SPF/DKIM/DMARC OK → send + report in output', async () => {
    m.deliverabilityCheck.mockResolvedValue({
      ok: true, domain: 'example.com', summary: 'all green',
      spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: true },
    });
    const r = await sendEmailExecutor({ ...baseConfig, deliverabilityCheck: 'strict' }, {}, ctx);
    expect(m.deliverabilityCheck).toHaveBeenCalledTimes(1);
    expect(m.sendMail).toHaveBeenCalled();
    const out = r.output as { deliverability: { ok: boolean } };
    expect(out.deliverability).toMatchObject({ ok: true });
  });

  // ⚠️ NOTA: il modulo nodemailer.ts ha una cache LRU module-level su fromAddress
  // (`deliverabilityCache`). Per evitare cross-test pollution, ogni test usa
  // un from address univoco.
  it('🚨 strict + SPF mancante → throw + sendMail NON chiamato', async () => {
    m.deliverabilityCheck.mockResolvedValue({
      ok: false, domain: 'example.com', summary: 'SPF missing',
      spf: { ok: false }, dkim: { ok: true }, dmarc: { ok: true },
    });
    await expect(sendEmailExecutor({ ...baseConfig, from: 'strict-spf@example.com', deliverabilityCheck: 'strict' }, {}, ctx))
      .rejects.toThrow(/deliverabilityCheck=strict.*SPF mancanti/u);
    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it('warn + report.ok=false → send comunque + report in output', async () => {
    m.deliverabilityCheck.mockResolvedValue({
      ok: false, domain: 'example.com', summary: 'no DMARC',
      spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: false },
    });
    const r = await sendEmailExecutor({ ...baseConfig, from: 'warn-dmarc@example.com', deliverabilityCheck: 'warn' }, {}, ctx);
    expect(m.sendMail).toHaveBeenCalled();
    const out = r.output as { deliverability: { ok: boolean; domain: string } };
    expect(out.deliverability).toMatchObject({ ok: false, domain: 'example.com' });
  });

  it('strict + check throws → throw propagated', async () => {
    m.deliverabilityCheck.mockRejectedValue(new Error('DNS down'));
    await expect(sendEmailExecutor({ ...baseConfig, from: 'strict-throw@example.com', deliverabilityCheck: 'strict' }, {}, ctx))
      .rejects.toThrow(/DNS down/u);
  });

  it('warn + check throws → swallow + send', async () => {
    m.deliverabilityCheck.mockRejectedValue(new Error('DNS down'));
    await sendEmailExecutor({ ...baseConfig, from: 'warn-throw@example.com', deliverabilityCheck: 'warn' }, {}, ctx);
    expect(m.sendMail).toHaveBeenCalled();
  });

  it('cache hit: 2 send con stesso from → 1 sola check DNS', async () => {
    m.deliverabilityCheck.mockResolvedValue({
      ok: true, domain: 'example.com', summary: 'ok',
      spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: true },
    });
    const from = `cache-${Date.now()}@example.com`;
    await sendEmailExecutor({ ...baseConfig, from, deliverabilityCheck: 'warn' }, {}, ctx);
    await sendEmailExecutor({ ...baseConfig, from, deliverabilityCheck: 'warn' }, {}, ctx);
    expect(m.deliverabilityCheck).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 attachments SSRF guard + parsing', () => {
  it('🚨 attachments JSON invalid → throw', async () => {
    await expect(sendEmailExecutor({ ...baseConfig, attachmentsJson: 'not-json' }, {}, ctx))
      .rejects.toThrow(/attachments JSON is not valid/u);
  });

  it('attachments base64 → Buffer.from base64 → content', async () => {
    const att = JSON.stringify([{ filename: 'a.txt', base64: 'aGVsbG8=' }]);
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: att }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { attachments: { filename: string; content: Buffer }[] };
    expect(call.attachments[0]?.filename).toBe('a.txt');
    expect(call.attachments[0]?.content.toString('utf8')).toBe('hello');
  });

  it('🚨 attachment URL SSRF blocked → throw', async () => {
    // Mock preciso: l'host SMTP (pubblico) passa il guard di connessione, SOLO
    // l'URL allegato interno è bloccato. Altrimenti il guard host SSRF
    // (connect-host-guard) scatterebbe per primo sull'host.
    m.validateUrl.mockImplementation((u: string) =>
      /169\.254|172\.\d|\/\/10\.|192\.168|localhost|127\./.test(u)
        ? { ok: false, reason: 'private network' }
        : { ok: true });
    const att = JSON.stringify([{ filename: 'leak.pdf', url: 'http://169.254.169.254/imds' }]);
    await expect(sendEmailExecutor({ ...baseConfig, attachmentsJson: att }, {}, ctx))
      .rejects.toThrow(/SSRF guard.*private network/u);
  });

  it('attachment URL valid → path set', async () => {
    m.validateUrl.mockReturnValue({ ok: true });
    const att = JSON.stringify([{ filename: 'doc.pdf', url: 'https://cdn.example.com/d.pdf' }]);
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: att }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { attachments: { path: string }[] };
    expect(call.attachments[0]?.path).toBe('https://cdn.example.com/d.pdf');
  });

  it('🚨🚨 LFI: attachment.path su filesystem (/app/.env) → throw, email NON inviata', async () => {
    // L'opzione `path` di nodemailer legge un FILE su disco: un path su filesystem
    // allegherebbe i segreti del container (/app/.env = FLOWFORGE_SSO_SECRET). Bloccato
    // by design: solo URL http(s) o handle binari/base64.
    for (const p of ['/app/.env', '../../etc/passwd', 'file:///etc/passwd', '/proc/self/environ']) {
      m.sendMail.mockClear();
      const att = JSON.stringify([{ filename: 'leak', path: p }]);
      await expect(sendEmailExecutor({ ...baseConfig, attachmentsJson: att }, {}, ctx))
        .rejects.toThrow(/non ammesso.*filesystem|LFI|filesystem/u);
      expect(m.sendMail).not.toHaveBeenCalled();
    }
  });

  it('🚨 attachment.path con URL http(s) valido → passa per il guard SSRF', async () => {
    m.validateUrl.mockReturnValue({ ok: true });
    const att = JSON.stringify([{ filename: 'doc.pdf', path: 'https://cdn.example.com/d.pdf' }]);
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: att }, {}, ctx);
    expect(m.validateUrl).toHaveBeenCalledWith('https://cdn.example.com/d.pdf');
    const call = m.sendMail.mock.calls[0]?.[0] as { attachments: { path: string }[] };
    expect(call.attachments[0]?.path).toBe('https://cdn.example.com/d.pdf');
  });

  it('inline image → cid + contentDisposition inline', async () => {
    const att = JSON.stringify([{ filename: 'logo.png', base64: 'aGVsbG8=' }]);
    await sendEmailExecutor({ ...baseConfig, inlineImagesJson: att }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { attachments: { cid: string; contentDisposition: string }[] };
    expect(call.attachments[0]?.cid).toBe('logo.png');
    expect(call.attachments[0]?.contentDisposition).toBe('inline');
  });
});

describe('🚨 headers + priority + threading', () => {
  it('headersJson valid → merged in message.headers', async () => {
    await sendEmailExecutor({ ...baseConfig, headersJson: JSON.stringify({ 'X-Custom': 'v1' }) }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(call.headers['X-Custom']).toBe('v1');
  });

  it('headersJson invalid → silently skip (no throw)', async () => {
    await sendEmailExecutor({ ...baseConfig, headersJson: 'not-json' }, {}, ctx);
    expect(m.sendMail).toHaveBeenCalled();
  });

  it('🚨 nome header non valido (CRLF/`:`/spazi) → scartato, validi conservati', async () => {
    await sendEmailExecutor({ ...baseConfig, headersJson: JSON.stringify({
      'X-Good': 'ok',
      'X-Evil: injected\r\nBcc': 'attacker@evil.test', // nome con `:` + CRLF
      'Bad Header': 'x',                                // spazio nel nome
    }) }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(call.headers['X-Good']).toBe('ok');
    expect(Object.keys(call.headers)).not.toContain('X-Evil: injected\r\nBcc');
    expect(Object.keys(call.headers)).not.toContain('Bad Header');
    // nessuna chiave header contiene CRLF
    expect(Object.keys(call.headers).some((k) => /[\r\n]/.test(k))).toBe(false);
  });

  it('🚨 valore header con CRLF → sanitizzato (no header injection nel valore)', async () => {
    await sendEmailExecutor({ ...baseConfig, headersJson: JSON.stringify({
      'X-Note': 'riga1\r\nBcc: attacker@evil.test',
    }) }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(/[\r\n]/.test(call.headers['X-Note'] ?? '')).toBe(false);
  });

  it('inReplyTo + references → headers In-Reply-To + References', async () => {
    await sendEmailExecutor({ ...baseConfig, inReplyTo: '<msg-1@x>', references: '<msg-0@x>' }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(call.headers['In-Reply-To']).toBe('<msg-1@x>');
    expect(call.headers.References).toBe('<msg-0@x>');
  });

  it('priority=high → X-Priority 1 + Importance High + message.priority high', async () => {
    await sendEmailExecutor({ ...baseConfig, priority: 'high' }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string>; priority: string };
    expect(call.headers['X-Priority']).toBe('1');
    expect(call.headers.Importance).toBe('High');
    expect(call.priority).toBe('high');
  });

  it('priority=low → X-Priority 5 + Importance Low', async () => {
    await sendEmailExecutor({ ...baseConfig, priority: 'low' }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers: Record<string, string>; priority: string };
    expect(call.headers['X-Priority']).toBe('5');
    expect(call.priority).toBe('low');
  });

  it('priority=normal → no X-Priority + no message.priority', async () => {
    await sendEmailExecutor(baseConfig, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { headers?: Record<string, string>; priority?: string };
    expect(call.headers?.['X-Priority']).toBeUndefined();
    expect(call.priority).toBeUndefined();
  });
});

describe('🚨 DKIM inline signing', () => {
  it('all 3 fields present → dkim attribute on transport', async () => {
    await sendEmailExecutor({
      ...baseConfig,
      dkimDomain: 'example.com', dkimSelector: 's1', dkimPrivateKey: '----',
    }, {}, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      dkim: { domainName: 'example.com', keySelector: 's1', privateKey: '----' },
    }));
  });

  it('partial DKIM (missing selector) → no dkim attribute', async () => {
    await sendEmailExecutor({
      ...baseConfig, dkimDomain: 'example.com', dkimPrivateKey: '----',
    }, {}, ctx);
    const call = m.createTransport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.dkim).toBeUndefined();
  });
});

describe('🚨 cc + bcc + replyTo', () => {
  it('cc + bcc sanitized → set on message', async () => {
    await sendEmailExecutor({
      ...baseConfig, cc: 'cc@x.com', bcc: 'bcc@x.com', replyTo: 'rt@x.com',
    }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.cc).toBeTruthy();
    expect(call.bcc).toBeTruthy();
    expect(call.replyTo).toBeTruthy();
  });

  it('🚨 CRLF injection nel subject → sanitizzato (no \\r\\n)', async () => {
    await sendEmailExecutor({
      ...baseConfig, subject: 'hi\r\nBcc: leak@evil.com',
    }, {}, ctx);
    const call = m.sendMail.mock.calls[0]?.[0] as { subject: string };
    expect(call.subject).not.toContain('\r');
    expect(call.subject).not.toContain('\n');
  });
});

describe('output shape', () => {
  it('output include messageId/accepted/rejected/response + durationMs', async () => {
    const r = await sendEmailExecutor(baseConfig, {}, ctx);
    expect(r).toMatchObject({
      output: {
        messageId: '<abc@x>', accepted: ['you@example.com'], rejected: [], response: '250 OK',
      },
      durationMs: expect.any(Number),
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('🚨 circuit breaker per-host', () => {
  it('sendMail throws → breaker incrementa fail (transport.close called)', async () => {
    m.sendMail.mockRejectedValueOnce(new Error('connection refused'));
    await expect(sendEmailExecutor(baseConfig, {}, ctx)).rejects.toThrow(/connection refused/u);
    expect(m.close).toHaveBeenCalled();
  });
});

describe('🚨 GAP2 capstone — email accetta allegati BinaryData (resolver, verso ref-primario)', () => {
  const ctxBin = (readBinary?: (r: string) => Promise<Buffer>): NodeExecutionContext =>
    ({ tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1', readBinary } as unknown as NodeExecutionContext);
  const sentAttachments = (): { filename?: string; content?: Buffer; path?: string }[] =>
    (m.sendMail.mock.calls[0]![0] as { attachments?: { filename?: string; content?: Buffer; path?: string }[] }).attachments ?? [];

  it('🚨 allegato binary ref → risolto via readBinary, content = byte (no base64 nel JSON)', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const readBinary = vi.fn(async (_r: string) => bytes);
    const bin = makeBinaryRef({ mimeType: 'application/pdf', ref: 'a'.repeat(64), size: bytes.length, fileName: 'doc.pdf' });
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: JSON.stringify([{ filename: 'doc.pdf', binary: bin }]) }, {}, ctxBin(readBinary));
    expect(readBinary).toHaveBeenCalledWith('a'.repeat(64));
    const att = sentAttachments()[0]!;
    expect(Buffer.isBuffer(att.content)).toBe(true);
    expect((att.content!).equals(bytes)).toBe(true);
  });

  it('🚨 allegato binary inline → byte senza reader (fallback)', async () => {
    const bytes = Buffer.from('inline-pdf-bytes');
    const bin = makeBinaryInline({ mimeType: 'application/pdf', data: bytes.toString('base64'), fileName: 'x.pdf' });
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: JSON.stringify([{ filename: 'x.pdf', binary: bin }]) }, {}, ctxBin());
    expect((sentAttachments()[0]!.content!).equals(bytes)).toBe(true);
  });

  it('🚨 PRECEDENZA: binary vince su base64 (forma primaria)', async () => {
    const bin = makeBinaryInline({ mimeType: 'text/plain', data: Buffer.from('REAL').toString('base64') });
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: JSON.stringify([{ filename: 'a.txt', binary: bin, base64: Buffer.from('LEGACY').toString('base64') }]) }, {}, ctxBin());
    expect((sentAttachments()[0]!.content!).toString()).toBe('REAL');
  });

  it('🚨 REGRESSIONE: solo base64 (legacy) → content = Buffer.from(base64), invariato', async () => {
    const bytes = Buffer.from('legacy-attachment');
    await sendEmailExecutor({ ...baseConfig, attachmentsJson: JSON.stringify([{ filename: 'l.txt', base64: bytes.toString('base64') }]) }, {}, ctxBin());
    expect((sentAttachments()[0]!.content!).equals(bytes)).toBe(true);
  });
});
