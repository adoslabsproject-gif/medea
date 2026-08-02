/**
 * Guardia anti-SSRF per le connessioni DB ESTERNE ("porta-la-tua-connessione").
 *
 * Un utente che inserisce host/url di un DB esterno non deve poter puntare a un
 * IP privato/riservato (10/8, 127/8, 169.254.169.254 metadata, ::1, docker net…)
 * → pivot nella rete interna della piattaforma. Stessa difesa del nodo SSH
 * (db-remote-ssh/connect.ts): IP letterale validato subito; hostname risolto e
 * OGNI IP validato (anti DNS-rebinding).
 *
 * ESENTI: connessioni `managed` (sidecar sulla flowforge-net, host interno per
 * costruzione) ed `embedded` (sqlite/duckdb, nessun host) — non sono input
 * esterno dell'utente.
 *
 * @module services/db-studio/external-host-guard
 */
import { validateIpForFetch, isIP } from '@medea/engine-safe-fetch';
import type { Database } from '@medea/engine-db-studio-core';

export class ExternalHostBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalHostBlockedError';
  }
}

export type DnsResolver = (host: string) => Promise<string[]>;

async function defaultDnsResolve(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/** Estrae l'host da una connessione (hostname diretto o host dell'url). null se assente. */
export function extractConnectionHost(conn: Database['connection']): string | null {
  if (conn.hostname && conn.hostname.trim() !== '') return conn.hostname.trim();
  if (conn.url && conn.url.trim() !== '') {
    try {
      return new URL(conn.url).hostname || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Valida l'host di una connessione ESTERNA. No-op per managed/embedded o senza host.
 * @throws ExternalHostBlockedError se l'host (o un IP risolto) è privato/riservato.
 */
export async function assertExternalHostAllowed(
  conn: Database['connection'],
  deps: { dnsResolve?: DnsResolver } = {},
): Promise<void> {
  if (conn.managed === true || conn.embedded === true) return; // interni → esenti
  // sshTunnel: l'host DB (es. 127.0.0.1 lato bastion) è raggiunto ATTRAVERSO il
  // tunnel → non è un host esterno. L'host SSH è validato da db-remote-ssh
  // (assertSshHostAllowed + anti-rebinding) dentro openDbStudioSshTunnel.
  if (conn.sshTunnel) return;
  const host = extractConnectionHost(conn);
  if (!host) return; // niente host da validare (es. sqlite)

  if (isIP(host) !== 0) {
    const r = validateIpForFetch(host);
    if (!r.ok)
      throw new ExternalHostBlockedError(
        `Host "${host}" è un indirizzo privato/riservato (${r.reason ?? 'BLOCKED'}): bloccato per prevenire accessi alla rete interna.`,
      );
    return;
  }

  const ips = await (deps.dnsResolve ?? defaultDnsResolve)(host);
  if (ips.length === 0)
    throw new ExternalHostBlockedError(`Host "${host}" non risolve ad alcun IP.`);
  for (const ip of ips) {
    const r = validateIpForFetch(ip);
    if (!r.ok)
      throw new ExternalHostBlockedError(
        `Host "${host}" risolve a un IP privato/riservato (${ip}): bloccato (anti DNS-rebinding).`,
      );
  }
}
