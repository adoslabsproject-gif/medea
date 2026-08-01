/**
 * Test 2026-grade — orchestratore connessione SSH-DB (connect.ts).
 * Dipendenze iniettate (DNS, vault, tunnel-opener): deterministico, no rete.
 * Bug-bounty focalizzato sull'ANTI DNS-REBINDING e sulla risoluzione segreti.
 *
 * @module services/db-remote-ssh/__tests__/connect
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSshDbConfig, SshPolicyError, type SshDbConnectionConfig } from '../policy.js';
import { connectRemoteDbOverSsh, type ConnectDeps } from '../connect.js';
import type { SshTunnel, SshTunnelTransportOptions } from '../tunnel.js';

const FAKE_TUNNEL: SshTunnel = { localPort: 55555, close: () => Promise.resolve() };

function cfg(over: Record<string, unknown> = {}): SshDbConnectionConfig {
  return parseSshDbConfig({
    ssh: {
      host: 'bastion.example.com',
      port: 22,
      user: 'tunnel',
      hostKeyFingerprint: 'SHA256:abcdEFGH1234567890abcdefghIJKLmnopqrstuvwx',
      auth: { method: 'key', privateKeySecretRef: 'vault://ssh/key' },
      ...(over.ssh as object ?? {}),
    },
    db: { engine: 'postgres', host: '127.0.0.1', port: 5432, database: 'app', passwordSecretRef: 'vault://db/pw', ...(over.db as object ?? {}) },
  });
}

function deps(over: Partial<ConnectDeps> = {}): { deps: ConnectDeps; openTunnel: ReturnType<typeof vi.fn>; resolveSecret: ReturnType<typeof vi.fn> } {
  const openTunnel = vi.fn<(o: SshTunnelTransportOptions) => Promise<SshTunnel>>().mockResolvedValue(FAKE_TUNNEL);
  const resolveSecret = vi.fn(async (ref: string) => `RESOLVED(${ref})`);
  const d: ConnectDeps = {
    resolveSecret,
    dnsResolve: async () => ['8.8.8.8'],
    openTunnel,
    ...over,
  };
  return { deps: d, openTunnel, resolveSecret };
}

describe('connectRemoteDbOverSsh — happy path', () => {
  it('hostname → risolve, apre il tunnel verso l\'IP RISOLTO (non l\'hostname) col target DB', async () => {
    const { deps: d, openTunnel } = deps({ dnsResolve: async () => ['8.8.8.8'] });
    const t = await connectRemoteDbOverSsh(cfg(), d);
    expect(t).toBe(FAKE_TUNNEL);
    const opts = openTunnel.mock.calls[0]![0];
    expect(opts.ssh.host).toBe('8.8.8.8'); // IP risolto, NON 'bastion.example.com'
    expect(opts.ssh.hostKeyFingerprint).toContain('SHA256:');
    expect(opts.target).toEqual({ host: '127.0.0.1', port: 5432 });
  });

  it('IP pubblico letterale → niente DNS, tunnel verso quell\'IP', async () => {
    const dnsResolve = vi.fn(async () => ['1.1.1.1']);
    const { deps: d, openTunnel } = deps({ dnsResolve });
    await connectRemoteDbOverSsh(cfg({ ssh: { host: '8.8.8.8' } }), d);
    expect(dnsResolve).not.toHaveBeenCalled();
    expect(openTunnel.mock.calls[0]![0].ssh.host).toBe('8.8.8.8');
  });

  it('auth key: risolve privateKey (+ passphrase se presente)', async () => {
    const { deps: d, openTunnel, resolveSecret } = deps();
    await connectRemoteDbOverSsh(cfg({ ssh: { auth: { method: 'key', privateKeySecretRef: 'k', passphraseSecretRef: 'pp' } } }), d);
    expect(resolveSecret).toHaveBeenCalledWith('k');
    expect(resolveSecret).toHaveBeenCalledWith('pp');
    const auth = openTunnel.mock.calls[0]![0].ssh.auth;
    expect(auth).toEqual({ type: 'key', privateKey: 'RESOLVED(k)', passphrase: 'RESOLVED(pp)' });
  });

  it('auth password: risolve la password', async () => {
    const { deps: d, openTunnel } = deps();
    await connectRemoteDbOverSsh(cfg({ ssh: { auth: { method: 'password', passwordSecretRef: 'pw' } } }), d);
    expect(openTunnel.mock.calls[0]![0].ssh.auth).toEqual({ type: 'password', password: 'RESOLVED(pw)' });
  });
});

describe('🚨 anti DNS-rebinding & SSRF', () => {
  it('hostname che risolve a IP PRIVATO → SshPolicyError, tunnel MAI aperto', async () => {
    const { deps: d, openTunnel } = deps({ dnsResolve: async () => ['10.0.0.5'] });
    await expect(connectRemoteDbOverSsh(cfg(), d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('hostname che risolve a MIX pubblico+privato → rifiutato (basta UN privato)', async () => {
    const { deps: d, openTunnel } = deps({ dnsResolve: async () => ['8.8.8.8', '169.254.169.254'] });
    await expect(connectRemoteDbOverSsh(cfg(), d)).rejects.toThrow(/rebinding|privato|riservato/i);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('hostname che risolve a NESSUN IP → SshPolicyError', async () => {
    const { deps: d, openTunnel } = deps({ dnsResolve: async () => [] });
    await expect(connectRemoteDbOverSsh(cfg(), d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('IP privato letterale → rifiutato dalla policy, niente DNS, niente tunnel', async () => {
    const dnsResolve = vi.fn(async () => ['8.8.8.8']);
    const { deps: d, openTunnel } = deps({ dnsResolve });
    await expect(connectRemoteDbOverSsh(cfg({ ssh: { host: '192.168.1.10' } }), d)).rejects.toThrow(SshPolicyError);
    expect(dnsResolve).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
  });
});

describe('🚨 risoluzione segreti', () => {
  it('segreto non risolvibile (vault null) → CONFIG error, tunnel MAI aperto', async () => {
    const { deps: d, openTunnel } = deps({ resolveSecret: async () => null });
    await expect(connectRemoteDbOverSsh(cfg(), d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('segreto stringa vuota → CONFIG error (no connessione con credenziale vuota)', async () => {
    const { deps: d, openTunnel } = deps({ resolveSecret: async () => '' });
    await expect(connectRemoteDbOverSsh(cfg({ ssh: { auth: { method: 'password', passwordSecretRef: 'pw' } } }), d)).rejects.toThrow(SshPolicyError);
    expect(openTunnel).not.toHaveBeenCalled();
  });
});
