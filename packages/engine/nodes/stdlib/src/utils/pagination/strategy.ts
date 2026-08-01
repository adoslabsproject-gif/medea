/**
 * PaginationStrategy — interface comune per le 4 modalita\` di paginazione
 * API (page-number, offset-limit, cursor, link-header).
 *
 * Pattern Strategy: ogni implementazione produce l'URL della prossima pagina
 * a partire dallo stato corrente + risposta precedente. Il `paginationWalker`
 * (in walker.ts) usa la strategy senza conoscere i dettagli.
 *
 * Aggiungere una 5° strategia = nuova classe, ZERO modifiche al walker.
 */

export interface PaginationContext {
  /** URL iniziale (cosi\` come configurato dal nodo, gia\` interpolato). */
  baseUrl: string;
  /** Numero massimo pagine — safety cap, walker forza stop. */
  maxPages: number;
  /** Items target per pagina (where applicable). */
  pageSize: number;
}

export interface PaginationState {
  /** N° pagine fetchate fino ad ora (parte da 0). */
  pageIndex: number;
  /** L'ultima risposta JSON parsed (per estrarre cursor/items field). */
  lastResponse?: unknown;
  /** L'ultimo Response object (per header Link). */
  lastResponseHeaders?: Record<string, string>;
}

export interface PaginationStrategy {
  /** Nome univoco strategia — utile per logging/telemetry. */
  readonly name: string;

  /**
   * Calcola l'URL della prossima request. Ritorna null se non c'e\` next page
   * (es. cursor null nella risposta, Link header senza rel="next", items < pageSize).
   */
  nextUrl(ctx: PaginationContext, state: PaginationState): string | null;

  /**
   * Estrae gli items dalla response per l'aggregazione. Se la response NON e\`
   * un object con array field, ritorna [response] (1 entry).
   *
   * `itemsField` opzionale specifica il path (es. 'data', 'results.items').
   */
  extractItems(response: unknown, itemsField: string | undefined): unknown[];

  /**
   * Decide se proseguire dopo questa pagina basandosi sul payload (es.
   * page-number stop quando items.length < pageSize). Default: continua finche\`
   * `nextUrl` ritorna non-null.
   *
   * Optional — strategies senza condizioni extra possono omettere.
   */
  shouldContinue?(ctx: PaginationContext, state: PaginationState, items: unknown[]): boolean;
}

/** Helper interno: estrae items con path dot-notation (es. 'data.items'). */
export function pickByPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  if (obj === null || typeof obj !== 'object') return undefined;
  let cur: unknown = obj;
  for (const segment of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}
