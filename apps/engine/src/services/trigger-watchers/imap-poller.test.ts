/**
 * Bug-bounty — trigger-watchers/imap-poller.
 *
 * Nel monolite il poll IMAP usava ImapFlow/simpleParser/getDatabase/this.runs
 * inline → la matrice di idempotenza era testabile solo e2e con vi.mock. Con
 * le deps INIETTATE (client, parser, sqlite comportamentale, markSeen, store)
 * pinniamo qui:
 *   - gate credenziali + systemAccountId (con/senza config IMAP);
 *   - inferenza TLS da porta (993→tls, 143→starttls+disableAutoEnable);
 *   - cursore persistente: range fetch `<last+1>:*`, persist anche a 0 mail;
 *   - onlyUnseen: search {seen:false} con {uid:true} nel TERZO arg di fetch
 *     (il bug lost-mail storico — se regredisce, questo test lo becca);
 *   - matrice markSeen COMPLETA, incluso il caso subdolo 'never'+successo:
 *     cursore/dedup avanzano ma \Seen NON viene messo;
 *   - run fallito in on-success → cursore fermo, dedup non registrato,
 *     \Seen non messo (retry al poll dopo);
 *   - dedup Message-ID → skip; allowlist → reject WARN + cursore avanzato;
 *   - body cappato a MAX_BODY_CHARS; lock RILASCIATO anche se il parser
 *     lancia; connect fallito → persist dell'errore.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startImapPoller,
  MAX_BODY_CHARS,
  type ImapPollerDeps,
  type ImapPollClient,
  type ImapClientOptions,
  type ImapFetchedMessage,
  type ImapSqlite,
} from './imap-poller.js';
import type { simpleParser } from 'mailparser';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@flowforge/core-schema';

afterEach(() => { vi.restoreAllMocks(); });

function makeWf(): Workflow {
  return {
    id: 'wf-im', tenantId: 'tenant-a', name: 'IM', enabled: true,
    schemaVersion: '1.0.0', nodes: [], edges: [], nodeDefs: [],
    createdAt: '2026-06-12', updatedAt: '2026-06-12',
  } as unknown as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n1', defId: 'trigger_imap', config } as unknown as CanvasNode;
}

const VALID = { host: 'imap.test', username: 'u', password: 'p', pollIntervalSec: '60' };

class FakeImapClient implements ImapPollClient {
  messages: ImapFetchedMessage[] = [];
  searchResult: unknown = [];
  searchCalls: unknown[][] = [];
  fetchCalls: { range: unknown; query: Record<string, boolean>; opts?: Record<string, boolean> }[] = [];
  connects = 0;
  logouts = 0;
  releases = 0;
  connectError: Error | null = null;
  async connect(): Promise<void> {
    this.connects += 1;
    if (this.connectError) throw this.connectError;
  }
  async getMailboxLock(_mailbox: string): Promise<{ release(): void }> {
    return { release: () => { this.releases += 1; } };
  }
  async search(query: { seen: boolean }, opts: { uid: boolean }): Promise<unknown> {
    this.searchCalls.push([query, opts]);
    return this.searchResult;
  }
  fetch(range: unknown, query: Record<string, boolean>, opts?: Record<string, boolean>): AsyncIterable<ImapFetchedMessage> {
    this.fetchCalls.push({ range, query, ...(opts ? { opts } : {}) });
    const msgs = this.messages;
    return { async *[Symbol.asyncIterator]() { for (const x of msgs) yield x; } };
  }
  async logout(): Promise<void> { this.logouts += 1; }
}

/** Fake SQLite comportamentale: imap_state + imap_processed_messages reali in memoria. */
class FakeImapDb implements ImapSqlite {
  state = new Map<string, { last_uid_seen: number; last_error: string | null }>();
  processed = new Set<string>();
  prepare(sql: string): { get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown } {
    if (sql.includes('SELECT last_uid_seen FROM imap_state')) {
      return {
        get: (wfId, mailbox) => {
          const row = this.state.get(`${String(wfId)}::${String(mailbox)}`);
          return row ? { last_uid_seen: row.last_uid_seen } : undefined;
        },
        run: () => { throw new Error('unexpected'); },
      };
    }
    if (sql.includes('INSERT INTO imap_state')) {
      return {
        get: () => undefined,
        run: (wfId, mailbox, uid, err) => {
          this.state.set(`${String(wfId)}::${String(mailbox)}`, {
            last_uid_seen: uid as number, last_error: err as string | null,
          });
          return { changes: 1 };
        },
      };
    }
    if (sql.includes('SELECT 1 FROM imap_processed_messages')) {
      return {
        get: (wfId, messageId) => (this.processed.has(`${String(wfId)}::${String(messageId)}`) ? { 1: 1 } : undefined),
        run: () => { throw new Error('unexpected'); },
      };
    }
    if (sql.includes('INSERT OR IGNORE INTO imap_processed_messages')) {
      return {
        get: () => undefined,
        run: (wfId, messageId) => { this.processed.add(`${String(wfId)}::${String(messageId)}`); return { changes: 1 }; },
      };
    }
    throw new Error(`SQL inattesa nel fake: ${sql.slice(0, 50)}`);
  }
}

