/**
 * trigger-watchers/imap-poller — trigger_imap, production-grade (split
 * 2026-06-12, estratto dal monolite TriggerWatchersService).
 *
 * Cosa fa:
 *  1. Scarica il sorgente COMPLETO del messaggio (non solo envelope) e parsa il
 *     MIME via mailparser: body text/html + TUTTI gli allegati (ref-primario
 *     BinaryStore, cap MAX_ATTACHMENT_BYTES).
 *  2. Cursore UID persistente in SQLite (`imap_state`) — sopravvive ai deploy.
 *  3. At-most-once via `imap_processed_messages` (dedup RFC 5322 Message-ID).
 *  4. Filtri AND: subject/from/to regex, allowlist mittenti (gate di SICUREZZA,
 *     dopo i regex), hasAttachment + MIME regex.
 *  5. markSeen: 'always' | 'on-success' | 'never' — la matrice di idempotenza:
 *     cursore/dedup avanzano su 'always' o su run RIUSCITO; run fallito in
 *     'on-success' → email resta UNREAD e viene ritentata al poll dopo.
 *  6. Circuit breaker per (host,username); \Seen su connessione FRESCA
 *     (markSeenWithFreshConnection — la connessione del poll può essere morta
 *     dopo un run lungo).
 *
 * Modalità fetch: default cursore UID (`lastUidSeen+1:*`); `onlyUnseen` usa la
 * search {seen:false} così l'operatore ri-triggera segnando l'email come "da
 * leggere" (dedup resta sul Message-ID). NB: `{uid:true}` va nel TERZO
 * argomento di fetch — nel secondo ImapFlow lo ignora e interpreta il range
 * come sequence numbers (bug lost-mail storico, documentato sotto).
 *
 * Elevazione vs monolite (no downgrade): sqlite store, client IMAP, parser
 * MIME, resolver degli account di sistema, binary store, markSeen e breaker
 * sono INIETTABILI (`ImapPollerDeps`). Default = produzione reale.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { logger } from '@/lib/logger.js';
import { getDatabase } from '@/storage/db.js';
import { SystemEmailAccountsService } from '../system-email-accounts.service.js';
import { EmailOAuthService } from '../email-oauth.service.js';
import { getBinaryStore } from '../binary-store.service.js';
import { parseMarkSeen, parseAllowlist, safeRegex, pickAddress, collectAddresses, clampNumber } from './parsing.js';
import { buildImapAttachment, type ImapAttachment } from './imap-attachment.js';
import { markSeenWithFreshConnection } from './imap-mark-seen.js';
import { resolveTriggerBreaker, type TriggerBreaker } from './breaker.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

/** Trim of body text we keep in the payload — defends against ingesting a 10MB
 *  marketing email that bloats run logs. Body still goes into the workflow
 *  but capped to this length. */
export const MAX_BODY_CHARS = Number(process.env.MEDEA_IMAP_MAX_BODY_CHARS ?? 200_000);

export interface ImapPollerJob {
  workflowId: string;
  timer: ReturnType<typeof setInterval>;
  lastUidSeen: number;
}

/** Superficie minima di better-sqlite3 usata qui (imap_state + dedup). */
export interface ImapSqlite {
  prepare(sql: string): {
    get: (...p: unknown[]) => unknown;
    run: (...p: unknown[]) => unknown;
  };
}

export interface ImapFetchedMessage {
  uid: number;
  envelope?: {
    subject?: string;
    from?: { address?: string }[];
    to?: { address?: string }[];
    date?: Date;
  };
  source?: Buffer;
}

/** Superficie minima del client ImapFlow usata dal poll — fake-abile nei test. */
export interface ImapPollClient {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  search(query: { seen: boolean }, opts: { uid: boolean }): Promise<unknown>;
  fetch(
    range: unknown,
    query: Record<string, boolean>,
    opts?: Record<string, boolean>,
  ): AsyncIterable<ImapFetchedMessage>;
  logout(): Promise<void>;
}

