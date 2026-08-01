/**
 * Blocklist di revoca delle sessioni (ff_session) — hardening 2026-06-07.
 *
 * ff_session è un JWT RS256 STATELESS: senza una blocklist, un token resta
 * valido fino alla sua scadenza naturale (exp) anche dopo il logout — un token
 * copiato/rubato prima del logout sarebbe riutilizzabile. Questa blocklist
 * rende la revoca IMMEDIATA: al logout (o a una revoca admin) il token viene
 * inserito qui, e il middleware auth lo rifiuta a ogni request successiva.
 *
 * Storage: tabella locale del DB tenant (un container = un tenant, isolato).
 * Chiave: `jti` del token (UUID, nuovi token) oppure fallback `sub:iat` per i
 * token legacy emessi prima dell'introduzione del jti. `expires_at` = exp del
 * token → cleanup lazy: una volta che il token sarebbe comunque scaduto, la
 * riga non serve più e viene rimossa (la tabella resta piccola e auto-potante).
 */
import type { SessionTokenPayload } from '@flowforge/auth-local';
import { getDatabase } from '@/storage/db.js';
import { recordFailOpen } from '@/lib/fail-open-metrics.js';

type RevocablePayload = Pick<SessionTokenPayload, 'jti' | 'sub' | 'iat' | 'exp'>;

// Margine GC del cutoff per-utente: una volta che TUTTI i token emessi prima
// del cutoff sarebbero scaduti per natura (TTL token 12h, cookie max 7gg), la
// riga non serve più. 8 giorni = margine conservativo oltre il cookie 7gg.
const CUTOFF_GC_MARGIN_SEC = 8 * 86_400;

/** Crea le tabelle se assenti. Idempotente (CREATE IF NOT EXISTS) e cheap. */
function ensureTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS revoked_sessions (
      token_id   TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_session_cutoff (
      user_id        TEXT PRIMARY KEY,
      revoked_before INTEGER NOT NULL,
      updated_at     TEXT NOT NULL
    );
  `);
}

/**
 * Identificatore di revoca di un token: `jti` se presente (nuovi token),
 * altrimenti il fallback `sub:iat` (univoco per sessione) per i token legacy.
 */
export function revocationId(payload: Pick<SessionTokenPayload, 'jti' | 'sub' | 'iat'>): string {
  if (payload.jti) return payload.jti;
  // Difensivo: verifySessionToken non valida lo schema, quindi `iat` potrebbe
  // teoricamente mancare. Non deve MAI crashare il middleware (DoS) → fallback 0.
  const iat = typeof payload.iat === 'number' ? payload.iat : 0;
  return `${payload.sub}:${iat.toString()}`;
}

/**
 * Revoca una sessione (logout / revoca admin). Idempotente — un doppio logout
 * non è un errore. Esegue prima un cleanup lazy delle righe scadute.
 */
export function revokeSession(payload: RevocablePayload): void {
  ensureTable();
  const { sqlite } = getDatabase();
  const nowSec = Math.floor(Date.now() / 1000);
  // Lazy GC: rimuove le revoche di token ormai scaduti per natura propria.
  sqlite.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?').run(nowSec);
  sqlite
    .prepare('INSERT OR IGNORE INTO revoked_sessions (token_id, revoked_at, expires_at) VALUES (?, ?, ?)')
    .run(revocationId(payload), new Date().toISOString(), payload.exp);
}

/**
 * True se la sessione è stata revocata. Chiamata dal middleware auth a ogni
 * request autenticata: lookup su PRIMARY KEY → costo trascurabile su SQLite locale.
 */
export function isSessionRevoked(tokenId: string): boolean {
  try {
    ensureTable();
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT 1 AS hit FROM revoked_sessions WHERE token_id = ? LIMIT 1').get(tokenId);
    return row !== undefined && row !== null;
  } catch (err) {
    // FAIL-OPEN deliberato: la blocklist è un layer di hardening AGGIUNTIVO; il
    // token è comunque firmato e a TTL limitato. Un errore DB transiente non
    // deve negare TUTTE le sessioni (DoS). Metrica + log security per rendere
    // un guasto PERSISTENTE alertabile (vedi lib/fail-open-metrics).
    recordFailOpen('session_revocation.single', err, { tokenId });
    return false;
  }
}

/**
 * Revoca TUTTE le sessioni attive di un utente (admin force-revoke / sessione
 * compromessa). Su token stateless non conosciamo i singoli jti: impostiamo un
 * CUTOFF temporale → ogni token con `iat < cutoff` viene rifiutato. Un re-login
 * successivo (iat ≥ cutoff) funziona normalmente. Cutoff = now+1s così copre
 * tutti i token esistenti al momento della revoca (anche quelli dello stesso secondo).
 */
export function revokeAllUserSessions(userId: string): void {
  ensureTable();
  const { sqlite } = getDatabase();
  const nowSec = Math.floor(Date.now() / 1000);
  // GC lazy dei cutoff ormai inutili (tutti i token pre-cutoff sono scaduti).
  sqlite.prepare('DELETE FROM user_session_cutoff WHERE revoked_before < ?').run(nowSec - CUTOFF_GC_MARGIN_SEC);
  sqlite
    .prepare('INSERT OR REPLACE INTO user_session_cutoff (user_id, revoked_before, updated_at) VALUES (?, ?, ?)')
    .run(userId, nowSec + 1, new Date().toISOString());
}

/**
 * Verdetto completo di revoca per un payload: combina la blocklist del SINGOLO
 * token (logout) e il CUTOFF per-utente (revoca-tutte admin). È quello che il
 * middleware auth deve usare. Fail-open su errore DB (no DoS).
 */
export function isPayloadRevoked(payload: Pick<SessionTokenPayload, 'jti' | 'sub' | 'iat'>): boolean {
  // 1) revoca del singolo token (logout) — riusa isSessionRevoked (fail-open incluso).
  if (isSessionRevoked(revocationId(payload))) return true;
  // 2) revoca-tutte per utente: token emesso PRIMA del cutoff.
  try {
    ensureTable();
    const { sqlite } = getDatabase();
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const cutoff = sqlite.prepare('SELECT revoked_before AS rb FROM user_session_cutoff WHERE user_id = ? LIMIT 1').get(payload.sub) as { rb: number } | undefined;
    return cutoff !== undefined && iat < cutoff.rb;
  } catch (err) {
    // Stesso fail-open deliberato del cutoff per-utente (revoca-tutte admin):
    // strumentato per visibilità di un guasto DB persistente.
    recordFailOpen('session_revocation.cutoff', err, { sub: payload.sub });
    return false;
  }
}
