/**
 * Test E2E REALE del flusso logout → revoca: token JWT VERO (issueSessionToken),
 * DB SQLite in-memory VERO, verifySessionToken VERO. Niente stub della logica:
 * mocchiamo solo le dipendenze di contorno (keys, logger, config). Verifica che
 * dopo POST /auth/logout il token finisca DAVVERO nella blocklist — non solo che
 * gli header siano giusti (quello è coperto altrove). Chiude il green-smoke.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { generateSessionKeyPair, issueSessionToken, verifySessionToken, type KeyMaterial } from '@medea/engine-auth-local';

let db: Database.Database;
let keys: KeyMaterial;

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/auth-keys.js', () => ({ getAuthKeys: () => Promise.resolve(keys) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => ({ NODE_ENV: 'test' }) }));

beforeAll(async () => { keys = await generateSessionKeyPair(); });
beforeEach(() => { db = new Database(':memory:'); });

async function buildApp(): Promise<Hono> {
  const { createAuthRoutes } = await import('./auth.js');
  const app = new Hono();
  app.route('/api/v1', createAuthRoutes());
  return app;
}

describe('POST /auth/logout — revoca EFFETTIVA del token (non solo header)', () => {
  it('dopo il logout, il token è nella blocklist (isSessionRevoked true)', async () => {
    const token = await issueSessionToken({ userId: 'u1', tenantId: 't1', email: 'e@x.it', role: 'owner', privateKeyPem: keys.privateKeyPem });
    const payload = await verifySessionToken(token, keys.publicKeyPem);
    expect(payload?.jti).toBeDefined();

    const app = await buildApp();
    const res = await app.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie: `ff_session=${token}` } });
    expect(res.status).toBe(200);

    const { isPayloadRevoked } = await import('@/services/security/session-revocation.js');
    expect(isPayloadRevoked(payload!)).toBe(true); // il token NON è più utilizzabile
  });

  it('logout senza cookie → 200, nessun crash, nessuna revoca spuria', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    // un token a caso (mai loggato fuori) NON risulta revocato
    const other = await issueSessionToken({ userId: 'u2', tenantId: 't1', email: 'o@x.it', role: 'viewer', privateKeyPem: keys.privateKeyPem });
    const otherPayload = await verifySessionToken(other, keys.publicKeyPem);
    const { isPayloadRevoked } = await import('@/services/security/session-revocation.js');
    expect(isPayloadRevoked(otherPayload!)).toBe(false);
  });

  it('un token DIVERSO non viene revocato dal logout di un altro', async () => {
    const a = await issueSessionToken({ userId: 'uA', tenantId: 't1', email: 'a@x.it', role: 'owner', privateKeyPem: keys.privateKeyPem });
    const b = await issueSessionToken({ userId: 'uB', tenantId: 't1', email: 'b@x.it', role: 'owner', privateKeyPem: keys.privateKeyPem });
    const payloadB = await verifySessionToken(b, keys.publicKeyPem);
    const app = await buildApp();
    await app.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie: `ff_session=${a}` } });
    const { isPayloadRevoked } = await import('@/services/security/session-revocation.js');
    expect(isPayloadRevoked(payloadB!)).toBe(false); // B intatto
  });
});
