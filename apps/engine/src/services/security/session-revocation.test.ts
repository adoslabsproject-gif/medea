/**
 * Test REALI della blocklist di revoca sessioni — DB SQLite in-memory vero
 * (better-sqlite3), niente stub del DB. Coprono round-trip revoca/check, il
 * fallback legacy sub:iat, l'idempotenza, il GC lazy degli scaduti e il
 * comportamento fail-open su DB rotto.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SessionTokenPayload } from '@medea/engine-auth-local';

const m = vi.hoisted(() => ({ recordFailOpen: vi.fn() }));

let db: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
// Il modulo non usa più logger diretto: il fail-open passa da recordFailOpen.
vi.mock('@/lib/fail-open-metrics.js', () => ({ recordFailOpen: m.recordFailOpen }));

const { revokeSession, isSessionRevoked, revocationId, revokeAllUserSessions, isPayloadRevoked } =
  await import('./session-revocation.js');

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

beforeEach(() => {
  db = new Database(':memory:');
  m.recordFailOpen.mockClear();
});

describe('revocationId', () => {
  it('usa jti quando presente (nuovi token)', () => {
    expect(revocationId({ jti: 'abc-123', sub: 'u1', iat: 100 })).toBe('abc-123');
  });
  it('fallback sub:iat per token legacy senza jti', () => {
    expect(revocationId({ sub: 'u1', iat: 100 })).toBe('u1:100');
  });
  it('difensivo: non crasha se iat manca → sub:0', () => {
    expect(
      revocationId({ sub: 'u1' } as unknown as Pick<SessionTokenPayload, 'jti' | 'sub' | 'iat'>),
    ).toBe('u1:0');
  });
});

describe('blocklist revoca/check', () => {
  it('round-trip per jti: prima false, dopo revoke true', () => {
    expect(isSessionRevoked('jti-1')).toBe(false);
    revokeSession({ jti: 'jti-1', sub: 'u1', iat: 100, exp: FUTURE });
    expect(isSessionRevoked('jti-1')).toBe(true);
  });
  it('revoca per token legacy (fallback sub:iat)', () => {
    revokeSession({ sub: 'u9', iat: 555, exp: FUTURE });
    expect(isSessionRevoked('u9:555')).toBe(true);
    expect(isSessionRevoked('u9:999')).toBe(false); // sessione diversa, non revocata
  });
  it('idempotente: doppio logout dello stesso token non lancia', () => {
    revokeSession({ jti: 'j2', sub: 'u', iat: 1, exp: FUTURE });
    expect(() => revokeSession({ jti: 'j2', sub: 'u', iat: 1, exp: FUTURE })).not.toThrow();
    expect(isSessionRevoked('j2')).toBe(true);
  });
  it('revoke di un nuovo token fa GC lazy degli scaduti (no crescita infinita)', () => {
    revokeSession({ jti: 'scaduto', sub: 'u', iat: 1, exp: PAST });
    revokeSession({ jti: 'attivo', sub: 'u', iat: 2, exp: FUTURE }); // il DELETE interno rimuove 'scaduto'
    expect(isSessionRevoked('scaduto')).toBe(false);
    expect(isSessionRevoked('attivo')).toBe(true);
  });
  it('fail-open: se il DB lancia, isSessionRevoked ritorna false (no DoS)', () => {
    const good = db;
    db = {
      prepare: () => {
        throw new Error('db down');
      },
      exec: () => {
        throw new Error('db down');
      },
    } as unknown as Database.Database;
    expect(isSessionRevoked('qualunque')).toBe(false);
    db = good;
  });
  it('il fail-open è STRUMENTATO: recordFailOpen("session_revocation.single") col tokenId', () => {
    const good = db;
    db = {
      prepare: () => {
        throw new Error('db down');
      },
      exec: () => {
        throw new Error('db down');
      },
    } as unknown as Database.Database;
    isSessionRevoked('jti-42');
    expect(m.recordFailOpen).toHaveBeenCalledTimes(1);
    expect(m.recordFailOpen).toHaveBeenCalledWith('session_revocation.single', expect.any(Error), {
      tokenId: 'jti-42',
    });
    db = good;
  });
  it('nel percorso NORMALE (DB sano) recordFailOpen NON è chiamato', () => {
    isSessionRevoked('jti-ok');
    expect(m.recordFailOpen).not.toHaveBeenCalled();
  });
});

describe('revoca-tutte per utente (admin force-revoke / cutoff)', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  it('revokeAllUserSessions: i token EMESSI PRIMA della revoca sono rifiutati', () => {
    const oldToken = { jti: 'tk-old', sub: 'user-A', iat: nowSec - 100, exp: FUTURE };
    expect(isPayloadRevoked(oldToken)).toBe(false);
    revokeAllUserSessions('user-A');
    expect(isPayloadRevoked(oldToken)).toBe(true); // emesso prima del cutoff → fuori
  });
  it('un RE-LOGIN dopo la revoca (iat ≥ cutoff) funziona di nuovo', () => {
    revokeAllUserSessions('user-B');
    const freshToken = { jti: 'tk-new', sub: 'user-B', iat: nowSec + 10, exp: FUTURE };
    expect(isPayloadRevoked(freshToken)).toBe(false); // nuovo login non revocato
  });
  it('il cutoff di un utente NON tocca gli altri utenti', () => {
    revokeAllUserSessions('user-C');
    const otherUser = { jti: 'tk-x', sub: 'user-D', iat: nowSec - 100, exp: FUTURE };
    expect(isPayloadRevoked(otherUser)).toBe(false);
  });
  it('isPayloadRevoked combina blocklist token (logout) + cutoff utente', () => {
    // logout del singolo token
    revokeSession({ jti: 'tk-logout', sub: 'user-E', iat: nowSec, exp: FUTURE });
    expect(isPayloadRevoked({ jti: 'tk-logout', sub: 'user-E', iat: nowSec })).toBe(true);
    // un ALTRO token dello stesso utente NON è revocato finché non si fa revoke-all
    expect(isPayloadRevoked({ jti: 'tk-other', sub: 'user-E', iat: nowSec })).toBe(false);
  });
  it('isPayloadRevoked fail-open su DB rotto', () => {
    const good = db;
    db = {
      prepare: () => {
        throw new Error('down');
      },
      exec: () => {
        throw new Error('down');
      },
    } as unknown as Database.Database;
    expect(isPayloadRevoked({ jti: 'x', sub: 'u', iat: 1 })).toBe(false);
    db = good;
  });
  it('il fail-open del cutoff è STRUMENTATO: recordFailOpen("session_revocation.cutoff") col sub', () => {
    // ensureTable + il primo isSessionRevoked interno passano (blocklist vuota),
    // poi la query del cutoff lancia → deve scattare il fail-open del cutoff.
    let calls = 0;
    const good = db;
    const real = good;
    db = {
      exec: (sql: string) => real.exec(sql),
      prepare: (sql: string) => {
        // Fai fallire SOLO la SELECT del cutoff, non l'INSERT/DELETE né la blocklist.
        if (sql.includes('user_session_cutoff') && sql.includes('SELECT')) {
          calls += 1;
          throw new Error('cutoff read down');
        }
        return real.prepare(sql);
      },
    } as unknown as Database.Database;
    expect(isPayloadRevoked({ jti: 'x', sub: 'user-Z', iat: 1 })).toBe(false);
    expect(calls).toBeGreaterThan(0);
    expect(m.recordFailOpen).toHaveBeenCalledWith('session_revocation.cutoff', expect.any(Error), {
      sub: 'user-Z',
    });
    db = good;
  });
});
