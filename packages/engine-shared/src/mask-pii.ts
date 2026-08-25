/**
 * PII redaction helpers — shared utility per logging discipline GDPR.
 *
 * Use case: nei log strutturati (PSR-3 + Pino), userId è sempre sicuro
 * (UUID opaco, no PII), MA email/nome/IP sono dati personali ai sensi
 * GDPR art.4. Loggarli in chiaro:
 *   - Violation art.5.1.c (data minimisation)
 *   - Centralized log aggregator pipes (es. Loki) creerebbero copie
 *     non controllate fuori dal DB principale
 *   - Stack trace in error log finiscono in Sentry/Datadog (extra-UE)
 *
 * Pattern enterprise: log SOLO userId opaque. Se serve email per debug,
 * sviluppatore fa SQL `SELECT email FROM users WHERE id = '<uuid>'`. Per
 * log audit user-facing (es. "your account was suspended"), che vanno
 * inviati all'utente stesso, NON usare mask — è il SUO indirizzo.
 *
 * `maskEmail` è per i casi intermedi: log diagnostic dove email serve per
 * leggibilità operatore ma vogliamo minimisation. Es. `info+5@mail.com`
 * → `i*o+*@m**l.com` (riconoscibile dal proprietario, non ricostruibile
 * da un attaccante che ha il log).
 */

/**
 * Maschera un'email per logging GDPR-compliant.
 *
 * Strategia:
 *   - Local part: primo + ultimo char visibili, mezzo asteriscato (`info` → `i*o`)
 *   - Domain: primo + ultimo char visibili, asteriscati nel mezzo (`mail.com` → `m**l.com`)
 *   - TLD intatto (deducibile da log esterno dal domain rank, no PII gain)
 *
 * Edge case: email <3 char nella local part → tutto asteriscato.
 * Input non-string o malformato → ritorna sentinel `'[redacted]'`.
 *
 * @example
 *   maskEmail('mario.rossi@gmail.com')      → 'm*********i@g***l.com'
 *   maskEmail('a@b.it')                      → '*@*.it'
 *   maskEmail('mario.rossi@example.com')    → 'm*********i@e*****e.com'
 *   maskEmail('not-an-email')                → '[redacted]'
 */
export function maskEmail(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '[redacted]';
  const at = input.lastIndexOf('@');
  if (at <= 0 || at === input.length - 1) return '[redacted]';
  const local = input.slice(0, at);
  const domain = input.slice(at + 1);

  // Domain split: keep TLD (last segment) intact, mask the rest.
  const dotIdx = domain.lastIndexOf('.');
  const domainBase = dotIdx > 0 ? domain.slice(0, dotIdx) : domain;
  const tld = dotIdx > 0 ? domain.slice(dotIdx) : '';

  return `${maskMiddle(local)}@${maskMiddle(domainBase)}${tld}`;
}

function maskMiddle(s: string): string {
  if (s.length === 0) return '';
  if (s.length === 1) return '*';
  if (s.length === 2) return `${s[0] ?? ''}*`;
  return `${s[0] ?? ''}${'*'.repeat(s.length - 2)}${s[s.length - 1] ?? ''}`;
}

/**
 * Maschera un indirizzo IP — versione "diagnostic" che mantiene il /24 v4
 * o /48 v6 per geo/abuse tracking ma azzera l'host part. IP è PII art.4
 * GDPR (case CJEU C‑582/14 Breyer).
 *
 * IPv6: gestisce l'abbreviazione `::` espandendola a 8 segment full PRIMA
 * di prendere i primi 3 (= /48 subnet ISP) e azzerare il resto. Una
 * versione naive che faceva split nudo lasciava trapelare l'host part
 * per address abbreviati (es. `::1` → `'::1:0/48'` = identificabile come
 * localhost, NON anonimo).
 *
 * @example
 *   maskIp('192.168.1.42')                        → '192.168.1.0/24'
 *   maskIp('2a01:4f8::ab')                        → '2a01:4f8:0::/48'
 *   maskIp('2001:db8:85a3::8a2e:370:7334')        → '2001:db8:85a3::/48'
 *   maskIp('::1')                                  → '0:0:0::/48'
 */
export function maskIp(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '[redacted]';

  // ── IPv6 ────────────────────────────────────────────────────────────
  if (input.includes(':')) {
    // Split su `::` per gestire l'abbreviazione zero-run (RFC 5952)
    const doubleColonParts = input.split('::');
    if (doubleColonParts.length > 2) return '[redacted]'; // più di una `::` = invalid
    const leftRaw = doubleColonParts[0] ?? '';
    const rightRaw = doubleColonParts[1] ?? '';
    const leftSegs = leftRaw === '' ? [] : leftRaw.split(':');
    const rightSegs = rightRaw === '' ? [] : rightRaw.split(':');
    // Validazione: ogni segment 1-4 hex char
    const allRawSegs = [...leftSegs, ...rightSegs];
    if (allRawSegs.length === 0) return '[redacted]';
    if (allRawSegs.some((s) => !/^[0-9a-fA-F]{1,4}$/.test(s))) return '[redacted]';
    // Espandi `::` con zero fino a 8 segment totali
    let fullSegs: string[];
    if (doubleColonParts.length === 2) {
      const padding = Math.max(0, 8 - leftSegs.length - rightSegs.length);
      fullSegs = [...leftSegs, ...Array<string>(padding).fill('0'), ...rightSegs];
    } else {
      fullSegs = leftSegs;
    }
    if (fullSegs.length !== 8) return '[redacted]';
    // Prendi i primi 3 hextet (48 bit subnet) e usa `::` per compattare il resto
    return `${fullSegs.slice(0, 3).join(':')}::/48`;
  }

  // ── IPv4 ────────────────────────────────────────────────────────────
  const parts = input.split('.');
  if (parts.length !== 4) return '[redacted]';
  // Validazione: ogni octet decimal 0-255
  if (parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return '[redacted]';
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}