type ParsedMail = Awaited<ReturnType<typeof simpleParser>>;

function makeParsed(over: Partial<{ messageId: string; text: string; html: string; subject: string }> = {}): ParsedMail {
  return {
    messageId: over.messageId ?? '<m1@x>',
    subject: over.subject ?? 'Parsed subject',
    text: over.text ?? 'plain body',
    html: over.html ?? '<p>html</p>',
    attachments: [],
    headers: new Map(),
    date: new Date('2026-06-12T08:00:00Z'),
  } as unknown as ParsedMail;
}

function imapMsg(uid: number, over: Partial<{ subject: string; from: string }> = {}): ImapFetchedMessage {
  return {
    uid,
    envelope: {
      subject: over.subject ?? 'Env subject',
      from: [{ address: over.from ?? 's@x.com' }],
      to: [{ address: 'r@x.com' }],
    },
    source: Buffer.from('raw rfc822'),
  };
}

function makeDeps(over: Partial<ImapPollerDeps> = {}): {
  deps: ImapPollerDeps;
  db: FakeImapDb;
  client: FakeImapClient;
  clientOpts: ImapClientOptions[];
  parseMail: ReturnType<typeof vi.fn>;
  markSeen: ReturnType<typeof vi.fn>;
  dispatched: TriggerRunInput[];
  dispatchResult: { value: TriggerRunResult };
} {
  const db = new FakeImapDb();
  const client = new FakeImapClient();
  const clientOpts: ImapClientOptions[] = [];
  const dispatched: TriggerRunInput[] = [];
  const dispatchResult = { value: { runId: 'r-1', status: 'success', errorCount: 0 } };
  const parseMail = vi.fn(async () => makeParsed());
  const markSeen = vi.fn(async () => undefined);
  const deps: ImapPollerDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return dispatchResult.value;
    },
    sqlite: db,
    createClient: (opts) => { clientOpts.push(opts); return client; },
    parseMail: parseMail as unknown as typeof simpleParser,
    markSeen: markSeen as unknown as NonNullable<ImapPollerDeps['markSeen']>,
    getStore: (() => ({})) as unknown as NonNullable<ImapPollerDeps['getStore']>,
    getBreaker: () => ({ execute: (fn) => fn() }),
  };
  Object.assign(deps, over); // exactOptionalPropertyTypes: niente spread di Partial
  return { deps, db, client, clientOpts, parseMail, markSeen, dispatched, dispatchResult };
}

/** Il primo poll parte SUBITO alla registrazione: attendi che chiuda. */
async function startAndDrain(
  wf: Workflow, node: CanvasNode, deps: ImapPollerDeps, client: FakeImapClient,
  opts: { expectLogout?: boolean } = {},
): Promise<ReturnType<typeof startImapPoller>> {
  const job = startImapPoller(wf, node, deps);
  if (job) clearInterval(job.timer); // un solo poll: quello immediato
  if (opts.expectLogout !== false) {
    await vi.waitFor(() => { expect(client.logouts + client.connects).toBeGreaterThan(0); });
  }
  // Drena le microtask residue del poll.
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  return job;
}

