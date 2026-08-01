/**
 * Test della guardia anti-SSRF per DB esterni. DI dnsResolve → niente DNS reale.
 * Bug-bounty: IP privati letterali bloccati, hostname→IP-privato bloccato
 * (anti-rebinding), managed/embedded esenti, host pubblico ammesso.
 */
import { describe, it, expect, vi } from 'vitest';
import { assertExternalHostAllowed, extractConnectionHost, ExternalHostBlockedError } from './external-host-guard.js';
import type { Database } from '@flowforge/db-studio-core';

const conn = (o: Partial<Database['connection']>): Database['connection'] => ({ engine: 'postgres', embedded: false, ...o });
const resolveTo = (...ips: string[]) => vi.fn().mockResolvedValue(ips);

describe('extractConnectionHost', () => {
  it('da hostname', () => { expect(extractConnectionHost(conn({ hostname: 'db.example.com' }))).toBe('db.example.com'); });
  it('da url', () => { expect(extractConnectionHost(conn({ url: 'postgres://u:p@db.example.com:5432/x' }))).toBe('db.example.com'); });
  it('niente host → null', () => { expect(extractConnectionHost(conn({}))).toBeNull(); });
});

describe('assertExternalHostAllowed — IP letterali', () => {
  it('🔒 IP privato letterale (10.0.0.5) → BLOCCATO', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: '10.0.0.5' }))).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
  it('🔒 metadata 169.254.169.254 → BLOCCATO', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: '169.254.169.254' }))).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
  it('🔒 loopback 127.0.0.1 → BLOCCATO', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: '127.0.0.1' }))).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
  it('IP pubblico (8.8.8.8) → ammesso', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: '8.8.8.8' }))).resolves.toBeUndefined();
  });
});

describe('assertExternalHostAllowed — hostname (DNS-aware anti-rebinding)', () => {
  it('hostname → IP pubblico → ammesso', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: 'db.example.com' }), { dnsResolve: resolveTo('93.184.216.34') })).resolves.toBeUndefined();
  });
  it('🔒 hostname che risolve a IP privato → BLOCCATO (rebinding)', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: 'evil.example.com' }), { dnsResolve: resolveTo('10.1.2.3') })).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
  it('🔒 hostname con UN IP privato fra tanti → BLOCCATO (tutti devono passare)', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: 'mixed.example.com' }), { dnsResolve: resolveTo('8.8.8.8', '192.168.1.1') })).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
  it('🔒 hostname che non risolve → BLOCCATO', async () => {
    await expect(assertExternalHostAllowed(conn({ hostname: 'nx.example.com' }), { dnsResolve: resolveTo() })).rejects.toBeInstanceOf(ExternalHostBlockedError);
  });
});

describe('assertExternalHostAllowed — esenzioni', () => {
  it('managed (sidecar interno) → esente anche se host docker-privato', async () => {
    const dns = resolveTo('172.20.0.9');
    await expect(assertExternalHostAllowed(conn({ managed: true, hostname: 'ff-db-postgres-ws' }), { dnsResolve: dns })).resolves.toBeUndefined();
    expect(dns).not.toHaveBeenCalled();
  });
  it('embedded (sqlite) → esente', async () => {
    await expect(assertExternalHostAllowed(conn({ engine: 'sqlite', embedded: true })) ).resolves.toBeUndefined();
  });
  it('sshTunnel → esente (host DB post-tunnel; l\'host SSH lo valida db-remote-ssh)', async () => {
    const dns = resolveTo('10.0.0.9');
    await expect(assertExternalHostAllowed(
      conn({ hostname: '127.0.0.1', sshTunnel: { host: 'bastion.example.com', port: 22, user: 'root', privateKeySecretRef: 'K', hostKeyFingerprint: 'SHA256:x' } }),
      { dnsResolve: dns },
    )).resolves.toBeUndefined();
    expect(dns).not.toHaveBeenCalled();
  });
  it('senza host → no-op', async () => {
    await expect(assertExternalHostAllowed(conn({}))).resolves.toBeUndefined();
  });
});
