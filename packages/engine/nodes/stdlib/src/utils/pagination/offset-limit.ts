/**
 * OffsetLimitStrategy — ?offset=N&limit=L paginazione.
 *
 * Stop quando: response items < pageSize.
 */

import type { PaginationStrategy, PaginationContext, PaginationState } from './strategy.js';
import { pickByPath } from './strategy.js';

export interface OffsetLimitOptions {
  offsetParam?: string;     // default 'offset'
  limitParam?: string;      // default 'limit'
  startOffset?: number;     // default 0
}

export class OffsetLimitStrategy implements PaginationStrategy {
  readonly name = 'offset-limit';
  private readonly offsetParam: string;
  private readonly limitParam: string;
  private readonly startOffset: number;

  constructor(opts: OffsetLimitOptions = {}) {
    this.offsetParam = opts.offsetParam ?? 'offset';
    this.limitParam = opts.limitParam ?? 'limit';
    this.startOffset = opts.startOffset ?? 0;
  }

  nextUrl(ctx: PaginationContext, state: PaginationState): string | null {
    if (state.pageIndex >= ctx.maxPages) return null;
    const offset = this.startOffset + state.pageIndex * ctx.pageSize;
    const url = new URL(ctx.baseUrl);
    url.searchParams.set(this.offsetParam, String(offset));
    url.searchParams.set(this.limitParam, String(ctx.pageSize));
    return url.toString();
  }

  extractItems(response: unknown, itemsField: string | undefined): unknown[] {
    const node = pickByPath(response, itemsField);
    if (Array.isArray(node)) return node;
    return node === undefined ? [response] : [node];
  }

  shouldContinue(ctx: PaginationContext, _state: PaginationState, items: unknown[]): boolean {
    return items.length >= ctx.pageSize;
  }
}
