/**
 * Placeholder front-end sanitizer for email body HTML.
 *
 * Authoritative sanitization is performed in Rust (`ammonia` crate inside
 * `mail-core`) before the HTML reaches the renderer; this file is a thin
 * defense-in-depth pass for any front-end-only mutations (search highlights,
 * inline tagging) before they are injected into the sandboxed iframe srcdoc.
 *
 * Replaced with a real implementation in Fase 3 (message-reader).
 */

const SCRIPT_RE = /<\s*\/?\s*script\b[^>]*>/gi;
const ON_ATTR_RE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_RE = /\bjavascript:\s*[^"'\s>]+/gi;

export function stripObviousHazards(html: string): string {
  return html.replace(SCRIPT_RE, '').replace(ON_ATTR_RE, '').replace(JS_URL_RE, '');
}
