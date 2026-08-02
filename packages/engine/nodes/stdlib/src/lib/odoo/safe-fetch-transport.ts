/**
 * `OdooHttpTransport` adapter backed by `@medea/engine-safe-fetch`.
 *
 * Shared by `action_odoo_rpc` + every wrapper node (lookup_partner /
 * create_lead / update_activity / …). Lifting it here avoids drift
 * between the 5+ executors that all need the same per-call signal /
 * timeout / SSRF guard semantics.
 *
 * Pure factory — no side-effects. The returned transport object is
 * stateless; reuse across requests if you want, or build a fresh one
 * per executor invocation (cheaper than maintaining a pool).
 *
 * @module lib/odoo/safe-fetch-transport
 */

import type { OdooHttpTransport } from './xml-rpc-client.js';
import { AbortedError, TimeoutError } from '../../core/node-error.js';
import { safeFetchWithRedirects, assertUrlSafe } from '@medea/engine-safe-fetch';

/** Cap anti-OOM sulla risposta Odoo RPC (25 MB — generoso per query, blocca runaway). */
const ODOO_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * Legge il body come testo con un cap REALE, browser-safe (TextDecoder, niente
 * Buffer). Fix 2026-06-18: la versione precedente faceva `res.text()` + post-check
 * sulla lunghezza → con content-length assente/bugiardo bufferizzava l'INTERO body
 * (anche multi-GB) PRIMA del controllo → OOM. Qui:
 *  1) content-length dichiarato oltre il cap → stop SUBITO (zero byte letti);
 *  2) altrimenti streaming col contatore → abort + cancel al superamento del cap;
 *  3) fallback res.text()+post-check per Response senza stream (mock/test).
 */
async function readOdooTextCapped(res: Response): Promise<string> {
  const overMsg = `Risposta Odoo troppo grande (oltre ${(ODOO_MAX_RESPONSE_BYTES / 1048576).toString()} MB). Restringi la query (domain/limit/fields).`;
  const declaredLen = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > ODOO_MAX_RESPONSE_BYTES) {
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    throw new Error(`Risposta Odoo troppo grande: ${(declaredLen / 1048576).toFixed(1)} MB oltre il limite di ${(ODOO_MAX_RESPONSE_BYTES / 1048576).toString()} MB. Restringi la query (domain/limit/fields).`);
  }
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let out = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) {
        total += value.byteLength;
        if (total > ODOO_MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new Error(overMsg);
        }
        out += decoder.decode(value, { stream: true });
      }
    }
    out += decoder.decode();
    return out;
  }
  const text = await res.text();
  if (text.length > ODOO_MAX_RESPONSE_BYTES) throw new Error(overMsg);
  return text;
}

/**
 * Build an `OdooHttpTransport` that issues `POST` against the upstream
 * Odoo /xmlrpc/2/* endpoint with SSRF guard + redirect handling + signal
 * propagation. The `followRedirects` flag mirrors the `action_odoo_rpc`
 * config — most prod Odoo setups don't redirect, but Cloudflare in front
 * sometimes does.
 */
export function makeSafeFetchOdooTransport(followRedirects: boolean): OdooHttpTransport {
  return {
    async post({ url, body, headers, timeoutMs, signal }) {
      const timeoutCtrl = new AbortController();
      const t = setTimeout(() => { timeoutCtrl.abort(); }, timeoutMs);
      try {
        const aborter = new Promise<never>((_, reject) => {
          if (timeoutCtrl.signal.aborted) { reject(new Error('per_probe_timeout')); return; }
          timeoutCtrl.signal.addEventListener('abort', () => { reject(new Error('per_probe_timeout')); }, { once: true });
          if (signal) {
            if (signal.aborted) { reject(new Error('run_aborted')); return; }
            signal.addEventListener('abort', () => { reject(new Error('run_aborted')); }, { once: true });
          }
        });

        const reqHeaders: Record<string, string> = { ...headers };
        let res: Response;
        if (followRedirects) {
          res = await Promise.race([
            safeFetchWithRedirects(url, { method: 'POST', headers: reqHeaders, body, timeoutMs }),
            aborter,
          ]);
        } else {
          assertUrlSafe(url);
          res = await Promise.race([
            fetch(url, { method: 'POST', headers: reqHeaders, body, redirect: 'manual', signal: timeoutCtrl.signal }),
            aborter,
          ]);
        }
        // Cap anti-OOM REALE (streaming, non post-hoc): vedi readOdooTextCapped.
        const text = await readOdooTextCapped(res);
        return { status: res.status, text };
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        if (timeoutCtrl.signal.aborted) throw new TimeoutError({ url, timeoutMs });
        throw err;
      } finally {
        clearTimeout(t);
      }
    },
  };
}