describe('gate config e client options', () => {
  it.each([
    ['host mancante', { username: 'u', password: 'p' }],
    ['username mancante', { host: 'h', password: 'p' }],
    ['password mancante', { host: 'h', username: 'u' }],
  ])('%s → null, nessun client creato', (_l, config) => {
    const { deps, clientOpts } = makeDeps();
    expect(startImapPoller(makeWf(), makeNode(config), deps)).toBeNull();
    expect(clientOpts).toHaveLength(0);
  });

  it('systemAccountId senza config IMAP → null + warn', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { deps } = makeDeps({ resolveSystemAccount: () => null });
    expect(startImapPoller(makeWf(), makeNode({ systemAccountId: 'acct-1' }), deps)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-im', systemAccountId: 'acct-1' }),
      'trigger_imap references account without IMAP config',
    );
  });

  it('systemAccountId con IMAP → credenziali dell account usate per il client', async () => {
    const { deps, client, clientOpts } = makeDeps({
      resolveSystemAccount: () => ({
        imap: { host: 'imap.acct.test', port: 993, username: 'acct-user', password: 'acct-pass' },
      }) as never,
    });
    await startAndDrain(makeWf(), makeNode({ systemAccountId: 'acct-1' }), deps, client);
    expect(clientOpts[0]).toMatchObject({
      host: 'imap.acct.test', port: 993, secure: true,
      auth: { user: 'acct-user', pass: 'acct-pass' },
    });
  });

  it('porta 143 → starttls: secure=false + disableAutoEnable presente', async () => {
    const { deps, client, clientOpts } = makeDeps();
    await startAndDrain(makeWf(), makeNode({ ...VALID, port: '143' }), deps, client);
    expect(clientOpts[0]).toMatchObject({ secure: false, disableAutoEnable: false });
  });

  it('FIX bug NaN: pollIntervalSec non numerico → default 60s, MAI setInterval(NaN)', async () => {
    const spy = vi.spyOn(global, 'setInterval');
    const { deps, client } = makeDeps();
    const job = await startAndDrain(makeWf(), makeNode({ ...VALID, pollIntervalSec: 'abc' }), deps, client);
    expect(spy.mock.calls[0]![1]).toBe(60_000); // default, non NaN
    if (job) clearInterval(job.timer);
    spy.mockRestore();
  });
});

describe('cursore e modalità fetch', () => {
  it('cursore persistito → range fetch riparte da last+1; persist anche con 0 mail (last_poll_at vivo)', async () => {
    const { deps, db, client } = makeDeps();
    db.state.set('wf-im::INBOX', { last_uid_seen: 42, last_error: null });
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    expect(client.fetchCalls[0]!.range).toEqual({ uid: '43:*' });
    expect(client.fetchCalls[0]!.query).toEqual({ envelope: true, source: true, flags: true });
    expect(client.fetchCalls[0]!.opts).toBeUndefined(); // modalità cursore: 2 argomenti
    expect(db.state.get('wf-im::INBOX')).toEqual({ last_uid_seen: 42, last_error: null });
  });

  it('onlyUnseen → search({seen:false},{uid:true}) e {uid:true} nel TERZO arg di fetch (guard del bug lost-mail)', async () => {
    const { deps, client } = makeDeps();
    client.searchResult = [11, 12];
    await startAndDrain(makeWf(), makeNode({ ...VALID, onlyUnseen: 'true' }), deps, client);
    expect(client.searchCalls[0]).toEqual([{ seen: false }, { uid: true }]);
    expect(client.fetchCalls[0]!.range).toEqual([11, 12]);
    expect(client.fetchCalls[0]!.opts).toEqual({ uid: true });
  });

  it('connect fallito → errore PERSISTITO in imap_state + warn (operatore vede il guasto)', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { deps, db, client } = makeDeps();
    client.connectError = new Error('ECONNREFUSED');
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => {
      expect(db.state.get('wf-im::INBOX')?.last_error).toBe('ECONNREFUSED');
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-im', breaker: 'imap:imap.test:u' }),
      'IMAP poll skipped/failed (breaker)',
    );
  });

  it('parser che lancia → lock COMUNQUE rilasciato + errore persistito (niente mailbox lock orfano)', async () => {
    const { deps, db, client, parseMail } = makeDeps();
    client.messages = [imapMsg(10)];
    parseMail.mockRejectedValueOnce(new Error('MIME bomb'));
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => {
      expect(client.releases).toBe(1);
      expect(db.state.get('wf-im::INBOX')?.last_error).toBe('MIME bomb');
    });
  });
});

