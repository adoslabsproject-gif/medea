/**
 * CursorStrategy — segue `next_cursor` nella response per richiedere la prossima.
 *
 * Stop quando: cursor nullo / vuoto / response invalida.
 */

import type { PaginationStrategy, PaginationContext, PaginationState } from './strategy.js';
import { pickByPath } from './strategy.js';

export interface CursorOptions {
  cursorParam?: string;       // default 'cursor'
  cursorResponseField?: string; // default 'next_cursor'
}

export class CursorStrategy implements PaginationStrategy {
  readonly name = 'cursor';
  private readonly cursorParam: string;
  private readonly cursorResponseField: string;

  constructor(opts: CursorOptions = {}) {
    this.cursorParam = opts.cursorParam ?? 'cursor';
    this.cursorResponseField = opts.cursorResponseField ?? 'next_cursor';
  }

  nextUrl(ctx: PaginationContext, state: PaginationState): string | null {
    if (state.pageIndex >= ctx.maxPages) return null;
    const url = new URL(ctx.baseUrl);
    if (state.pageIndex === 0) {
      // Prima pagina: niente cursor.
      return url.toString();
    }
    const cursor = pickByPath(state.lastResponse, this.cursorResponseField);
    if (typeof cursor !== 'string' || cursor === '') return null;
    url.searchParams.set(this.cursorParam, cursor);
    return url.toString();
  }

  extractItems(response: unknown, itemsField: string | undefined): unknown[] {
    const node = pickByPath(response, itemsField);
    if (Array.isArray(node)) return node;
    return node === undefined ? [response] : [node];
  }
}