/**
 * Auth IMAP: password classica OPPURE XOAUTH2 (Gmail/OAuth2). ImapFlow supporta
 * nativamente entrambe — `{ user, accessToken }` attiva XOAUTH2.
 */
export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export interface ImapClientOptions {
  host: string;
  port: number;
  secure: boolean;
  disableAutoEnable?: boolean;
  auth: ImapAuth;
}

/** Token OAuth risolti (decrittati) di un system account. */
export interface ImapOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email: string;
}

export interface ImapPollerDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Store per imap_state/imap_processed_messages. Default: `getDatabase().sqlite`. */
  sqlite?: ImapSqlite;
  /** Factory del client IMAP del poll. Default: `new ImapFlow`. */
  createClient?: (opts: ImapClientOptions) => ImapPollClient;
  /** Parser MIME. Default: `simpleParser` (mailparser). */
  parseMail?: typeof simpleParser;
  /** Resolver degli account email di sistema. Default: `SystemEmailAccountsService`. */
  resolveSystemAccount?: (tenantId: string, accountId: string) => ReturnType<SystemEmailAccountsService['resolveForExecutor']>;
  /** Binary store per gli allegati ref-primario. Default: `getBinaryStore()`. */
  getStore?: typeof getBinaryStore;
  /** Marca \Seen su connessione fresca. Default: `markSeenWithFreshConnection`. */
  markSeen?: typeof markSeenWithFreshConnection;
  /** Resolver del circuit breaker per (host,username). Default: registry condiviso. */
  getBreaker?: (name: string) => TriggerBreaker;
  /**
   * Hook per-messaggio (default: dispatch sempre, nessun extra). Ritorna
   * `dispatch:false` per SCARTARE il messaggio (es. trigger_email_bounce scarta i
   * non-bounce) e `extra` da FONDERE nel triggerInput. PURO (no IO) → testabile.
   * Eseguito dopo il parse MIME, prima del dedup (stesso punto degli altri filtri).
   */
  messageGate?: (parsed: ParsedMail, rawSource: string) => { dispatch: boolean; extra?: Record<string, unknown> };
  // ── OAuth2 (Gmail XOAUTH2) — INIETTABILI per test/contract ──
  /** Token OAuth (refresh+access+expiry) del system account. Default: SystemEmailAccountsService. */
  resolveOAuthTokens?: (tenantId: string, accountId: string) => ImapOAuthTokens | null;
  /** Refresh dell'access token via portal. Default: EmailOAuthService.refreshAccessToken. */
  refreshOAuthToken?: (refreshToken: string) => Promise<{ accessToken: string; expiresAt: Date }>;
  /** Gate "serve refresh?" (leeway su expiry). Default: EmailOAuthService.needsRefresh. */
  oauthNeedsRefresh?: (expiresAt: Date) => boolean;
  /** Persiste l'access token refreshato (encrypted at rest). Default: SystemEmailAccountsService. */
  updateOAuthAccess?: (args: { tenantId: string; accountId: string; accessToken: string; expiresAt: Date }) => void;
}