describe('dispatch e payload', () => {
  it('payload completo: triggerType imap, messageId, subject dal parser, body cappato a MAX_BODY_CHARS', async () => {
    const { deps, client, parseMail, dispatched } = makeDeps();
    client.messages = [imapMsg(50)];
    parseMail.mockResolvedValueOnce(makeParsed({ text: 'x'.repeat(MAX_BODY_CHARS + 10) }));
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => { expect(dispatched).toHaveLength(1); });
    const input = dispatched[0]!;
    expect(input.triggerType).toBe('imap');
    expect(input.tenantId).toBe('tenant-a');
    const ti = input.triggerInput as Record<string, unknown>;
    expect(ti.uid).toBe(50);
    expect(ti.messageId).toBe('<m1@x>');
    expect(ti.subject).toBe('Parsed subject');
    expect((ti.text as string).length).toBe(MAX_BODY_CHARS);
    expect(ti.attachmentCount).toBe(0);
  });

  it('🚨 messageGate dispatch=false → messaggio SCARTATO (no run), cursore comunque avanzato', async () => {
    const { deps, db, client, dispatched } = makeDeps({ messageGate: () => ({ dispatch: false }) });
    client.messages = [imapMsg(55)];
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => { expect(db.state.get('wf-im::INBOX')?.last_uid_seen).toBe(55); });
    expect(dispatched).toHaveLength(0);
  });

  it('🚨 messageGate dispatch=true + extra → run avviato, extra FUSO nel triggerInput (es. bounce)', async () => {
    const bounce = { bounceType: 'hard', failedRecipients: ['x@y.com'], status: '5.1.1' };
    const { deps, client, dispatched } = makeDeps({ messageGate: () => ({ dispatch: true, extra: { bounce } }) });
    client.messages = [imapMsg(56)];
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => { expect(dispatched).toHaveLength(1); });
    expect((dispatched[0]!.triggerInput as Record<string, unknown>).bounce).toEqual(bounce);
  });

  it('allowlist: mittente NON in lista → reject WARN, NESSUN run, cursore comunque avanzato', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { deps, db, client, dispatched } = makeDeps();
    client.messages = [imapMsg(60, { from: 'attacker@evil.com' })];
    await startAndDrain(makeWf(), makeNode({ ...VALID, senderAllowlist: 'good@x.com' }), deps, client);
    await vi.waitFor(() => { expect(db.state.get('wf-im::INBOX')?.last_uid_seen).toBe(60); });
    expect(dispatched).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'attacker@evil.com' }),
      'IMAP trigger: sender REJECTED by allowlist',
    );
  });

  it('dedup Message-ID: già processato → NESSUN run', async () => {
    const { deps, db, client, dispatched } = makeDeps();
    db.processed.add('wf-im::<m1@x>');
    client.messages = [imapMsg(70)];
    await startAndDrain(makeWf(), makeNode(VALID), deps, client);
    await vi.waitFor(() => { expect(db.state.get('wf-im::INBOX')?.last_uid_seen).toBe(70); });
    expect(dispatched).toHaveLength(0);
  });
});

