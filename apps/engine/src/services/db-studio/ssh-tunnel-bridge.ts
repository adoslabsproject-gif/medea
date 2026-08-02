/**
 * ssh-tunnel-bridge — apre un tunnel SSH per una connessione DB Studio
 * `connection.sshTunnel` (stile DBeaver), RIUSANDO il servizio db-remote-ssh
 * (policy: host-key pinning obbligatorio, SSRF + anti DNS-rebinding sull'host
 * SSH, no exec/shell). Ritorna la porta locale 127.0.0.1 a cui l'adapter DB si
 * connette + la `close` del tunnel (lifecycle gestito da DbStudioService).
 *
 * NB: l'host del DB (connection.hostname, tipicamente 127.0.0.1 lato bastion) è
 * raggiunto ATTRAVERSO il tunnel → non è un host esterno da validare qui (lo è
 * l'host SSH, validato dentro connectRemoteDbOverSsh).
 *
 * @module services/db-studio/ssh-tunnel-bridge
 */
import type { Database } from '@medea/engine-db-studio-core';
import { parseSshDbConfig } from '@/services/db-remote-ssh/policy.js';
import { connectRemoteDbOverSsh, type SecretResolver } from '@/services/db-remote-ssh/connect.js';
import { VaultSecretsService } from '@/services/vault-secrets.service.js';

/** engine ammessi dalla policy db-remote-ssh; gli altri usano 'postgres' come
 *  placeholder (il tunnel inoltra TCP a prescindere dall'engine; l'adapter reale
 *  gestisce il protocollo). */
const POLICY_ENGINES = new Set(['postgres', 'mysql', 'mssql']);

/** Resolver segreti: ref `vault:` deve risolvere (no fallback letterale silente);
 *  valori non-vault restano letterali (chiave SSH incollata in chiaro). */
function makeResolver(vault = new VaultSecretsService()): SecretResolver {
  return async (ref: string) => {
    const v = await vault.resolve(ref);
    if (v === null) throw new Error(`Segreto SSH non risolvibile dal vault: "${ref}".`);
    if (v === undefined) {
      if (ref.trim().toLowerCase().startsWith('vault:'))
        throw new Error(`Riferimento vault malformato: "${ref}".`);
      return ref;
    }
    return v;
  };
}

export interface OpenTunnelDeps {
  resolveSecret?: SecretResolver;
}

/** Apre il tunnel per la connessione DB Studio. @throws se manca sshTunnel o policy KO. */
export async function openDbStudioSshTunnel(
  connection: Database['connection'],
  deps: OpenTunnelDeps = {},
): Promise<{ localPort: number; close: () => Promise<void> }> {
  const ssh = connection.sshTunnel;
  if (!ssh) throw new Error('openDbStudioSshTunnel: connection.sshTunnel assente');

  const engine = POLICY_ENGINES.has(connection.engine) ? connection.engine : 'postgres';
  const config = parseSshDbConfig({
    ssh: {
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      hostKeyFingerprint: ssh.hostKeyFingerprint,
      auth: {
        method: 'key',
        privateKeySecretRef: ssh.privateKeySecretRef,
        ...(ssh.passphraseSecretRef ? { passphraseSecretRef: ssh.passphraseSecretRef } : {}),
      },
    },
    db: {
      engine,
      host:
        connection.hostname && connection.hostname.trim() !== ''
          ? connection.hostname
          : '127.0.0.1',
      port: connection.port ?? 5432,
      database:
        connection.database && connection.database.trim() !== '' ? connection.database : 'db',
    },
    readOnly: true,
  });

  return connectRemoteDbOverSsh(config, { resolveSecret: deps.resolveSecret ?? makeResolver() });
}
