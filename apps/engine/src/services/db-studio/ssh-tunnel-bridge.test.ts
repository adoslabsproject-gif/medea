/**
 * Test del bridge SSH-tunnel di DB Studio. Mock di connectRemoteDbOverSsh →
 * cattura il config PARSATO (passa per parseSshDbConfig reale = policy vera):
 * mapping ssh/auth/db corretto, engine fuori-policy → placeholder, fingerprint
 * obbligatorio (policy), resolver no-fallback su ref vault.
 */
import type * as ConnectNS from '@/services/db-remote-ssh/connect.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '@flowforge/db-studio-core';

const connectMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/db-remote-ssh/connect.js', async (orig) => ({
  ...(await orig<typeof ConnectNS>()),
  connectRemoteDbOverSsh: (...a: unknown[]) => connectMock(...a) as unknown,
}));

import { openDbStudioSshTunnel } from './ssh-tunnel-bridge.js';

const FP = 'SHA256:abcdEFGH1234567890abcdefghIJKLmnopqrstuvwx';
function conn(over: Partial<Database['connection']> = {}): Database['connection'] {
  return {
    engine: 'postgres', embedded: false,
    hostname: '127.0.0.1', port: 5432, database: 'nothumanallowed', username: 'flowforge_ro', passwordSecretRef: 'pw',
    sshTunnel: { host: '91.98.131.3', port: 22, user: 'root', privateKeySecretRef: 'KEYDATA', hostKeyFingerprint: FP },
    ...over,
  };
}

beforeEach(() => { connectMock.mockReset().mockResolvedValue({ localPort: 55432, close: vi.fn() }); });

describe('openDbStudioSshTunnel', () => {
  it('mappa ssh+db nel config e ritorna il tunnel (localPort)', async () => {
    const t = await openDbStudioSshTunnel(conn());
    expect(t.localPort).toBe(55432);
    const [cfg, deps] = connectMock.mock.calls[0]!;
    expect(cfg).toMatchObject({
      ssh: { host: '91.98.131.3', port: 22, user: 'root', hostKeyFingerprint: FP, auth: { method: 'key', privateKeySecretRef: 'KEYDATA' } },
      db: { engine: 'postgres', host: '127.0.0.1', port: 5432, database: 'nothumanallowed' },
      readOnly: true,
    });
    expect((deps as { resolveSecret: unknown }).resolveSecret).toBeTypeOf('function');
  });

  it('engine fuori-policy (mongodb) → db.engine placeholder postgres (tunnel TCP-only)', async () => {
    await openDbStudioSshTunnel(conn({ engine: 'mongodb', port: 27017 }));
    expect(connectMock.mock.calls[0]![0]).toMatchObject({ db: { engine: 'postgres', port: 27017 } });
  });

  it('passphrase opzionale inclusa quando presente', async () => {
    await openDbStudioSshTunnel(conn({ sshTunnel: { host: 'h', port: 22, user: 'u', privateKeySecretRef: 'K', hostKeyFingerprint: FP, passphraseSecretRef: 'pp' } }));
    expect((connectMock.mock.calls[0]![0] as { ssh: { auth: { passphraseSecretRef?: string } } }).ssh.auth.passphraseSecretRef).toBe('pp');
  });

  it('🔒 fingerprint mancante → la policy (parseSshDbConfig reale) RIFIUTA', async () => {
    await expect(openDbStudioSshTunnel(conn({ sshTunnel: { host: 'h', port: 22, user: 'u', privateKeySecretRef: 'K', hostKeyFingerprint: '' } })))
      .rejects.toThrow();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('senza sshTunnel → throw', async () => {
    await expect(openDbStudioSshTunnel(conn({ sshTunnel: undefined }))).rejects.toThrow(/sshTunnel/u);
  });
});

describe('resolver segreti (no fallback letterale su ref vault malformato)', () => {
  it('ref vault: non risolvibile → la connect riceve un resolver che throwa', async () => {
    // Cattura il resolver e verificane il comportamento di sicurezza.
    await openDbStudioSshTunnel(conn());
    const resolve = (connectMock.mock.calls[0]![1] as { resolveSecret: (r: string) => Promise<string> }).resolveSecret;
    // valore non-vault → letterale OK
    await expect(resolve('plain-key')).resolves.toBe('plain-key');
    // ref vault malformato → throw (no leak letterale)
    await expect(resolve('vault:rotto')).rejects.toThrow();
  });
});