describe('matrice markSeen / idempotenza (il cuore del trigger)', () => {
  const cases: {
    mode: string; runOk: boolean;
    wantMarkSeen: boolean; wantAdvance: boolean;
  }[] = [
    { mode: 'on-success', runOk: true, wantMarkSeen: true, wantAdvance: true },
    { mode: 'on-success', runOk: false, wantMarkSeen: false, wantAdvance: false },
    { mode: 'always', runOk: false, wantMarkSeen: true, wantAdvance: true },
    { mode: 'always', runOk: true, wantMarkSeen: true, wantAdvance: true },
    // Il caso SUBDOLO: 'never' + successo → cursore/dedup avanzano ma \Seen NO.
    { mode: 'never', runOk: true, wantMarkSeen: false, wantAdvance: true },
    { mode: 'never', runOk: false, wantMarkSeen: false, wantAdvance: false },
  ];

  it.each(cases)('markSeen=$mode run ok=$runOk → \\Seen=$wantMarkSeen, avanzamento=$wantAdvance', async ({ mode, runOk, wantMarkSeen, wantAdvance }) => {
    const made = makeDeps();
    made.dispatchResult.value = runOk
      ? { runId: 'r', status: 'success', errorCount: 0 }
      : { runId: 'r', status: 'error', errorCount: 1 };
    made.client.messages = [imapMsg(80)];
    await startAndDrain(makeWf(), makeNode({ ...VALID, markSeen: mode }), made.deps, made.client);
    await vi.waitFor(() => { expect(made.dispatched).toHaveLength(1); });
    for (let i = 0; i < 30; i += 1) await Promise.resolve();

    if (wantMarkSeen) {
      expect(made.markSeen).toHaveBeenCalledWith(expect.objectContaining({
        workflowId: 'wf-im', uid: 80, mode, mailbox: 'INBOX',
      }));
    } else {
      expect(made.markSeen).not.toHaveBeenCalled();
    }
    if (wantAdvance) {
      expect(made.db.processed.has('wf-im::<m1@x>')).toBe(true);
      expect(made.db.state.get('wf-im::INBOX')?.last_uid_seen).toBe(80);
    } else {
      expect(made.db.processed.has('wf-im::<m1@x>')).toBe(false);
      // Cursore fermo: persist finale di fine poll resta al valore iniziale (0).
      expect(made.db.state.get('wf-im::INBOX')?.last_uid_seen).toBe(0);
    }
  });

  it('ANTI-REGRESSIONE retry: run fallito in on-success → il poll successivo rifetcha lo STESSO uid', async () => {
    const made = makeDeps();
    made.dispatchResult.value = { runId: 'r', status: 'error', errorCount: 1 };
    made.client.messages = [imapMsg(90)];
    const wf = makeWf();
    const node = makeNode({ ...VALID, markSeen: 'on-success' });
    await startAndDrain(wf, node, made.deps, made.client);
    await vi.waitFor(() => { expect(made.dispatched).toHaveLength(1); });
    // Secondo poller (riavvio simulato): il cursore in stato è ancora 0 → range 1:*.
    const job2 = startImapPoller(wf, node, made.deps);
    clearInterval(job2!.timer);
    await vi.waitFor(() => { expect(made.client.fetchCalls.length).toBeGreaterThanOrEqual(2); });
    expect(made.client.fetchCalls[1]!.range).toEqual({ uid: '1:*' });
  });
});

/**
 * CONTRACT — OAuth2 / XOAUTH2 (fix 2026-06-19).
 *
 * Bug di SISTEMA: il poller scartava gli account OAuth (password vuota) →
 * imapPollers=0 per QUALSIASI tenant con trigger_imap su account Gmail/OAuth.
 * Qui blindiamo: account OAuth → poller CREATO (non null) + auth XOAUTH2
 * (`{user, accessToken}`) + refresh proattivo dell'access token scaduto.
 * Se qualcuno ripristina il guard `!password` o l'auth `{user, pass}`, questi
 * test diventano ROSSI (anti-regressione).
 */
function makeOAuthAccount(over: Record<string, unknown> = {}): unknown {
  return {
    authType: 'oauth2',
    oauth: { provider: 'google', email: 'michela@studio.it', expiresAt: '2099-01-01T00:00:00Z' },
    imap: { host: 'imap.gmail.com', port: 993, username: 'michela@studio.it', hasPassword: false },
    ...over,
  };
}
function oauthTokens(over: Partial<{ accessToken: string; refreshToken: string; expiresAt: Date; email: string }> = {}) {
  return {
    accessToken: over.accessToken ?? 'ACCESS-OLD',
    refreshToken: over.refreshToken ?? 'REFRESH-1',
    expiresAt: over.expiresAt ?? new Date('2099-01-01T00:00:00Z'),
    email: over.email ?? 'michela@studio.it',
  };
}

