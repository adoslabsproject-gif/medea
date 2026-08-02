/**
 * Bug-bounty — trigger-watchers/imap-mark-seen.
 *
 * La funzione nel monolite costruiva `new ImapFlow` inline → NON testabile.
 * Resa injectable, qui pinniamo le invarianti idempotency-critical:
 *   - sequenza esatta connect→lock→messageFlagsAdd(\Seen, uid)→logout;
 *   - argomenti esatti di messageFlagsAdd (uid string, flag, {uid:true});
 *   - `secure` derivato da tlsMode === 'tls';
 *   - errore IMAP → best-effort: lock RILASCIATO, warn loggato, NO throw;
 *   - timeout → reject interno → catch → warn, NO throw;
 *   - non lancia MAI (l'email resta UNREAD, il run è già persistito).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  markSeenWithFreshConnection,
  type ImapMarkSeenClient,
  type ImapConnectOptions,
  type MarkSeenParams,
  type MarkSeenDeps,
} from './imap-mark-seen.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const baseParams: MarkSeenParams = {
  workflowId: 'wf-1',
  host: 'imap.test',
  port: 993,
  tlsMode: 'tls',
  username: 'u',
  password: 'p',
  mailbox: 'INBOX',
  uid: 42,
  mode: 'on-success',
};

interface FakeClientControl {
  calls: string[];
  connect: () => Promise<void>;
  messageFlagsAdd: () => Promise<unknown>;
  logout: () => Promise<void>;
  released: boolean;
}

function makeFakeClient(over: Partial<FakeClientControl> = {}): {
  client: ImapMarkSeenClient;
  ctrl: FakeClientControl;
  seenOpts?: ImapConnectOptions;
} {
  const ctrl: FakeClientControl = {
    calls: [],
    connect: async () => {
      /* noop */
    },
    messageFlagsAdd: async () => ({ ok: true }),
    logout: async () => {
      /* noop */
    },
    released: false,
    ...over,
  };
  const client: ImapMarkSeenClient = {
    connect: async () => {
      ctrl.calls.push('connect');
      await ctrl.connect();
    },
    getMailboxLock: async (mb: string) => {
      ctrl.calls.push(`lock:${mb}`);
      return {
        release: () => {
          ctrl.released = true;
          ctrl.calls.push('release');
        },
      };
    },
    messageFlagsAdd: async (range, flags, opts) => {
      ctrl.calls.push(`flags:${JSON.stringify({ range, flags, opts })}`);
      return ctrl.messageFlagsAdd();
    },
    logout: async () => {
      ctrl.calls.push('logout');
      await ctrl.logout();
    },
  };
  return { client, ctrl };
}

function depsWith(
  client: ImapMarkSeenClient,
  capture?: (o: ImapConnectOptions) => void,
  timeoutMs = 5000,
): MarkSeenDeps {
  return {
    createClient: (opts) => {
      capture?.(opts);
      return client;
    },
    timeoutMs,
  };
}

describe('markSeenWithFreshConnection', () => {
  it('🚨 happy: sequenza connect→lock→flags→logout, args esatti, secure da tlsMode', async () => {
    const { client, ctrl } = makeFakeClient();
    let opts: ImapConnectOptions | undefined;
    await markSeenWithFreshConnection(
      baseParams,
      depsWith(client, (o) => {
        opts = o;
      }),
    );

    expect(ctrl.calls).toEqual([
      'connect',
      'lock:INBOX',
      'flags:{"range":{"uid":"42"},"flags":["\\\\Seen"],"opts":{"uid":true}}',
      'release',
      'logout',
    ]);
    expect(opts).toMatchObject({
      host: 'imap.test',
      port: 993,
      secure: true,
      auth: { user: 'u', pass: 'p' },
    });
  });

  it('tlsMode != "tls" → secure false', async () => {
    const { client } = makeFakeClient();
    let opts: ImapConnectOptions | undefined;
    await markSeenWithFreshConnection(
      { ...baseParams, tlsMode: 'starttls' },
      depsWith(client, (o) => {
        opts = o;
      }),
    );
    expect(opts!.secure).toBe(false);
  });

  it('🚨 errore IMAP su messageFlagsAdd → lock RILASCIATO, warn, NESSUN throw', async () => {
    const { client, ctrl } = makeFakeClient({
      messageFlagsAdd: async () => {
        throw new Error('IMAP boom');
      },
    });
    const { logger } = await import('@/lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    await expect(
      markSeenWithFreshConnection(baseParams, depsWith(client)),
    ).resolves.toBeUndefined();
    expect(ctrl.released).toBe(true); // il finally del lock ha rilasciato anche sull'errore
    expect(warn).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    // best-effort logout DOPO l'errore (il catch chiama logout)
    expect(ctrl.calls.filter((c) => c === 'logout').length).toBeGreaterThanOrEqual(1);
  });

  it('🚨 TIMEOUT: connect appeso + timeoutMs piccolo → warn, NO throw', async () => {
    const { client } = makeFakeClient({
      connect: () =>
        new Promise<void>(() => {
          /* mai */
        }),
    });
    const { logger } = await import('@/lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await expect(
      markSeenWithFreshConnection(baseParams, depsWith(client, undefined, 10)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', uid: 42 }),
      expect.stringContaining('mark \\Seen failed'),
    );
  });

  it('🚨 non lancia MAI: anche se pure il logout di cleanup rigetta', async () => {
    const { client } = makeFakeClient({
      messageFlagsAdd: async () => {
        throw new Error('boom');
      },
      logout: async () => {
        throw new Error('logout also fails');
      },
    });
    vi.spyOn((await import('@/lib/logger.js')).logger, 'warn').mockImplementation(function (
      this: unknown,
    ) {
      return this as never;
    });
    await expect(
      markSeenWithFreshConnection(baseParams, depsWith(client)),
    ).resolves.toBeUndefined();
  });

  it('🚨 successo → logger.info con workflowId/uid/mode', async () => {
    const { client } = makeFakeClient();
    const { logger } = await import('@/lib/logger.js');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    await markSeenWithFreshConnection(baseParams, depsWith(client));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', uid: 42, mode: 'on-success' }),
      expect.stringContaining('marked email as \\Seen'),
    );
  });
});
