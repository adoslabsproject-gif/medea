/**
 * imap-diagnostics ROUTE — logica interna (il guard 401 requireSuperAdmin è
 * già coperto da __characterization__/admin-routes-smoke.test.ts).
 *
 * Coperto qui: tenant guard (404 account non risolto), 400 se l'account non
 * ha config IMAP, e la derivazione TLS dalla porta (993 -> implicit TLS,
 * 143 -> STARTTLS) — un errore su questo aprirebbe/declasserebbe la cifratura.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const svcMock = vi.hoisted(() => ({ resolveForExecutor: vi.fn() }));
const imapClient = vi.hoisted(() => ({ connect: vi.fn(), logout: vi.fn() }));
const ImapFlowMock = vi.hoisted(() => vi.fn(() => imapClient));

vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: vi.fn(() => svcMock),
}));
vi.mock('imapflow', () => ({ ImapFlow: ImapFlowMock }));

import { registerImapDiagnosticsRoutes } from './imap-diagnostics.js';

function app(): Hono {
  const a = new Hono();
  registerImapDiagnosticsRoutes(a);
  return a;
}

beforeEach(() => {
  svcMock.resolveForExecutor.mockReset();
  imapClient.connect.mockReset();
  imapClient.logout.mockReset();
  ImapFlowMock.mockClear();
});

describe('GET /admin/imap/diagnose/:accountId', () => {
  it("404 se l'account non è risolvibile dal tenant", async () => {
    svcMock.resolveForExecutor.mockReturnValue(null);
    const res = await app().request('/admin/imap/diagnose/acc-1?tenant=t1');
    expect(res.status).toBe(404);
    expect(ImapFlowMock).not.toHaveBeenCalled();
  });

  it('usa tenant=default quando il query param manca', async () => {
    svcMock.resolveForExecutor.mockReturnValue(null);
    await app().request('/admin/imap/diagnose/acc-1');
    expect(svcMock.resolveForExecutor).toHaveBeenCalledWith('default', 'acc-1');
  });

  it("400 se l'account non ha configurazione IMAP", async () => {
    svcMock.resolveForExecutor.mockReturnValue({ imap: null });
    const res = await app().request('/admin/imap/diagnose/acc-1');
    expect(res.status).toBe(400);
    expect(ImapFlowMock).not.toHaveBeenCalled();
  });

  it('porta 993 → TLS implicito (secure: true)', async () => {
    svcMock.resolveForExecutor.mockReturnValue({
      imap: { host: 'mail.test', port: 993, username: 'u', password: 'p' },
    });
    // connect rigetta: ci fermiamo subito dopo il constructor (report.fatal),
    // ma gli argomenti del client sono già stati fissati.
    imapClient.connect.mockRejectedValue(new Error('refused'));
    imapClient.logout.mockResolvedValue(undefined);
    const res = await app().request('/admin/imap/diagnose/acc-1');
    expect(res.status).toBe(200);
    expect(ImapFlowMock).toHaveBeenCalledWith(expect.objectContaining({ port: 993, secure: true }));
  });

  it('porta 143 → STARTTLS (secure: false)', async () => {
    svcMock.resolveForExecutor.mockReturnValue({
      imap: { host: 'mail.test', port: 143, username: 'u', password: 'p' },
    });
    imapClient.connect.mockRejectedValue(new Error('refused'));
    imapClient.logout.mockResolvedValue(undefined);
    await app().request('/admin/imap/diagnose/acc-1');
    expect(ImapFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 143, secure: false }),
    );
  });

  it('un errore di connessione non rompe la response: 200 con report.fatal', async () => {
    svcMock.resolveForExecutor.mockReturnValue({
      imap: { host: 'mail.test', port: 993, username: 'u', password: 'p' },
    });
    imapClient.connect.mockRejectedValue(new Error('timeout'));
    imapClient.logout.mockResolvedValue(undefined);
    const res = await app().request('/admin/imap/diagnose/acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fatal?: string; account: { port: number } };
    expect(body.fatal).toBe('timeout');
    expect(body.account.port).toBe(993);
  });
});
