/**
 * Test 2026-grade — core executor db_remote_ssh_query (deps iniettate, no rete).
 * Bug-bounty: read-only enforced PRIMA del tunnel, lifecycle (close sempre),
 * risoluzione creds DB, isolamento ereditato da connect.ts.
 *
 * @module executors/remote-ssh-db-query.test
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeRemoteSshDbQuery,
  makeVaultResolverFrom,
  type RemoteSshDeps,
  type PgRunner,
} from './remote-ssh-db-query.js';
import { SshPolicyError } from '@/services/db-remote-ssh/policy.js';
import type { SshTunnel, SshTunnelTransportOptions } from '@/services/db-remote-ssh/tunnel.js';

const RAW = {
  ssh: {
    host: '8.8.8.8',
    port: 22,
    user: 'tunnel',
    hostKeyFingerprint: 'SHA256:abcdEFGH1234567890abcdefghIJKLmnopqrstuvwx',
    auth: { method: 'key', privateKeySecretRef: 'vault://ssh/key' },
  },
  db: {
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
    userSecretRef: 'vault://db/user',
    passwordSecretRef: 'vault://db/pw',
  },
};

function deps(over: Partial<RemoteSshDeps> = {}): {
  deps: RemoteSshDeps;
  close: ReturnType<typeof vi.fn>;
  openTunnel: ReturnType<typeof vi.fn>;
  pgRun: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const tunnel: SshTunnel = { localPort: 49999, close };
  const openTunnel = vi
    .fn<(o: SshTunnelTransportOptions) => Promise<SshTunnel>>()
    .mockResolvedValue(tunnel);
  const pgRun = vi.fn<PgRunner>().mockResolvedValue([{ id: 1, name: 'mario' }]);
  const d: RemoteSshDeps = {
    resolveSecret: async (ref: string) => `RES(${ref})`,
    dnsResolve: async () => ['8.8.8.8'],
    openTunnel,
    pgRun,
    ...over,
  };
  return { deps: d, close, openTunnel, pgRun };
}

describe('makeVaultResolverFrom — indurimento secret (revisore 2026-06-14)', () => {
  it('ref vault risolto → ritorna il valore', async () => {
    const r = makeVaultResolverFrom(async () => 'S3CRET');
    expect(await r('vault:db/main#pw')).toBe('S3CRET');
  });

  it("valore NON-vault (letterale/local) → passa così com'è", async () => {
    const r = makeVaultResolverFrom(async () => undefined); // resolve: non è un ref vault
    expect(await r('plain-local-password')).toBe('plain-local-password');
  });

  it('🔒 ref FORMA vault ma non risolvibile (undefined) → THROW, mai usato come letterale', async () => {
    const r = makeVaultResolverFrom(async () => undefined); // malformato → resolve undefined
    await expect(r('vault:typo-malformato')).rejects.toBeInstanceOf(SshPolicyError);
  });

  it('🔒 ref vault valido ma vault giù (null) → THROW (no fallback letterale)', async () => {
    const r = makeVaultResolverFrom(async () => null);
    await expect(r('vault:db/main#pw')).rejects.toBeInstanceOf(SshPolicyError);
  });

  it('case-insensitive: "VAULT:" malformato → comunque throw (no leak letterale)', async () => {
    const r = makeVaultResolverFrom(async () => undefined);
    await expect(r('VAULT:rotto')).rejects.toBeInstanceOf(SshPolicyError);
  });
});

describe('executeRemoteSshDbQuery', () => {
  it('SELECT → apre tunnel, esegue pgRun su 127.0.0.1:localPort con creds DB risolte, chiude', async () => {
    const { deps: d, close, pgRun } = deps();
    const rows = await executeRemoteSshDbQuery(RAW, 'SELECT * FROM clienti', 100, d);
    expect(rows).toEqual([{ id: 1, name: 'mario' }]);
    const [conn, sql, limit] = pgRun.mock.calls[0]!;
    expect(conn).toEqual({
      host: '127.0.0.1',
      port: 49999,
      database: 'app',
      user: 'RES(vault://db/user)',
      password: 'RES(vault://db/pw)',
    });
    expect(sql).toBe('SELECT * FROM clienti');
    expect(limit).toBe(100);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('🚨 query NON read-only → SshPolicyError PRIMA di aprire il tunnel', async () => {
    const { deps: d, openTunnel } = deps();
    await expect(executeRemoteSshDbQuery(RAW, 'DROP TABLE clienti', 100, d)).rejects.toThrow(
      SshPolicyError,
    );
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('🚨 SELECT con DROP nascosta (multi-statement) → rifiutata, tunnel mai aperto', async () => {
    const { deps: d, openTunnel } = deps();
    await expect(
      executeRemoteSshDbQuery(RAW, 'SELECT 1; DROP TABLE clienti', 100, d),
    ).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('lifecycle: se pgRun lancia, il tunnel viene CHIUSO comunque (finally)', async () => {
    const { deps: d, close } = deps({
      pgRun: async () => {
        throw new Error('query boom');
      },
    });
    await expect(executeRemoteSshDbQuery(RAW, 'SELECT 1', 100, d)).rejects.toThrow('query boom');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('🚨 host SSH che risolve a IP privato → bloccato (anti-rebinding via connect), tunnel mai aperto', async () => {
    const { deps: d, openTunnel } = deps({ dnsResolve: async () => ['10.0.0.1'] });
    const cfg = { ...RAW, ssh: { ...RAW.ssh, host: 'bastion.evil.example.com' } };
    await expect(executeRemoteSshDbQuery(cfg, 'SELECT 1', 100, d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('segreto DB non risolvibile → SshPolicyError, tunnel CHIUSO', async () => {
    const { deps: d, close } = deps({
      resolveSecret: async (ref) => (ref.includes('db/pw') ? null : `RES(${ref})`),
    });
    await expect(executeRemoteSshDbQuery(RAW, 'SELECT 1', 100, d)).rejects.toThrow(/Segreto DB/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rowLimit normalizzato (0 → default 1000; oltre 50k → cap)', async () => {
    const { deps: d, pgRun } = deps();
    await executeRemoteSshDbQuery(RAW, 'SELECT 1', 0, d);
    expect(pgRun.mock.calls[0]![2]).toBe(1000);
    await executeRemoteSshDbQuery(RAW, 'SELECT 1', 999_999, d);
    expect(pgRun.mock.calls[1]![2]).toBe(50_000);
  });

  it('config malformato (fingerprint mancante) → SshPolicyError, tunnel mai aperto', async () => {
    const { deps: d, openTunnel } = deps();
    const bad = { ...RAW, ssh: { ...RAW.ssh, hostKeyFingerprint: undefined } };
    await expect(executeRemoteSshDbQuery(bad, 'SELECT 1', 100, d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });
});
