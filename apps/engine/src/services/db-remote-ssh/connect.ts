/**
 * Orchestratore della connessione a DB esterni via SSH — salda policy +
 * risoluzione DNS anti-rebinding + segreti dal vault + transport.
 *
 * È il punto in cui le decisioni di `policy.ts` diventano azione, PRIMA di
 * aprire qualunque socket:
 *  1. host SSH IP-letterale → SSRF guard (policy). Hostname → risoluzione DNS
 *     e validazione di OGNI IP risolto (validateIpForFetch): se anche UNO è
 *     privato/riservato → rifiuto. Si apre il tunnel verso l'IP RISOLTO (non
 *     l'hostname) così ssh2 non ri-risolve → finestra di DNS-rebinding chiusa.
 *  2. segreti (chiave/passphrase/password) risolti dal vault per-tenant a
 *     partire dai soli *SecretRef del config.
 *  3. apertura tunnel (transport) verso il DB remoto.
 *
 * Dipendenze iniettabili (DNS, secret-resolver, tunnel-opener) → orchestrazione
 * 100% testabile senza rete né vault reale.
 *
 * @module services/db-remote-ssh/connect
 */
import { validateIpForFetch } from '@medea/engine-safe-fetch';
import { SshPolicyError, assertSshHostAllowed, type SshDbConnectionConfig } from './policy.js';
import { openSshTunnel, type SshTunnel, type SshTunnelTransportOptions } from './tunnel.js';

/** Risolve un *SecretRef nel valore in chiaro (wrapper del vault per-tenant). */
export type SecretResolver = (ref: string) => Promise<string | null | undefined>;
/** Risolve un hostname in 0+ indirizzi IP (default: node:dns lookup all). */
export type DnsResolver = (host: string) => Promise<string[]>;
/** Apre il tunnel (default: openSshTunnel). Iniettabile per i test. */
export type TunnelOpener = (opts: SshTunnelTransportOptions) => Promise<SshTunnel>;

export interface ConnectDeps {
  resolveSecret: SecretResolver;
  dnsResolve?: DnsResolver;
  openTunnel?: TunnelOpener;
}

async function defaultDnsResolve(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Determina l'IP SSH a cui connettersi in sicurezza.
 *  - IP-letterale: applica la policy (privati → throw).
 *  - hostname: risolve TUTTI gli IP, li valida tutti; se uno è privato → throw
 *    (anti-rebinding); ritorna il primo IP valido.
 */
async function resolveSafeSshIp(host: string, dnsResolve: DnsResolver): Promise<string> {
  const verdict = assertSshHostAllowed(host); // throw se IP privato letterale
  if (verdict.kind === 'ip-allowed') return host;

  const ips = await dnsResolve(host);
  if (ips.length === 0) {
    throw new SshPolicyError('SSH_HOST_BLOCKED', `Host SSH "${host}" non risolve ad alcun IP.`);
  }
  for (const ip of ips) {
    const res = validateIpForFetch(ip);
    if (!res.ok) {
      throw new SshPolicyError('SSH_HOST_BLOCKED', `Host SSH "${host}" risolve a un IP privato/riservato (${ip}): bloccato (anti DNS-rebinding).`);
    }
  }
  const first = ips[0];
  if (first === undefined) {
    throw new SshPolicyError('SSH_HOST_BLOCKED', `Host SSH "${host}" non risolve ad alcun IP.`);
  }
  return first;
}

async function mustResolveSecret(resolve: SecretResolver, ref: string): Promise<string> {
  const v = await resolve(ref);
  if (v === null || v === undefined || v === '') {
    throw new SshPolicyError('CONFIG', `Segreto non risolvibile dal vault: "${ref}".`);
  }
  return v;
}

/**
 * Apre il tunnel verso il DB remoto applicando tutta la policy di sicurezza.
 * La query resta da eseguire dal chiamante (nodo) usando assertReadOnlyQuery.
 */
export async function connectRemoteDbOverSsh(config: SshDbConnectionConfig, deps: ConnectDeps): Promise<SshTunnel> {
  const dnsResolve = deps.dnsResolve ?? defaultDnsResolve;
  const openTunnel = deps.openTunnel ?? openSshTunnel;

  // 1. host SSH sicuro (SSRF + anti-rebinding).
  const safeHostIp = await resolveSafeSshIp(config.ssh.host, dnsResolve);

  // 2. segreti dal vault (solo i *SecretRef dichiarati nel config).
  const auth = config.ssh.auth.method === 'key'
    ? {
        type: 'key' as const,
        privateKey: await mustResolveSecret(deps.resolveSecret, config.ssh.auth.privateKeySecretRef),
        ...(config.ssh.auth.passphraseSecretRef
          ? { passphrase: await mustResolveSecret(deps.resolveSecret, config.ssh.auth.passphraseSecretRef) }
          : {}),
      }
    : {
        type: 'password' as const,
        password: await mustResolveSecret(deps.resolveSecret, config.ssh.auth.passwordSecretRef),
      };

  // 3. apertura tunnel verso l'IP risolto (NON l'hostname → no rebinding).
  return openTunnel({
    ssh: {
      host: safeHostIp,
      port: config.ssh.port,
      username: config.ssh.user,
      hostKeyFingerprint: config.ssh.hostKeyFingerprint,
      auth,
    },
    target: { host: config.db.host, port: config.db.port },
  });
}
