/**
 * Smoke LIVE (gated-env) del tunnel SSH contro un DB Postgres REALE.
 *
 * SALTA se le variabili non sono settate (default in CI / dev): NESSUNA
 * credenziale è committata qui. Per eseguirlo davvero, esporta:
 *   DBSSH_LIVE_SSH_HOST, DBSSH_LIVE_SSH_PORT, DBSSH_LIVE_SSH_USER,
 *   DBSSH_LIVE_SSH_KEY_PATH, DBSSH_LIVE_SSH_FP   (fingerprint SHA256 pinned)
 *   DBSSH_LIVE_DB_HOST, DBSSH_LIVE_DB_PORT, DBSSH_LIVE_DB_NAME,
 *   DBSSH_LIVE_DB_USER, DBSSH_LIVE_DB_PASS
 * e lancia: pnpm --filter @medea/engine-runtime exec vitest run tunnel.live
 *
 * Prova la catena reale: openSshTunnel → Postgres su 127.0.0.1:localPort →
 * query di lettura. Conferma anche che l'utente è read-only (write rifiutata).
 *
 * @module services/db-remote-ssh/__tests__/tunnel.live
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { openSshTunnel, type SshTunnel } from '../tunnel.js';

const E = process.env;
const LIVE = Boolean(
  E.DBSSH_LIVE_SSH_HOST &&
  E.DBSSH_LIVE_SSH_USER &&
  E.DBSSH_LIVE_SSH_KEY_PATH &&
  E.DBSSH_LIVE_SSH_FP &&
  E.DBSSH_LIVE_DB_NAME &&
  E.DBSSH_LIVE_DB_USER &&
  E.DBSSH_LIVE_DB_PASS,
);
const d = LIVE ? describe : describe.skip;

let tunnel: SshTunnel | null = null;

afterAll(async () => {
  if (tunnel) await tunnel.close();
});

d('🌍 LIVE — tunnel SSH → Postgres reale (gated-env)', () => {
  it('apre il tunnel, legge dal DB remoto e conferma il read-only', async () => {
    const privateKey = readFileSync(String(E.DBSSH_LIVE_SSH_KEY_PATH), 'utf8');
    tunnel = await openSshTunnel({
      ssh: {
        host: String(E.DBSSH_LIVE_SSH_HOST),
        port: Number(E.DBSSH_LIVE_SSH_PORT ?? '22'),
        username: String(E.DBSSH_LIVE_SSH_USER),
        hostKeyFingerprint: String(E.DBSSH_LIVE_SSH_FP),
        auth: { type: 'key', privateKey },
      },
      target: {
        host: E.DBSSH_LIVE_DB_HOST ?? '127.0.0.1',
        port: Number(E.DBSSH_LIVE_DB_PORT ?? '5432'),
      },
      readyTimeoutMs: 15_000,
    });
    expect(tunnel.localPort).toBeGreaterThan(0);

    const sql = postgres({
      host: '127.0.0.1',
      port: tunnel.localPort,
      database: String(E.DBSSH_LIVE_DB_NAME),
      username: String(E.DBSSH_LIVE_DB_USER),
      password: String(E.DBSSH_LIVE_DB_PASS),
      ssl: false,
      max: 1,
      connect_timeout: 10,
      idle_timeout: 2,
    });
    try {
      const rows = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
      expect(rows[0]?.n ?? 0).toBeGreaterThan(0);

      // Conferma read-only: una scrittura DEVE essere rifiutata dal DB.
      let writeBlocked = false;
      try {
        await sql`CREATE TABLE _ff_ssh_probe_should_fail (x int)`;
      } catch {
        writeBlocked = true;
      }
      expect(writeBlocked, 'utente DB non read-only? scrittura riuscita!').toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 40_000);
});
