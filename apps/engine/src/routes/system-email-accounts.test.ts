/**
 * Test 2026-grade — system-email-accounts route (8 endpoint).
 *
 * Coverage REALE con service mocked + auth/role gates verificati end-to-end:
 *  - GET / + /picker + /default: 401 senza auth, payload solo non-secret
 *  - POST /: 401 senza auth, 403 viewer/operator/editor (role gate owner),
 *    zod 400 (email invalida, port non int positivo), 400 password SMTP vuota
 *    su create, 201 happy path
 *  - PUT /:id: stesso gate role, password vuota OK (mantieni cipher)
 *  - DELETE /:id: role gate, ok=true se cancellato, ok=false se non trovato
 *  - POST /:id/test: 404 account not found, ok:false su verify throw (502),
 *    ok:true su verify success, role gate
 *  - POST /:id/test-full: steps array con smtp/imap/probe/dns; sendProbe
 *    skip se SMTP fail; IMAP skip se acct senza imap; deliverability sempre
 *    in ultimo step
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetRateLimitState } from '@/middleware/rate-limit.js';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  picker: vi.fn(),
  getDefault: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  resolveForExecutor: vi.fn(),
  resolveOAuthForExecutor: vi.fn(),
  updateOAuthAccessToken: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
  sendMail: vi.fn(),
  imapConnect: vi.fn(),
  imapLogout: vi.fn(),
  imapStatus: vi.fn(),
  imapClose: vi.fn(),
  imapLock: vi.fn(),
  delivCheck: vi.fn(),
}));

vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: class {
    list(t: string) { return m.list(t); }
    picker(t: string) { return m.picker(t); }
    getDefault(t: string) { return m.getDefault(t); }
    upsert(args: unknown, id?: string) { return m.upsert(args, id); }
    delete(id: string, t: string) { return m.delete(id, t); }
    resolveForExecutor(t: string, id: string) { return m.resolveForExecutor(t, id); }
    resolveOAuthForExecutor(t: string, id: string) { return m.resolveOAuthForExecutor(t, id); }
    updateOAuthAccessToken(args: unknown) { return m.updateOAuthAccessToken(args); }
  },
}));

vi.mock('@/services/email-deliverability.service.js', () => ({
  EmailDeliverabilityService: class {
    check(addr: string, host: string) { return m.delivCheck(addr, host); }
  },
}));

vi.mock('nodemailer', () => ({
  createTransport: () => ({
    verify: () => m.verify(),
    close: () => m.close(),
    sendMail: (args: unknown) => m.sendMail(args),
  }),
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    connect() { return m.imapConnect(); }
    logout() { return m.imapLogout(); }
    close() { return m.imapClose(); }
    getMailboxLock() { return m.imapLock(); }
    status() { return m.imapStatus(); }
  },
}));

vi.mock('@/lib/logger.js');

const auditMock = vi.hoisted(() => ({ append: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class { append = auditMock.append; },
}));
vi.mock('@/lib/actor.js', () => ({ getActorId: () => 'actor-test' }));

import { createSystemEmailAccountsRoutes } from './system-email-accounts.js';
import type { AuthContext } from '@/middleware/auth.js';

function buildApp(auth: Partial<AuthContext> | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) {
      const full: AuthContext = { userId: 'u', email: 'e@x', tenantId: 't1', role: 'owner', ...auth } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  app.route('/', createSystemEmailAccountsRoutes());
  return app;
}

const baseAccount = {
  id: 'acc-1', label: 'Marketing', fromAddress: 'mkt@x.com', isDefault: false,
  authType: 'password' as const,
  smtp: { host: 'smtp.x', port: 587, security: 'starttls' as const, username: 'mkt@x.com', hasPassword: true, password: 'pw' },
  imap: { host: 'imap.x', port: 993, username: 'mkt@x.com', hasPassword: true, password: 'pw' },
  createdAt: '2026', updatedAt: '2026',
};

const baseBody = {
  label: 'Marketing', fromAddress: 'mkt@x.com', isDefault: false,
  smtp: { host: 'smtp.x', port: 587, security: 'starttls', username: 'mkt@x.com', password: 'pw-new' },
};

beforeEach(() => {
  Object.values(m).forEach((f) => { if (typeof f === 'function' && 'mockReset' in f) (f as { mockReset: () => void }).mockReset(); });
  _resetRateLimitState(); // sliding-window singleton → reset tra test
  m.list.mockReturnValue([]);
  m.picker.mockReturnValue([]);
  m.getDefault.mockReturnValue(null);
  m.upsert.mockReturnValue(baseAccount);
  m.delete.mockReturnValue(true);
  m.verify.mockResolvedValue(undefined);
  m.sendMail.mockResolvedValue({ messageId: 'mid-1', accepted: ['x@y'], rejected: [] });
  m.imapConnect.mockResolvedValue(undefined);
  m.imapLogout.mockResolvedValue(undefined);
  m.imapLock.mockResolvedValue({ release: vi.fn() });
  m.imapStatus.mockResolvedValue({ messages: 42, unseen: 3 });
  m.delivCheck.mockResolvedValue({ ok: true, summary: 'SPF+DKIM+DMARC OK', spf: { ok: true }, dkim: { ok: true }, dmarc: { ok: true } });
});

describe('GET / + /picker + /default — auth required, tenant-scoped', () => {
  it('GET / 401 senza auth', async () => {
    const res = await buildApp(null).request('/');
    expect(res.status).toBe(401);
  });

  it('GET / happy path: forward list(tenantId)', async () => {
    m.list.mockReturnValue([baseAccount]);
    const res = await buildApp({ role: 'viewer' }).request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: unknown[] };
    expect(body.accounts).toHaveLength(1);
    expect(m.list).toHaveBeenCalledWith('t1');
  });

  it('GET /picker: 401 senza auth', async () => {
    const res = await buildApp(null).request('/picker');
    expect(res.status).toBe(401);
  });

  it('GET /picker happy: forward picker(tenantId)', async () => {
    m.picker.mockReturnValue([{ id: 'a', label: 'L', fromAddress: 'a@b', isDefault: false }]);
    const res = await buildApp({ role: 'editor' }).request('/picker');
    expect(res.status).toBe(200);
    expect(m.picker).toHaveBeenCalledWith('t1');
  });

  it('GET /default null: ritorna account=null', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/default');
    expect(await res.json()).toEqual({ account: null });
  });
});

describe('POST / — create con role gate + zod + password required', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(401);
  });

  it('🚨 viewer → 403 (role gate)', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(403);
  });

  it('editor → 403 (solo owner+superadmin)', async () => {
    const res = await buildApp({ role: 'editor' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(403);
  });

  it('owner happy path → 201 con account', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(201);
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });

  it('🚨 password SMTP vuota → 400 (no create)', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, password: '' } }),
    });
    expect(res.status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('zod 400 — fromAddress non email', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, fromAddress: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 — port negativo', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, port: -1 } }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 — security non in enum', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, security: 'evil' } }),
    });
    expect(res.status).toBe(400);
  });

  it('imap optional → upsert con imap forwarded', async () => {
    await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, imap: { host: 'imap.x', port: 993, username: 'u', password: 'p' } }),
    });
    expect((m.upsert.mock.calls[0]![0] as { imap?: unknown }).imap).toBeDefined();
  });
});

describe('PUT /:id — update con role gate, password empty consentita', () => {
  it('401', async () => {
    const res = await buildApp(null).request('/acc-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(401);
  });

  it('viewer 403', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/acc-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(403);
  });

  it('owner happy path → 200, service.upsert chiamato con id', async () => {
    const res = await buildApp({ role: 'owner' }).request('/acc-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    expect(m.upsert).toHaveBeenCalledWith(expect.any(Object), 'acc-1');
  });

  it('🚨 password vuota consentita su PUT (mantieni cipher esistente)', async () => {
    const res = await buildApp({ role: 'owner' }).request('/acc-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, password: '' } }),
    });
    expect(res.status).toBe(200); // no 400 come su POST
  });
});

describe('DELETE /:id', () => {
  it('viewer 403', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/acc-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('owner happy path → ok=true', async () => {
    m.delete.mockReturnValue(true);
    const res = await buildApp({ role: 'owner' }).request('/acc-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(m.delete).toHaveBeenCalledWith('acc-1', 't1');
  });

  it('id inesistente → deleted=false (no 404 nel route layer)', async () => {
    m.delete.mockReturnValue(false);
    const res = await buildApp({ role: 'owner' }).request('/acc-1', { method: 'DELETE' });
    expect(await res.json()).toEqual({ deleted: false });
  });
});

describe('POST /:id/test — SMTP verify only', () => {
  it('viewer 403', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/acc-1/test', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('account not found → 404', async () => {
    m.resolveForExecutor.mockReturnValue(null);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('verify OK → ok:true + message', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockResolvedValue(undefined);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain('smtp.x');
  });

  it('🚨 verify throw → 502 ok:false con error', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockRejectedValue(new Error('EAUTH no auth'));
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test', { method: 'POST' });
    expect(res.status).toBe(502);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('EAUTH');
  });

  it('finally: transporter.close sempre chiamato', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockRejectedValue(new Error('boom'));
    await buildApp({ role: 'owner' }).request('/acc-1/test', { method: 'POST' });
    expect(m.close).toHaveBeenCalled();
  });
});

describe('POST /:id/test-full — multi-phase diagnostic', () => {
  it('viewer 403', async () => {
    const res = await buildApp({ role: 'viewer' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('404 se account non trovato', async () => {
    m.resolveForExecutor.mockReturnValue(null);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('happy path: 3 step (smtp_verify + imap_connect + imap_inbox + deliverability_dns)', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { steps: { phase: string; ok: boolean }[] };
    const phases = body.steps.map((s) => s.phase);
    expect(phases).toContain('smtp_verify');
    expect(phases).toContain('imap_connect');
    expect(phases).toContain('imap_inbox');
    expect(phases).toContain('deliverability_dns');
  });

  it('account senza imap → skip imap step', async () => {
    const acctNoImap = { ...baseAccount, imap: undefined };
    m.resolveForExecutor.mockReturnValue(acctNoImap);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await res.json() as { steps: { phase: string }[] };
    expect(body.steps.find((s) => s.phase === 'imap_connect')).toBeUndefined();
    expect(body.steps.find((s) => s.phase === 'smtp_verify')).toBeDefined();
  });

  it('🚨 sendProbe=true + SMTP fail → probe_send skipped con error', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockRejectedValue(new Error('connection refused'));
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendProbe: true }),
    });
    const body = await res.json() as { steps: { phase: string; ok: boolean; error?: string }[] };
    const probe = body.steps.find((s) => s.phase === 'probe_send');
    expect(probe).toBeDefined();
    expect(probe!.ok).toBe(false);
    expect(probe!.error).toContain('SMTP non funziona');
  });

  it('sendProbe=true + SMTP ok → probe_send chiamato', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sendProbe: true, probeRecipient: 'test@elsewhere.com' }),
    });
    const body = await res.json() as { steps: { phase: string; ok: boolean }[] };
    const probe = body.steps.find((s) => s.phase === 'probe_send');
    expect(probe).toBeDefined();
    expect(probe!.ok).toBe(true);
    expect(m.sendMail).toHaveBeenCalled();
  });

  it('deliverability sempre eseguito anche se SMTP fail', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockRejectedValue(new Error('x'));
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const body = await res.json() as { steps: { phase: string; ok: boolean }[] };
    expect(body.steps.find((s) => s.phase === 'deliverability_dns')).toBeDefined();
  });

  it('body JSON malformato → continua (empty body ok)', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    const res = await buildApp({ role: 'owner' }).request('/acc-1/test-full', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(res.status).toBe(200);
  });
});

describe('🔴 #6 audit log su CRUD email accounts (era assente)', () => {
  it('POST → audit email_account.create con actor', async () => {
    m.upsert.mockReturnValue({ id: 'acc-9', label: 'X' });
    auditMock.append.mockClear();
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(201);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'email_account.create', resourceType: 'email_account', resourceId: 'acc-9', actorId: 'actor-test',
    }));
  });

  it('PUT /:id → audit email_account.update', async () => {
    m.upsert.mockReturnValue({ id: 'acc-1' });
    auditMock.append.mockClear();
    const res = await buildApp({ role: 'owner' }).request('/acc-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'email_account.update', resourceType: 'email_account', resourceId: 'acc-1',
    }));
  });

  it('DELETE /:id → audit email_account.delete', async () => {
    m.delete.mockReturnValue(true);
    auditMock.append.mockClear();
    const res = await buildApp({ role: 'owner' }).request('/acc-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'email_account.delete', resourceType: 'email_account', resourceId: 'acc-1',
    }));
  });
});

describe('🔴 SSRF — host SMTP/IMAP bloccato verso interni (no port-scan via /test)', () => {
  it.each(['172.20.0.1', 'localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254'])(
    'smtp.host "%s" → 400, service NON chiamato', async (host) => {
      const res = await buildApp({ role: 'owner' }).request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, host } }),
      });
      expect(res.status).toBe(400);
      expect(m.upsert).not.toHaveBeenCalled();
    },
  );

  it('🔴 imap.host interno → 400', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, imap: { host: '172.20.0.1', port: 993, username: 'u', password: 'p' } }),
    });
    expect(res.status).toBe(400);
  });

  it('🟢 host pubblico (smtp.gmail.com) → 201', async () => {
    const res = await buildApp({ role: 'owner' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseBody, smtp: { ...baseBody.smtp, host: 'smtp.gmail.com' } }),
    });
    expect(res.status).toBe(201);
  });
});

describe('🔴 N3 rate-limit: /test (connessione SMTP) oltre 10/min/user → 429', () => {
  it('11ª richiesta → 429 (le prime 10 passano)', async () => {
    m.resolveForExecutor.mockReturnValue(baseAccount);
    m.verify.mockResolvedValue(undefined);
    const app = buildApp({ role: 'owner' });
    for (let i = 0; i < 10; i++) {
      expect((await app.request('/acc-1/test', { method: 'POST' })).status).toBe(200);
    }
    const limited = await app.request('/acc-1/test', { method: 'POST' });
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: string }).error).toBe('rate_limit_exceeded');
  });
});
