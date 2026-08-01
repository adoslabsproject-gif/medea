/**
 * trigger-watchers/odoo-transport — transport HTTP per il client Odoo XML-RPC
 * (split 2026-06-12, estratto dal monolite).
 *
 * Vive nel runtime (non nella lib `lib/odoo/xml-rpc-client.ts`) perché la lib
 * dichiara SOLO il contratto del transport (modulo puro): è il runtime che
 * inietta il `fetch` reale, stesso pattern degli executor stdlib.
 *
 * Invarianti preservate dal monolite:
 *   - timeout per-chiamata via AbortController interno;
 *   - un `signal` esterno (es. teardown del poller) propaga l'abort al fetch;
 *   - cleanup deterministico (clearTimeout + removeEventListener) nel `finally`
 *     → nessun timer/listener orfano anche su errore.
 *
 * NB strutturale: il tipo degli argomenti, prima duplicato (interfaccia + impl),
 * è ora un singolo `OdooHttpPostArgs` — niente più drift fra i due.
 */

import { readTextCapped } from '@/lib/capped-response.js';

/** Cap anti-OOM sulla risposta del trigger Odoo (25 MB, come il transport del NODO).
 *  Una query di cambio troppo ampia o un Odoo runaway riempiva la RAM via res.text(). */
const ODOO_TRIGGER_MAX_BYTES = 25 * 1024 * 1024;

export interface OdooHttpPostArgs {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Abort esterno (teardown poller): propaga al fetch sottostante. */
  signal?: AbortSignal;
}

export interface OdooHttpResponse {
  status: number;
  text: string;
}

export interface OdooHttpTransportShim {
  post(args: OdooHttpPostArgs): Promise<OdooHttpResponse>;
}

export function makeOdooHttpTransport(): OdooHttpTransportShim {
  return {
    async post({ url, body, headers, timeoutMs, signal }: OdooHttpPostArgs): Promise<OdooHttpResponse> {
      const init: RequestInit = {
        method: 'POST',
        headers: { ...headers },
        body,
      };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const onOuter = (): void => ctrl.abort();
      if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onOuter, { once: true });
      }
      init.signal = ctrl.signal;
      try {
        const res = await fetch(url, init);
        // Lettura CAPPATA in streaming (anti-OOM): il transport del NODO odoo era
        // stato cappato, questo del TRIGGER no → stesso Odoo, stesso rischio.
        const text = await readTextCapped(res, ODOO_TRIGGER_MAX_BYTES);
        return { status: res.status, text };
      } finally {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onOuter);
      }
    },
  };
}
