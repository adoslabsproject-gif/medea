/**
 * LinkHeaderStrategy — segue `Link: <url>; rel="next"` (GitHub / Mastodon).
 *
 * SECURITY: re-valida il nextUrl con `validateUrlForFetch` (SSRF guard) prima
 * di tornarlo al walker — il remote server potrebbe iniettare un URL interno.
 * La validation accade dentro la executor (non qui che e\` strategy puro),
 * ma il walker chiama validator passando l'URL.
 */

import type { PaginationStrategy, PaginationContext, PaginationState } from './strategy.js';
import { pickByPath } from './strategy.js';

const LINK_RE = /<([^>]+)>;\s*rel="?next"?/iu;

export class LinkHeaderStrategy implements PaginationStrategy {
  readonly name = 'link-header';

  nextUrl(ctx: PaginationContext, state: PaginationState): string | null {
    if (state.pageIndex >= ctx.maxPages) return null;
    if (state.pageIndex === 0) return ctx.baseUrl;
    const linkHeader = state.lastResponseHeaders?.link ?? state.lastResponseHeaders?.Link ?? '';
    if (!linkHeader) return null;
    const match = LINK_RE.exec(linkHeader);
    return match?.[1] ?? null;
  }

  extractItems(response: unknown, itemsField: string | undefined): unknown[] {
    const node = pickByPath(response, itemsField);
    if (Array.isArray(node)) return node;
    return node === undefined ? [response] : [node];
  }
}