describe('imap-poller — OAuth2 / XOAUTH2 (contract anti-regressione)', () => {
  it('🚨 account OAuth con token → poller CREATO (non null): imapPollers diventa 1', () => {
    const { deps } = makeDeps({
      resolveSystemAccount: () => makeOAuthAccount() as never,
      resolveOAuthTokens: () => oauthTokens(),
      oauthNeedsRefresh: () => false,
    });
    const job = startImapPoller(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps);
    expect(job).not.toBeNull();
    clearInterval(job!.timer);
  });

  it('🚨 auth è XOAUTH2 ({user, accessToken}), NON {user, pass}', async () => {
    const { deps, client, clientOpts } = makeDeps({
      resolveSystemAccount: () => makeOAuthAccount() as never,
      resolveOAuthTokens: () => oauthTokens({ accessToken: 'ACCESS-VALID' }),
      oauthNeedsRefresh: () => false,
    });
    await startAndDrain(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps, client);
    expect(clientOpts[0]).toMatchObject({ host: 'imap.gmail.com', secure: true });
    expect(clientOpts[0]!.auth).toEqual({ user: 'michela@studio.it', accessToken: 'ACCESS-VALID' });
    expect('pass' in clientOpts[0]!.auth).toBe(false);
  });

  it('🚨 token scaduto → refresh chiamato + access token FRESCO usato + persistito', async () => {
    const refreshSpy = vi.fn(async () => ({ accessToken: 'ACCESS-FRESH', expiresAt: new Date('2099-06-01T00:00:00Z') }));
    const updateSpy = vi.fn();
    const { deps, client, clientOpts } = makeDeps({
      resolveSystemAccount: () => makeOAuthAccount() as never,
      resolveOAuthTokens: () => oauthTokens({ accessToken: 'ACCESS-STALE' }),
      oauthNeedsRefresh: () => true, // scaduto
      refreshOAuthToken: refreshSpy,
      updateOAuthAccess: updateSpy,
    });
    await startAndDrain(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps, client);
    expect(refreshSpy).toHaveBeenCalledWith('REFRESH-1');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-oauth', accessToken: 'ACCESS-FRESH' }));
    expect(clientOpts[0]!.auth).toEqual({ user: 'michela@studio.it', accessToken: 'ACCESS-FRESH' });
  });

  it('token valido → NESSUN refresh, usa l\'access token esistente', async () => {
    const refreshSpy = vi.fn(async () => ({ accessToken: 'NOPE', expiresAt: new Date() }));
    const { deps, client, clientOpts } = makeDeps({
      resolveSystemAccount: () => makeOAuthAccount() as never,
      resolveOAuthTokens: () => oauthTokens({ accessToken: 'ACCESS-GOOD' }),
      oauthNeedsRefresh: () => false,
      refreshOAuthToken: refreshSpy,
    });
    await startAndDrain(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps, client);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(clientOpts[0]!.auth).toEqual({ user: 'michela@studio.it', accessToken: 'ACCESS-GOOD' });
  });

  it('account OAuth SENZA token → null + warn (graceful, re-link)', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { deps } = makeDeps({
      resolveSystemAccount: () => makeOAuthAccount() as never,
      resolveOAuthTokens: () => null, // token mancanti
    });
    expect(startImapPoller(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ systemAccountId: 'acct-oauth' }),
      expect.stringContaining('OAuth account without usable tokens'),
    );
  });

  it('OAuth senza config IMAP esplicita → host dal preset provider (imap.gmail.com)', async () => {
    const { deps, client, clientOpts } = makeDeps({
      // niente campo imap → deve dedurre host/username da oauth (google)
      resolveSystemAccount: () => makeOAuthAccount({ imap: undefined }) as never,
      resolveOAuthTokens: () => oauthTokens(),
      oauthNeedsRefresh: () => false,
    });
    await startAndDrain(makeWf(), makeNode({ systemAccountId: 'acct-oauth' }), deps, client);
    expect(clientOpts[0]).toMatchObject({ host: 'imap.gmail.com', port: 993 });
    expect(clientOpts[0]!.auth).toEqual({ user: 'michela@studio.it', accessToken: 'ACCESS-OLD' });
  });
});
