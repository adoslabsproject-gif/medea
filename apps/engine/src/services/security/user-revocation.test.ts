/**
 * Test REALI (SQLite in-memory) della propagazione revoca identità F3.
 *
 * Coprono: revoca per email, cutoff sessioni end-to-end (integrazione con
 * session-revocation), scrub PII (anonimizzazione + disable), idempotenza,
 * utente inesistente (best-effort), e le invarianti di sicurezza (email
 * anonimizzata non riconducibile, enabled=0 blocca re-attivazione).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
// Manual mock condiviso (__mocks__/logger.ts) — vietato il factory inline (guard).
vi.mock('@/lib/logger.js');

const { revokeWorkspaceUser } = await import('./user-revocation.js');
const { isPayloadRevoked } = await import('./session-revocation.js');

function seedUser(id: string, email: string, opts: { enabled?: number } = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at)
     VALUES (?, 't1', ?, 'Mario Rossi', 'h', 'editor', ?, ?, ?)`,
  ).run(id, email, opts.enabled ?? 1, now, now);
}

function getUser(id: string): { email: string; display_name: string; enabled: number } {
  return db.prepare('SELECT email, display_name, enabled FROM users WHERE id = ?').get(id) as never;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE UNIQUE INDEX users_tenant_email_idx ON users(tenant_id, email);
  `);
});

describe('revokeWorkspaceUser — utente inesistente', () => {
  it('email mai vista → found=false, niente revoca/scrub (best-effort, no throw)', () => {
    const r = revokeWorkspaceUser({ email: 'ghost@acme.it', scrubPii: true });
    expect(r).toEqual({ found: false, sessionsRevoked: false, piiScrubbed: false });
  });
});

describe('revokeWorkspaceUser — revoca sessioni (scrubPii=false)', () => {
  it('revoca le sessioni ma NON tocca la PII', () => {
    seedUser('u-1', 'mario@acme.it');
    const r = revokeWorkspaceUser({ email: 'mario@acme.it' });
    expect(r).toEqual({ found: true, sessionsRevoked: true, piiScrubbed: false });
    const u = getUser('u-1');
    expect(u.email).toBe('mario@acme.it'); // PII intatta
    expect(u.display_name).toBe('Mario Rossi');
    expect(u.enabled).toBe(1); // non disabilitato (revoca sessioni ≠ rimozione)
  });

  it('🚨 END-TO-END: dopo la revoca, un token emesso PRIMA è rifiutato dal cutoff', () => {
    seedUser('u-2', 'lucia@acme.it');
    const oldIat = Math.floor(Date.now() / 1000) - 60; // token vecchio di 1 min
    // Prima della revoca: non revocato.
    expect(isPayloadRevoked({ sub: 'u-2', iat: oldIat })).toBe(false);
    revokeWorkspaceUser({ email: 'lucia@acme.it' });
    // Dopo: il cutoff (now+1) > oldIat → revocato.
    expect(isPayloadRevoked({ sub: 'u-2', iat: oldIat })).toBe(true);
    // Un re-login FUTURO (iat ≥ cutoff) NON è revocato.
    const futureIat = Math.floor(Date.now() / 1000) + 5;
    expect(isPayloadRevoked({ sub: 'u-2', iat: futureIat })).toBe(false);
  });
});

describe('revokeWorkspaceUser — scrub PII (scrubPii=true)', () => {
  it('anonimizza email+display_name, disabilita, revoca sessioni', () => {
    seedUser('u-3', 'privacy@acme.it');
    const r = revokeWorkspaceUser({ email: 'privacy@acme.it', scrubPii: true });
    expect(r).toEqual({ found: true, sessionsRevoked: true, piiScrubbed: true });
    const u = getUser('u-3');
    expect(u.email).toBe('revoked-u-3@anonymized.flowforge');
    expect(u.display_name).toBe('Deleted User');
    expect(u.enabled).toBe(0);
  });

  it('🚨 BUG-BOUNTY: l\'email anonimizzata NON contiene la PII originale', () => {
    seedUser('u-4', 'sensitive.name@acme.it');
    revokeWorkspaceUser({ email: 'sensitive.name@acme.it', scrubPii: true });
    const u = getUser('u-4');
    expect(u.email).not.toContain('sensitive.name');
    expect(u.email).not.toContain('acme.it');
  });

  it('🚨 il cutoff sessioni scatta ANCHE con scrubPii', () => {
    seedUser('u-5', 'both@acme.it');
    const oldIat = Math.floor(Date.now() / 1000) - 60;
    revokeWorkspaceUser({ email: 'both@acme.it', scrubPii: true });
    expect(isPayloadRevoked({ sub: 'u-5', iat: oldIat })).toBe(true);
  });

  it('idempotente: doppia chiamata non lancia e resta anonimizzato', () => {
    seedUser('u-6', 'twice@acme.it');
    revokeWorkspaceUser({ email: 'twice@acme.it', scrubPii: true });
    // Seconda chiamata con la STESSA email originale → ora non la trova più
    // (è stata anonimizzata) → found=false, no crash.
    const r2 = revokeWorkspaceUser({ email: 'twice@acme.it', scrubPii: true });
    expect(r2.found).toBe(false);
    expect(getUser('u-6').email).toBe('revoked-u-6@anonymized.flowforge');
  });
});
