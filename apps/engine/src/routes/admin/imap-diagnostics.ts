/**
 * Admin IMAP diagnostics — connect to system account inbox, report what's REALLY there.
 *
 * Estratto da routes/admin.ts (#199 H14 split) — 1 endpoint:
 *   GET /admin/imap/diagnose/:accountId[?tenant=...]
 *
 * Built per debug "trigger doesn't fire" issue: operator ha marcato
 * la mail UNREAD ma il watcher SEARCH ritorna []. Lista TUTTE le mailbox
 * + totali per-mailbox + recenti UID non lette INBOX con subject.
 */

import type { Hono } from 'hono';

export function registerImapDiagnosticsRoutes(app: Hono): void {
  app.get('/admin/imap/diagnose/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    const tenantId = c.req.query('tenant') ?? 'default';
    const { SystemEmailAccountsService } = await import('../../services/system-email-accounts.service.js');
    const svc = new SystemEmailAccountsService();
    const account = svc.resolveForExecutor(tenantId, accountId);
    if (!account) {
      return c.json({ error: 'account not found or not accessible by tenant' }, 404);
    }
    if (!account.imap) {
      return c.json({ error: 'account has no IMAP config' }, 400);
    }
    const { ImapFlow } = await import('imapflow');
    // System account doesn't carry explicit IMAP security flag — deriva dal port
    // (993 → implicit TLS, 143 → STARTTLS).
    const useTls = account.imap.port === 993;
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: useTls,
      auth: { user: account.imap.username, pass: account.imap.password ?? '' },
      logger: false,
      socketTimeout: 15_000,
    });
    const report: Record<string, unknown> = {
      account: { host: account.imap.host, user: account.imap.username, port: account.imap.port },
      mailboxes: [] as unknown[],
      inboxRecent: [] as unknown[],
      unseenSearchResult: null,
    };
    try {
      await client.connect();
      // 1) List all mailboxes (vediamo se la mail è in subfolder).
      const boxes = await client.list();
      for (const box of boxes) {
        try {
          const status = await client.status(box.path, { messages: true, unseen: true, recent: true });
          (report.mailboxes as unknown[]).push({
            path: box.path,
            name: box.name,
            flags: Array.from(box.flags ?? []),
            messages: status.messages ?? 0,
            unseen: status.unseen ?? 0,
            recent: status.recent ?? 0,
          });
        } catch (e) {
          (report.mailboxes as unknown[]).push({ path: box.path, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // 2) Su INBOX, run la SEARCH ESATTA del watcher + lista 10 UID recenti con metadata.
      const lock = await client.getMailboxLock('INBOX');
      try {
        const unseenUidsRaw = await client.search({ seen: false }, { uid: true });
        const unseenUids = Array.isArray(unseenUidsRaw) ? unseenUidsRaw : [];
        report.unseenSearchResult = unseenUids;
        const allUidsRaw = await client.search({ all: true }, { uid: true });
        const allUids = Array.isArray(allUidsRaw) ? allUidsRaw : [];
        const recent = allUids.slice(-10);
        for await (const msg of client.fetch(recent.length > 0 ? recent : '1:10', { envelope: true, flags: true, uid: true }, { uid: true })) {
          (report.inboxRecent as unknown[]).push({
            uid: msg.uid,
            seqno: msg.seq,
            subject: msg.envelope?.subject ?? null,
            from: msg.envelope?.from?.[0]?.address ?? null,
            to: (msg.envelope?.to ?? []).map((a) => a.address).filter(Boolean),
            date: msg.envelope?.date ?? null,
            flags: Array.from(msg.flags ?? []),
            isSeen: (msg.flags ?? new Set()).has('\\Seen'),
          });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      report.fatal = err instanceof Error ? err.message : String(err);
      try { await client.logout(); } catch { /* ignore */ }
    }
    return c.json(report);
  });
}
