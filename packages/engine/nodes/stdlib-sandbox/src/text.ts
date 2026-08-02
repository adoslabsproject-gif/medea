/**
 * Text helpers — slugify, truncate, escape, normalize.
 *
 * Pure JS. No dipendenze.
 *
 * @module sandbox/text
 */

/**
 * Slugify: NFD-normalize, lowercase, replace non [a-z0-9] with `-`,
 * collapse multiple `-`, trim.
 */
export function slugify(s: string, maxLength = 80): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

/** Truncate con ellipsis preservando whole-word boundary se possibile. */
export function truncate(s: string, maxLength: number, ellipsis = '…'): string {
  if (s.length <= maxLength) return s;
  const cut = maxLength - ellipsis.length;
  if (cut <= 0) return ellipsis.slice(0, maxLength);
  const sub = s.slice(0, cut);
  const lastSpace = sub.lastIndexOf(' ');
  if (lastSpace > cut * 0.7) return `${sub.slice(0, lastSpace)}${ellipsis}`;
  return `${sub}${ellipsis}`;
}

/** Escape HTML entities — anti-XSS safe per innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** Strip HTML tags. Non sanitization full — usa solo per testo plain extract. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Capitalize first letter. */
export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Convert kebab-case / snake_case / spaces → camelCase. */
export function toCamelCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_\s]+(.)?/g, (_: string, c: string | undefined) => (c ? c.toUpperCase() : ''));
}

/** Convert anything → snake_case. */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Convert anything → kebab-case. */
export function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Conta token approssimativi (parole + numeri) — utility per stima cost LLM
 * pre-request senza fetch al tokenizer reale.
 */
export function approxTokenCount(s: string): number {
  const tokens = s.match(/[A-Za-z0-9]+|[^\s]/g);
  return tokens ? tokens.length : 0;
}
