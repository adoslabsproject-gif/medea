/**
 * Transport SSH reale — apre un tunnel `local → SSH → DB remoto` (pattern
 * DBeaver) usando `ssh2`. È il layer LIVE: qui ci sono i socket. La sicurezza
 * di alto livello (SSRF host, secret-ref, read-only) vive in `policy.ts` e
 * viene applicata PRIMA dall'orchestratore; questo modulo riceve già host/IP
 * validato e materiale di credenziali risolto.
 *
 * L'UNICA decisione di sicurezza che resta QUI è quella che DEVE stare nel
 * transport: la VERIFICA DELLA HOST-KEY (anti-MITM). Confronto in tempo
 * costante il fingerprint SHA256 della chiave host presentata col fingerprint
 * atteso (pinned). Mismatch → la connessione fallisce, nessun forward.
 *
 * @module services/db-remote-ssh/tunnel
 */
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from 'ssh2';

export interface SshTunnelTransportOptions {
  ssh: {
    /** host/IP GIÀ risolto e validato dall'orchestratore (anti-rebinding). */
    host: string;
    port: number;
    username: string;
    /** Fingerprint atteso, forma OpenSSH "SHA256:base64" (o solo base64). */
    hostKeyFingerprint: string;
    auth:
      | { type: 'key'; privateKey: string; passphrase?: string }
      | { type: 'password'; password: string };
  };
  /** Il DB raggiungibile DAL server SSH (lato cliente). */
  target: { host: string; port: number };
  readyTimeoutMs?: number;
}

export interface SshTunnel {
  /** Porta locale 127.0.0.1 a cui l'adapter DB si connette. */
  localPort: number;
  close: () => Promise<void>;
}

/** Normalizza un fingerprint: toglie prefisso "SHA256:" e padding base64. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/^sha256:/i, '').replace(/=+$/u, '').trim();
}

/** Fingerprint SHA256 (base64, no padding) della chiave host in wire-format. */
export function hostKeyFingerprintOf(sshWireKey: Buffer): string {
  return createHash('sha256').update(sshWireKey).digest('base64').replace(/=+$/u, '');
}

function fingerprintMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Apre il tunnel. Risolve quando la porta locale è in ascolto e pronta; rigetta
 * su errore SSH, su host-key mismatch o su timeout.
 */
export function openSshTunnel(opts: SshTunnelTransportOptions): Promise<SshTunnel> {
  return new Promise<SshTunnel>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

    conn.on('error', (err) => { finish(() => { conn.end(); reject(err); }); });

    conn.on('ready', () => {
      const server = net.createServer((sock) => {
        conn.forwardOut('127.0.0.1', sock.remotePort ?? 0, opts.target.host, opts.target.port, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          sock.on('error', () => { stream.destroy(); });
          stream.on('error', () => { sock.destroy(); });
        });
      });
      server.on('error', (err) => { finish(() => { conn.end(); reject(err); }); });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const localPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        finish(() => {
          resolve({
            localPort,
            close: () => new Promise<void>((res) => { server.close(() => { conn.end(); res(); }); }),
          });
        });
      });
    });

    const expected = normalizeFingerprint(opts.ssh.hostKeyFingerprint);
    conn.connect({
      host: opts.ssh.host,
      port: opts.ssh.port,
      username: opts.ssh.username,
      readyTimeout: opts.readyTimeoutMs ?? 15_000,
      // VERIFICA HOST-KEY (anti-MITM): confronto col fingerprint pinned.
      hostVerifier: (key: Buffer) => fingerprintMatches(hostKeyFingerprintOf(key), expected),
      ...(opts.ssh.auth.type === 'key'
        ? { privateKey: opts.ssh.auth.privateKey, ...(opts.ssh.auth.passphrase ? { passphrase: opts.ssh.auth.passphrase } : {}) }
        : { password: opts.ssh.auth.password }),
    });
  });
}
