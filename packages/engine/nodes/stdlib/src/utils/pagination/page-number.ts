/**
 * PageNumberStrategy — ?page=N&limit=L paginazione.
 *
 * Stop quando: response items < pageSize (significa ultima pagina parziale).
 */

import type { PaginationStrategy, PaginationContext, PaginationState } from './strategy.js';
import { pickByPath } from './strategy.js';

export interface PageNumberOptions {
  pageParam?: string;       // default 'page'
  limitParam?: string;      // default 'limit'
  startPage?: number;       // default 1
}

export class PageNumberStrategy implements PaginationStrategy {
  readonly name = 'page-number';
  private readonly pageParam: string;
  private readonly limitParam: string;
  private readonly startPage: number;

  constructor(opts: PageNumberOptions = {}) {
    this.pageParam = opts.pageParam ?? 'page';
    this.limitParam = opts.limitParam ?? 'limit';
    this.startPage = opts.startPage ?? 1;
  }

  nextUrl(ctx: PaginationContext, state: PaginationState): string | null {
    if (state.pageIndex >= ctx.maxPages) return null;
    const url = new URL(ctx.baseUrl);
    url.searchParams.set(this.pageParam, String(this.startPage + state.pageIndex));
    url.searchParams.set(this.limitParam, String(ctx.pageSize));
    return url.toString();
  }

  extractItems(response: unknown, itemsField: string | undefined): unknown[] {
    const node = pickByPath(response, itemsField);
    if (Array.isArray(node)) return node;
    return node === undefined ? [response] : [node];
  }

  shouldContinue(ctx: PaginationContext, _state: PaginationState, items: unknown[]): boolean {
    // Stop quando la pagina ha meno items di pageSize — significa che siamo
    // all'ultima pagina (gli items sono finiti).
    return items.length >= ctx.pageSize;
  }
}