const defaultResolveOAuthTokens = (tenantId: string, accountId: string): ImapOAuthTokens | null => {
  const t = new SystemEmailAccountsService().resolveOAuthForExecutor(tenantId, accountId);
  return t ? { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, email: t.email } : null;
};
const defaultRefreshOAuthToken = async (refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> => {
  const r = await new EmailOAuthService().refreshAccessToken(refreshToken);
  return { accessToken: r.accessToken, expiresAt: r.expiresAt };
};
const defaultUpdateOAuthAccess = (args: { tenantId: string; accountId: string; accessToken: string; expiresAt: Date }): void => {
  new SystemEmailAccountsService().updateOAuthAccessToken(args);
};

const defaultCreateClient = (opts: ImapClientOptions): ImapPollClient =>
  new ImapFlow({ ...opts, logger: false });

const defaultResolveSystemAccount = (
  tenantId: string,
  accountId: string,
): ReturnType<SystemEmailAccountsService['resolveForExecutor']> =>
  new SystemEmailAccountsService().resolveForExecutor(tenantId, accountId);

/**
 * Avvia il poller per un nodo trigger_imap. Ritorna il job (handle per
 * `clearInterval`) oppure `null` se le credenziali sono incomplete o il
 * systemAccountId non ha config IMAP — in quel caso NIENTE viene registrato.
 */
export function startImapPoller(
  wf: Workflow,
  node: CanvasNode,
  deps: ImapPollerDeps,
): ImapPollerJob | null {
  const tenantId = wf.tenantId ?? 'default';

  let host = typeof node.config.host === 'string' ? node.config.host : '';
  let port = Number(node.config.port ?? 993);
  let username = typeof node.config.username === 'string' ? node.config.username : '';
  let password = typeof node.config.password === 'string' ? node.config.password : '';
  // Non-vuoto → account OAuth2 (Gmail XOAUTH2): niente password, access token per-poll.
  let oauthAccountId = '';
  const systemAccountId = typeof node.config.systemAccountId === 'string' ? node.config.systemAccountId : '';
  if (systemAccountId) {
    const acct = (deps.resolveSystemAccount ?? defaultResolveSystemAccount)(tenantId, systemAccountId);
    if (acct?.authType === 'oauth2') {
      // OAuth2: host/username dall'IMAP config se presente, altrimenti dal preset
      // del provider (Gmail → imap.gmail.com:993). La password resta VUOTA: si usa
      // l'access token XOAUTH2 risolto per-poll (gestione scadenza ~1h).
      oauthAccountId = systemAccountId;
      host = acct.imap?.host ?? (acct.oauth?.provider === 'google' ? 'imap.gmail.com' : host);
      port = acct.imap?.port ?? 993;
      username = acct.imap?.username ?? acct.oauth?.email ?? username;
      password = '';
    } else if (acct?.imap) {
      host = acct.imap.host;
      port = acct.imap.port;
      username = acct.imap.username;
      password = acct.imap.password ?? '';
    } else {
      logger.warn({ workflowId: wf.id, systemAccountId }, 'trigger_imap references account without IMAP config');
      return null;
    }
  }
  const isOauth = oauthAccountId !== '';

  const mailbox = typeof node.config.mailbox === 'string' ? node.config.mailbox : 'INBOX';
  const interval = clampNumber(node.config.pollIntervalSec, 15, 86_400, 60) * 1000;
  const filterSubject = typeof node.config.filterSubject === 'string' ? node.config.filterSubject : '';
  const filterFrom = typeof node.config.filterFrom === 'string' ? node.config.filterFrom : '';
  // Allowlist mittenti: lista esplicita di indirizzi autorizzati. Stored
  // by chip-list as comma-separated string. Empty/missing = inactive.
  // Match is case-insensitive on the email LITERAL — no regex.
  const senderAllowlistRaw = node.config.senderAllowlist;
  const senderAllowlist = parseAllowlist(senderAllowlistRaw);
  const filterTo = typeof node.config.filterTo === 'string' ? node.config.filterTo : '';
  const hasAttachment = String(node.config.hasAttachment ?? 'false') === 'true';
  const attachmentMime = typeof node.config.attachmentMime === 'string' ? node.config.attachmentMime : '';
  // When ON, the poll fetches by IMAP search criterion {seen:false} rather
  // than {uid: lastUidSeen+1:*}. Lets the operator re-trigger a workflow
  // simply by marking an old email UNREAD on the webmail UI — no CLI
  // gymnastics required. Stays idempotent via imap_processed_messages.
  const onlyUnseen = String(node.config.onlyUnseen ?? 'false') === 'true';
  const markSeenMode = parseMarkSeen(node.config.markSeen);
  const tlsModeRaw = typeof node.config.tlsMode === 'string' ? node.config.tlsMode : '';
  const tlsMode = tlsModeRaw || (port === 993 ? 'tls' : port === 143 ? 'starttls' : 'tls');
  // Spec fix: gli account OAuth NON hanno password → registra se c'è password O OAuth.
  if (!host || !username || (!password && !isOauth)) return null;

  // OAuth: i token devono esistere ORA per decidere la registrazione (controllo
  // sincrono, niente refresh qui — quello è per-poll). Niente token → non si registra.
  const resolveOAuthTokens = deps.resolveOAuthTokens ?? defaultResolveOAuthTokens;
  if (isOauth && !resolveOAuthTokens(tenantId, oauthAccountId)) {
    logger.warn({ workflowId: wf.id, systemAccountId }, 'trigger_imap OAuth account without usable tokens — re-link via Settings');
    return null;
  }

  const subjectRegex = filterSubject ? safeRegex(filterSubject) : null;
  const fromRegex = filterFrom ? safeRegex(filterFrom) : null;
  const toRegex = filterTo ? safeRegex(filterTo) : null;
  const attachmentMimeRegex = attachmentMime ? safeRegex(attachmentMime) : null;

  const parseMail = deps.parseMail ?? simpleParser;
  const createClient = deps.createClient ?? defaultCreateClient;
  const markSeen = deps.markSeen ?? markSeenWithFreshConnection;

  // Load persistent cursor.
  const sqlite = deps.sqlite ?? (getDatabase().sqlite);
  const stateRow = sqlite.prepare('SELECT last_uid_seen FROM imap_state WHERE workflow_id = ? AND mailbox = ?')
    .get(wf.id, mailbox) as { last_uid_seen: number } | undefined;
  let lastUidSeen = stateRow?.last_uid_seen ?? 0;

  const persistCursor = (newUid: number, err?: string): void => {
    try {
      sqlite.prepare(`
        INSERT INTO imap_state (workflow_id, mailbox, last_uid_seen, last_poll_at, last_error, updated_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(workflow_id, mailbox) DO UPDATE SET
          last_uid_seen = excluded.last_uid_seen,
          last_poll_at = excluded.last_poll_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `).run(wf.id, mailbox, newUid, err ?? null);
    } catch (e) {
      logger.warn({ err: e, workflowId: wf.id }, 'imap_state persist failed (non-fatal)');
    }
  };

  const checkDup = (messageId: string): boolean => {
    try {
      const row = sqlite.prepare('SELECT 1 FROM imap_processed_messages WHERE workflow_id = ? AND message_id = ?')
        .get(wf.id, messageId);
      return Boolean(row);
    } catch {
      return false;
    }
  };

  const recordProcessed = (messageId: string, uid: number): void => {
    try {
      sqlite.prepare('INSERT OR IGNORE INTO imap_processed_messages (workflow_id, message_id, uid) VALUES (?, ?, ?)')
        .run(wf.id, messageId, uid);
    } catch (e) {
      logger.warn({ err: e, workflowId: wf.id }, 'imap_processed_messages insert failed (non-fatal)');
    }
  };

  const breakerName = `imap:${host}:${username}`;
  const breaker = (deps.getBreaker ?? resolveTriggerBreaker)(breakerName);

  // ── Auth per-poll: password classica OPPURE access token XOAUTH2 FRESCO ──
  // Il poller è long-running e l'access token Google scade ~1h → si risolve a
  // OGNI poll (refresh proattivo via needsRefresh/leeway). `forceTokenRefresh`
  // gestisce il caso reattivo: un poll fallito con errore auth (token revocato
  // anzitempo) forza il refresh al poll successivo (spec #4).
  const refreshOAuthToken = deps.refreshOAuthToken ?? defaultRefreshOAuthToken;
  const oauthNeedsRefresh = deps.oauthNeedsRefresh ?? ((exp: Date): boolean => EmailOAuthService.needsRefresh(exp));
  const updateOAuthAccess = deps.updateOAuthAccess ?? defaultUpdateOAuthAccess;
  let forceTokenRefresh = false;
  const resolveAuth = async (): Promise<ImapAuth> => {
    if (!isOauth) return { user: username, pass: password };
    const tokens = resolveOAuthTokens(tenantId, oauthAccountId);
    if (!tokens) throw new Error(`OAuth tokens missing for account ${oauthAccountId} — re-link via Settings`);
    let accessToken = tokens.accessToken;
    if (forceTokenRefresh || oauthNeedsRefresh(tokens.expiresAt)) {
      const refreshed = await refreshOAuthToken(tokens.refreshToken);
      updateOAuthAccess({ tenantId, accountId: oauthAccountId, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
      accessToken = refreshed.accessToken;
      forceTokenRefresh = false;
    }
    return { user: username, accessToken };
  };
  const isAuthError = (e: unknown): boolean =>
    /auth|xoauth|invalid_grant|401|unauthor|credential/i.test(e instanceof Error ? e.message : String(e));

  const poll = (): void => {
    void (async () => {
      try {
        await breaker.execute(async () => {
          const client = createClient({
            host,
            port,
            secure: tlsMode === 'tls',
            ...(tlsMode === 'starttls' ? { disableAutoEnable: false } : {}),
            auth: await resolveAuth(),
          });
          try {
            await client.connect();
            // Diagnostic per-poll counters so operators can see in the
            // log "polled, found N, matched M, dispatched D, filtered F".
            // Without this, a poll that finds 0 matches looks indistinguishable
            // from a poll that never ran. Federico-grade observability.
            const stats = { total: 0, matched: 0, dispatched: 0, filteredSubject: 0, filteredFrom: 0, filteredTo: 0, filteredAttachment: 0, filteredGate: 0, rejectedAllowlist: 0, dedup: 0, staleUid: 0, errors: 0 };
            const lock = await client.getMailboxLock(mailbox);
            try {
              // Two fetch modes:
              //   • DEFAULT (`uid: lastUidSeen+1:*`) — keeps the legacy
              //     "monotonically growing UID cursor" idempotency
              //   • UNSEEN  (search criterion {seen:false}) — fetches every
              //     unread message regardless of UID, so the operator can
              //     re-trigger a workflow by marking a mail UNREAD again
              //     in their webmail UI. Dedup falls to message_id table.
              const rangeStart = (lastUidSeen + 1).toString();
              const fetchRange: unknown = onlyUnseen
                ? await client.search({ seen: false }, { uid: true })
                : { uid: `${rangeStart}:*` };
              // When `search` returns an empty array, ImapFlow's fetch
              // iterator naturally yields nothing — handled below.
              if (onlyUnseen && Array.isArray(fetchRange) && fetchRange.length === 0) {
                // No unread mails — short-circuit the loop entirely.
                // We still log a "poll complete" at the end of the lock block.
              }
              // Fetch full source so mailparser can extract body + attachments.
              // `source: true` returns a Buffer of the entire RFC 822 message.
              //
              // ImapFlow.fetch(range, query, options): the third arg is where
              // `{uid: true}` BELONGS. Putting it in `query` (2nd arg) makes
              // ImapFlow ignore it AND interpret the range as sequence
              // numbers — so `fetch([11], …)` looks for seqnum 11, finds
              // nothing (INBOX with 2 mails has seqnums 1..2), and the
              // watcher silently reports `total=0` even when search returned
              // a valid UNSEEN UID. Federico-grade lost-mail bug. Fixed by
              // moving uid:true to the 3rd argument.
              const fetchQuery = { envelope: true, source: true, flags: true };
              const fetchExtraOpts = onlyUnseen ? { uid: true } : undefined;
              const fetchArg = onlyUnseen
                ? (fetchRange as number[])
                : (fetchRange as { uid: string });
              for await (const message of (
                fetchExtraOpts
                  ? client.fetch(fetchArg, fetchQuery, fetchExtraOpts)
                  : client.fetch(fetchArg, fetchQuery)
              )) {
                stats.total += 1;
                // In UNSEEN mode, ignore the UID cursor — the operator can
                // explicitly re-trigger via "mark as unread", which would
                // re-deliver a UID below the cursor.
                if (!onlyUnseen && message.uid <= lastUidSeen) continue;
                const subjectEnv = message.envelope?.subject ?? '';
                const fromEnv = message.envelope?.from?.[0]?.address ?? '';
                const toEnv = (message.envelope?.to ?? []).map((a) => a.address).filter(Boolean).join(', ');

                // Cheap envelope-level filters first — skip parsing if obviously irrelevant.
                if (subjectRegex && !subjectRegex.test(subjectEnv)) {
                  logger.info({ workflowId: wf.id, uid: message.uid, subject: subjectEnv, filter: filterSubject }, 'IMAP trigger: skipped (subject regex mismatch)');
                  stats.filteredSubject += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid; continue;
                }
                if (fromRegex && !fromRegex.test(fromEnv)) {
                  logger.info({ workflowId: wf.id, uid: message.uid, from: fromEnv, filter: filterFrom }, 'IMAP trigger: skipped (from regex mismatch)');
                  stats.filteredFrom += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid; continue;
                }
                // Allowlist security check — applied AFTER regex (regex is
                // functional filter, allowlist is the hard security gate).
                // Rejection is logged at WARN level so admins can detect
                // probe attempts (someone discovered the inbox & sent mail).
                if (senderAllowlist.length > 0 && !senderAllowlist.includes(fromEnv.toLowerCase())) {
                  logger.warn(
                    { workflowId: wf.id, uid: message.uid, from: fromEnv, subject: subjectEnv, allowlistSize: senderAllowlist.length },
                    'IMAP trigger: sender REJECTED by allowlist',
                  );
                  stats.rejectedAllowlist += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid;
                  continue;
                }
                if (toRegex && !toRegex.test(toEnv)) {
                  logger.info({ workflowId: wf.id, uid: message.uid, to: toEnv, filter: filterTo }, 'IMAP trigger: skipped (to regex mismatch)');
                  stats.filteredTo += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid; continue;
                }

                // Parse full MIME via mailparser.
                if (!message.source) {
                  logger.warn({ workflowId: wf.id, uid: message.uid }, 'IMAP fetch returned no source — skipping');
                  stats.errors += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid;
                  continue;
                }
                const parsed = await parseMail(message.source);

                // Attachments → REF-PRIMARIO: handle BinaryData content-addressed
                // (lo store è sempre presente in produzione). MIME filter early.
                const attachments: ImapAttachment[] = [];
                const attachmentStore = (deps.getStore ?? getBinaryStore)();
                for (const att of parsed.attachments ?? []) {
                  if (attachmentMimeRegex && !attachmentMimeRegex.test(att.contentType)) continue;
                  if (!Buffer.isBuffer(att.content)) continue;
                  attachments.push(await buildImapAttachment(att, attachmentStore));
                }

                // hasAttachment / MIME filter post-parse.
                if (hasAttachment && attachments.length === 0) {
                  logger.info({ workflowId: wf.id, uid: message.uid, subject: subjectEnv, totalAttachments: parsed.attachments?.length ?? 0, mimeFilter: attachmentMime }, 'IMAP trigger: skipped (hasAttachment filter — no matching attachments)');
                  stats.filteredAttachment += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid; continue;
                }

                // messageGate (es. trigger_email_bounce): scarta i non-bounce + arricchisce
                // il payload. Stesso punto/pattern degli altri filtri post-parse.
                const gate = deps.messageGate?.(parsed, message.source.toString('utf-8')) ?? { dispatch: true };
                if (!gate.dispatch) {
                  logger.info({ workflowId: wf.id, uid: message.uid }, 'IMAP trigger: skipped (messageGate)');
                  stats.filteredGate += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid;
                  continue;
                }

                // Dedup by Message-ID. The same UID rarely repeats but
                // Message-ID is the RFC-defined global identifier.
                const messageId = parsed.messageId ?? `uid-${wf.id}-${message.uid.toString()}`;
                if (checkDup(messageId)) {
                  logger.info({ workflowId: wf.id, uid: message.uid, messageId }, 'IMAP trigger: skipped (already processed — dedup)');
                  stats.dedup += 1;
                  if (!onlyUnseen) lastUidSeen = message.uid;
                  continue;
                }
                stats.matched += 1;

                const fromAddr = pickAddress(parsed.from) || fromEnv;
                const toAddrs = collectAddresses(parsed.to);
                const ccAddrs = collectAddresses(parsed.cc);
                const textBody = (parsed.text ?? '').slice(0, MAX_BODY_CHARS);
                const htmlBody = typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_BODY_CHARS) : '';

                const runResult = await deps.dispatchRun({
                  workflowId: wf.id,
                  tenantId,
                  triggerType: 'imap',
                  triggerInput: {
                    uid: message.uid,
                    messageId,
                    subject: parsed.subject ?? subjectEnv,
                    from: fromAddr,
                    to: toAddrs,
                    cc: ccAddrs,
                    date: (parsed.date ?? message.envelope?.date ?? new Date()).toISOString(),
                    text: textBody,
                    html: htmlBody,
                    attachments,
                    attachmentCount: attachments.length,
                    headers: Object.fromEntries(parsed.headers ?? new Map()),
                    ...(gate.extra ?? {}),
                  },
                });

                stats.dispatched += 1;

                // markSeen + dedup + cursor decisions — critical for idempotency.
                // 'on-success' mode: only mark read / record dedup / advance cursor
                // if the run succeeded. If it failed, the email stays UNREAD and
                // outside the dedup cache so the next poll retries it.
                // 'always' mode: same behavior as before (mark and advance always).
                const runSucceeded = runResult.status === 'success' && runResult.errorCount === 0;
                const advance = markSeenMode === 'always' || (markSeenMode === 'on-success' && runSucceeded) || (markSeenMode === 'never' && runSucceeded);
                if (advance) {
                  recordProcessed(messageId, message.uid);
                  if (!onlyUnseen) lastUidSeen = message.uid;
                  persistCursor(lastUidSeen);
                } else {
                  logger.info({ workflowId: wf.id, uid: message.uid, status: runResult.status, errors: runResult.errorCount }, 'IMAP trigger: cursor NOT advanced (run failed, will retry on next poll)');
                }
                const shouldMarkSeen =
                  markSeenMode === 'always' ||
                  (markSeenMode === 'on-success' && runSucceeded);
                if (shouldMarkSeen) {
                  // Don't reuse the poll's IMAP client — it has been idle
                  // for the entire workflow duration (could be 47s+ for WF1
                  // ordini), and IONOS/Gmail commonly drop idle connections
                  // silently. messageFlagsAdd on a dead connection hangs
                  // FOREVER without throwing, blocking the rest of the poll
                  // (logout / "poll complete" log / lock release).
                  // Open a fresh short-lived connection just for the flag.
                  await markSeen({
                    workflowId: wf.id,
                    host,
                    port,
                    tlsMode,
                    username,
                    password,
                    mailbox,
                    uid: message.uid,
                    mode: markSeenMode,
                  });
                } else if (markSeenMode === 'on-success' && !runSucceeded) {
                  logger.info({ workflowId: wf.id, uid: message.uid, status: runResult.status, errors: runResult.errorCount }, 'IMAP trigger: email left UNREAD (run failed, on-success mode)');
                }
              }
            } finally {
              lock.release();
            }
            await client.logout();
            // Update cursor every poll even with 0 messages, so admins
            // can see "last_poll_at" advancing → poller is alive.
            persistCursor(lastUidSeen);
            logger.info(
              { workflowId: wf.id, host, mailbox, lastUidSeen, ...stats },
              `IMAP poll complete · ${stats.total.toString()} fetched · ${stats.dispatched.toString()} dispatched`,
            );
          } catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
          }
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Token OAuth revocato/scaduto anzitempo → forza il refresh al prossimo poll (spec #4).
        if (isOauth && isAuthError(err)) forceTokenRefresh = true;
        persistCursor(lastUidSeen, errMsg);
        logger.warn({ err, workflowId: wf.id, breaker: breakerName }, 'IMAP poll skipped/failed (breaker)');
      }
    })();
  };

  // First poll immediately, then every `interval` ms.
  poll();
  const timer = setInterval(poll, interval);
  logger.info({ workflowId: wf.id, host, mailbox, lastUidSeen }, 'IMAP poller registered (v2: mailparser + persistent cursor)');
  return { workflowId: wf.id, timer, lastUidSeen };
}
