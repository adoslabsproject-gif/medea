/**
 * paginationWalker — orchestrator generico delle pagination strategy.
 *
 * Ricicla la stessa fetch+aggregate logic per ogni strategy: senza walker,
 * http.ts duplica il loop 4 volte (1 per strategy). Con walker, 4 strategies =
 * 4 classi pure + 1 walker = ~4× meno codice.
 *
 * Il walker NON conosce dettagli HTTP — accetta una `fetchPage(url) → response`
 * callback. Il caller (executor) gestisce il fetch reale (con auth, retry, breaker).
 */

import type { PaginationStrategy, PaginationContext, PaginationState } from './strategy.js';

export interface WalkerOptions {
  strategy: PaginationStrategy;
  ctx: PaginationContext;
  /** itemsField path nella response per estrarre array (es. 'data', 'items'). */
  itemsField?: string;
  /** Fetch real: walker chiama questo per ogni pagina. */
  fetchPage(url: string): Promise<{
    body: unknown;
    headers: Record<string, string>;
    status: number;
  }>;
  /** Hook opzionale per validare URL prima del fetch (anti-SSRF su Link header). */
  validateUrl?(url: string): { ok: boolean; reason?: string };
  /** Abort signal per interrompere il loop. */
  signal?: AbortSignal;
}

export interface WalkerResult {
  /** Items aggregati di tutte le pagine. */
  items: unknown[];
  /** N° pagine effettivamente fetchate. */
  pagesFetched: number;
  /** Status dell'ULTIMA risposta. */
  lastStatus: number;
  /** Headers dell'ULTIMA risposta. */
  lastHeaders: Record<string, string>;
}

export async function paginationWalker(opts: WalkerOptions): Promise<WalkerResult> {
  const items: unknown[] = [];
  const state: PaginationState = { pageIndex: 0 };
  let lastStatus = 0;
  let lastHeaders: Record<string, string> = {};

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
  while (true) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = opts.strategy.nextUrl(opts.ctx, state);
    if (url === null) break;
    if (opts.validateUrl) {
      const v = opts.validateUrl(url);
      if (!v.ok) throw new Error(`Pagination URL bloccato: ${v.reason ?? 'BLOCKED'} (${url})`);
    }
    const res = await opts.fetchPage(url);
    lastStatus = res.status;
    lastHeaders = res.headers;
    state.lastResponse = res.body;
    state.lastResponseHeaders = res.headers;
    if (res.status < 200 || res.status >= 300) break;

    const pageItems = opts.strategy.extractItems(res.body, opts.itemsField);
    // push item-per-item, NON `items.push(...pageItems)`: una pagina con un array enorme
    // come argomenti-spread supera lo stack → RangeError. Loop = O(1) stack, qualsiasi size.
    for (const it of pageItems) items.push(it);

    if (opts.strategy.shouldContinue && !opts.strategy.shouldContinue(opts.ctx, state, pageItems)) break;
    state.pageIndex += 1;
    if (state.pageIndex >= opts.ctx.maxPages) break;
  }

  return { items, pagesFetched: state.pageIndex + (lastStatus > 0 ? 1 : 0), lastStatus, lastHeaders };
}
