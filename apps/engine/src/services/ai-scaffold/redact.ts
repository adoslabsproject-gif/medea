/**
 * Secret/path redaction utilities for AI Scaffold tool_result payloads.
 *
 * Filosofia: l'agente DESIGNA il workflow ma NON deve mai vedere valori
 * sensibili. I tool_result che torna nel prompt context vengono passati per
 * `redactSensitive` per:
 *   1. Maschera chiavi sensibili (apiKey, password, token, ...) per nome
 *   2. Tronca stringhe lunghe (>2k char) e payload base64-like (>500 char)
 *   3. Strip path assoluti del server (info leak su FS layout)
 *
 * Estratto da ai-scaffold.service.ts in Phase 2 refactor.
 */

// All entries lowercase — comparison usa `.toLowerCase()` sul nome del field,
// quindi mismatch case ('apiKey' camelCase in set vs 'apikey' lowercase check)
// faceva passare il secret senza redaction. Bug fix 2026-06-07.
export const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'password',
  'secret',
  'token',
  'authorization',
  'auth',
  'cookie',
  'session',
  'base64',
  'pw',
  'pwd',
]);

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…redacted: depth limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 500 && /^[A-Za-z0-9+/=_-]+$/.test(value.slice(0, 200))) {
      return (
        value.slice(0, 80) + `… [+${(value.length - 80).toString()} chars redacted (base64-like)]`
      );
    }
    if (value.length > 2000)
      return value.slice(0, 2000) + `… [+${(value.length - 2000).toString()} chars redacted]`;
    // Strip absolute paths that leak server FS layout.
    return value
      .replace(/\/var\/lib\/flowforge\/[^\s]*/g, '/var/lib/flowforge/[redacted]')
      .replace(/\/opt\/flowforge\/[^\s]*/g, '/opt/flowforge/[redacted]');
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactSensitive(v, depth + 1));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
