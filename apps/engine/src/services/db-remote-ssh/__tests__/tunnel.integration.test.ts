/**
 * Test d'INTEGRAZIONE REALE del transport SSH — niente mock del protocollo.
 *
 * Accende un VERO server SSH in-process (`ssh2.Server` su 127.0.0.1, host-key
 * RSA generata al volo), un echo-server TCP come "DB remoto", apre il tunnel
 * con `openSshTunnel` e verifica che i byte attraversino davvero
 * local → SSH (handshake reale) → forward → echo → ritorno. Più: fingerprint
 * sbagliato → connessione RIFIUTATA (anti-MITM provato sul vero handshake).
 *
 * Deterministico e self-contained: non serve alcun server SSH esterno (es. NHA).
 * Lo STESSO codice gira contro un host reale; per quello c'è il test gated-env
 * (saltato se le var non sono settate) — niente greensmoke.
 *
 * @module services/db-remote-ssh/__tests__/tunnel.integration
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection, type ServerChannel, type TcpipRequestInfo, type AcceptConnection } from 'ssh2';
import { openSshTunnel, hostKeyFingerprintOf, type SshTunnel } from '../tunnel.js';

function listen(server: net.Server | Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

/** Echo-server TCP: rimanda indietro ogni byte (il "DB remoto" del test). */
function startEchoServer(): net.Server {
  return net.createServer((sock) => { sock.pipe(sock); });
}

/** Server SSH in-process che accetta qualsiasi auth e inoltra il direct-tcpip al target richiesto. */
function startSshServer(hostKeyPem: string): Server {
  const server = new Server({ hostKeys: [hostKeyPem] }, (client: Connection) => {
    // Il client del test col fingerprint errato aborta durante il key-exchange:
    // è ATTESO. Catturiamo l'error lato server per non trasformarlo in
    // un'uncaught exception (che falserebbe il runner).
    client.on('error', () => { /* abort atteso / disconnect */ });
    client.on('authentication', (ctx) => { ctx.accept(); });
    client.on('ready', () => {
      client.on('tcpip', (accept: AcceptConnection<ServerChannel>, _reject, info: TcpipRequestInfo) => {
        const channel = accept();
        const upstream = net.connect(info.destPort, info.destIP, () => {
          channel.pipe(upstream).pipe(channel);
        });
        upstream.on('error', () => { channel.end(); });
        channel.on('error', () => { upstream.destroy(); });
      });
    });
  });
  server.on('error', () => { /* errori di accept/handshake del test: ignora */ });
  return server;
}

let tunnel: SshTunnel | null = null;
let sshServer: Server | null = null;
let echoServer: net.Server | null = null;

afterEach(async () => {
  if (tunnel) { await tunnel.close(); tunnel = null; }
  if (sshServer) { sshServer.close(); sshServer = null; }
  if (echoServer) { echoServer.close(); echoServer = null; }
});

function makeHostKey(): { pem: string; fingerprint: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0]! : parsed;
  return { pem: privateKey, fingerprint: hostKeyFingerprintOf(key.getPublicSSH()) };
}

describe('openSshTunnel — integrazione SSH reale (in-process)', () => {
  it('🟢 i byte attraversano il tunnel: local → SSH → forward → echo → ritorno', async () => {
    const hostKey = makeHostKey();
    echoServer = startEchoServer();
    const echoPort = await listen(echoServer);
    sshServer = startSshServer(hostKey.pem);
    const sshPort = await listen(sshServer);

    tunnel = await openSshTunnel({
      ssh: { host: '127.0.0.1', port: sshPort, username: 'tester', hostKeyFingerprint: hostKey.fingerprint, auth: { type: 'password', password: 'whatever' } },
      target: { host: '127.0.0.1', port: echoPort },
      readyTimeoutMs: 10_000,
    });
    expect(tunnel.localPort).toBeGreaterThan(0);

    const echoed = await new Promise<string>((resolve, reject) => {
      const c = net.connect(tunnel!.localPort, '127.0.0.1', () => { c.write('ping-attraverso-il-tunnel'); });
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.length >= 'ping-attraverso-il-tunnel'.length) { c.end(); resolve(buf); }
      });
      c.on('error', reject);
      setTimeout(() => { reject(new Error('timeout dati tunnel')); }, 8000);
    });
    expect(echoed).toBe('ping-attraverso-il-tunnel');
  }, 20_000);

  it('🚨 fingerprint host-key SBAGLIATO → connessione RIFIUTATA (anti-MITM, no tunnel)', async () => {
    const hostKey = makeHostKey();
    echoServer = startEchoServer();
    const echoPort = await listen(echoServer);
    sshServer = startSshServer(hostKey.pem);
    const sshPort = await listen(sshServer);

    await expect(openSshTunnel({
      ssh: {
        host: '127.0.0.1', port: sshPort, username: 'tester',
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // pin errato
        auth: { type: 'password', password: 'whatever' },
      },
      target: { host: '127.0.0.1', port: echoPort },
      readyTimeoutMs: 10_000,
    })).rejects.toThrow();
  }, 20_000);

  it('🚨 host SSH irraggiungibile → rigetta entro il readyTimeout (no hang)', async () => {
    // Porta chiusa: connect fallisce subito (ECONNREFUSED) → reject pulito.
    await expect(openSshTunnel({
      ssh: { host: '127.0.0.1', port: 1, username: 'x', hostKeyFingerprint: 'SHA256:x'.padEnd(20, 'y'), auth: { type: 'password', password: 'x' } },
      target: { host: '127.0.0.1', port: 9 },
      readyTimeoutMs: 3000,
    })).rejects.toThrow();
  }, 10_000);
});
