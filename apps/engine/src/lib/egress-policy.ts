/**
 * egress-policy — decisione di sicurezza per host INTERNI allowlisted (review nodi).
 *
 * La allowlist host-interni del tenant è gestita dall'OPERATORE in admin (tabella
 * per-workspace) e spinta al container via S2S → `setEgressAllowlist`. NON è
 * configurabile dall'autore del workflow. Persistita in `system_flags` (sopravvive al
 * restart del container) + cache in-memory (la lettura è nel hot-path di OGNI fetch
 * http → niente query SQLite per-call). Env `FLOWFORGE_INTERNAL_HOST_ALLOWLIST` resta
 * come fallback di bootstrap/legacy se il flag DB non è ancora stato scritto.
 *
 * Verso un host in allowlist + allowSelfSigned → dispatcher insecure-TLS (raggiunge l'IP
 * privato E accetta self-signed). Verso host allowlisted senza self-signed → permissivo
 * (raggiunge l'IP privato, TLS verificato). Verso host NON allowlisted (pubblico o IP
 * privato non dichiarato) → SSRF guard attivo + TLS verificato (invariante #201).
 *
 * Fail-CLOSED: se la lettura del flag DB fallisce → allowlist VUOTA → nessun bypass
 * (sicurezza > disponibilità: meglio un workflow che non raggiunge l'host interno che un
 * SSRF/MITM spalancato). Allowlist vuota = feature OFF.
 */

import { parseInternalHostAllowlist, isHostAllowlisted } from '@flowforge/safe-fetch';
import { getInsecureTlsDispatcher, getPermissiveDispatcher } from './secure-dispatcher.js';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

const FLAG_KEY = 'internal_host_allowlist';
let cached: ReadonlySet<string> | undefined;

function allowlist(): ReadonlySet<string> {
  if (cached !== undefined) return cached;
  try {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get(FLAG_KEY) as { value: string } | undefined;
    // Flag DB scritto dall'admin → fonte di verità. Altrimenti fallback env (bootstrap/legacy).
    cached = parseInternalHostAllowlist(row?.value ?? process.env.FLOWFORGE_INTERNAL_HOST_ALLOWLIST);
  } catch (err) {
    // FAIL-CLOSED: errore DB → nessun host fidato → SSRF guard pieno + TLS verificato.
    logger.warn({ err: String(err) }, 'egress-policy: read allowlist failed → fail-closed (nessun bypass)');
    cached = new Set();
  }
  return cached;
}

/**
 * Aggiorna la allowlist host-interni del tenant: PERSISTE in system_flags + aggiorna la
 * cache a caldo (chiamato dal receiver S2S quando l'admin la modifica nel portal). La
 * CSV viene salvata grezza e normalizzata in lettura. Sopravvive al restart del container.
 */
export function setEgressAllowlist(hostsCsv: string): void {
  const { sqlite } = getDatabase();
  sqlite
    .prepare(
      `INSERT INTO system_flags (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(FLAG_KEY, hostsCsv);
  cached = parseInternalHostAllowlist(hostsCsv);
  logger.info({ count: cached.size }, 'egress allowlist updated (push admin)');
}

export function resolveOutboundDispatcher(
  host: string,
  allowSelfSigned: boolean,
): { allowlisted: boolean; dispatcher?: unknown } {
  if (!isHostAllowlisted(host, allowlist())) return { allowlisted: false };
  return { allowlisted: true, dispatcher: allowSelfSigned ? getInsecureTlsDispatcher() : getPermissiveDispatcher() };
}

/** Per i test: resetta la cache in-memory (rilegge dal flag DB / env). */
export function __resetEgressAllowlistForTest(): void {
  cached = undefined;
}
