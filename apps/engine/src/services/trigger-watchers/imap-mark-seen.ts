/**
 * trigger-watchers/imap-mark-seen — marca un messaggio IMAP come \Seen su una
 * connessione FRESCA e short-lived (split 2026-06-12, estratto dal monolite).
 *
 * Idempotency-critical: risolve un failure di produzione reale in cui la
 * connessione principale del poll viene droppata in silenzio dal server IMAP
 * dopo un run lungo (47s+) e `messageFlagsAdd` resta appeso per sempre senza
 * lanciare. Strategia: client nuovo, connect→lock→flag→logout, il tutto in
 * `Promise.race` con un timeout; OGNI esito (successo/errore/timeout) è loggato
 * e NON propagato (best-effort: l'email resta UNREAD, il run è già persistito).
 *
 * Elevazione vs monolite (no downgrade): la creazione del client e il timeout
 * sono INIETTABILI (`MarkSeenDeps`), default = produzione reale. Così la
 * funzione — prima impossibile da testare perché costruiva `new ImapFlow`
 * inline — è ora caratterizzabile end-to-end con un client fake.
 */

import { ImapFlow } from 'imapflow';
import { logger } from '@/lib/logger.js';
import type { MarkSeenMode } from './parsing.js';

/** Sottoinsieme di ImapFlow che ci serve — superficie minima, testabile. */
export interface ImapMarkSeenClient {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  messageFlagsAdd(range: { uid: string }, flags: string[], opts: { uid: boolean }): Promise<unknown>;
  logout(): Promise<void>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  socketTimeout: number;
}

export interface MarkSeenParams {
  workflowId: string;
  host: string;
  port: number;
  tlsMode: string;
  username: string;
  password: string;
  mailbox: string;
  uid: number;
  mode: MarkSeenMode;
}

export interface MarkSeenDeps {
  /** Factory del client IMAP. Default: `new ImapFlow`. Override nei test. */
  createClient?: (opts: ImapConnectOptions) => ImapMarkSeenClient;
  /** Timeout dell'intera operazione (ms). Default 10_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const defaultCreateClient = (opts: ImapConnectOptions): ImapMarkSeenClient =>
  new ImapFlow({ ...opts, logger: false });

export async function markSeenWithFreshConnection(
  params: MarkSeenParams,
  deps: MarkSeenDeps = {},
): Promise<void> {
  const { workflowId, host, port, tlsMode, username, password, mailbox, uid, mode } = params;
  const createClient = deps.createClient ?? defaultCreateClient;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const client = createClient({
    host,
    port,
    secure: tlsMode === 'tls',
    auth: { user: username, pass: password },
    socketTimeout: timeoutMs,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`markSeen timeout after ${timeoutMs}ms`)); }, timeoutMs);
  });
  try {
    await Promise.race([
      (async (): Promise<void> => {
        await client.connect();
        const lock = await client.getMailboxLock(mailbox);
        try {
          await client.messageFlagsAdd({ uid: uid.toString() }, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
        await client.logout();
      })(),
      timeoutPromise,
    ]);
    logger.info({ workflowId, uid, mode }, 'IMAP trigger: marked email as \\Seen');
  } catch (e) {
    logger.warn({ err: e, workflowId, uid }, 'mark \\Seen failed (non-fatal — email stays UNREAD, run already persisted)');
    // Best-effort cleanup: don't await — if connect failed, logout will hang too.
    void client.logout().catch(() => { /* swallow */ });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
