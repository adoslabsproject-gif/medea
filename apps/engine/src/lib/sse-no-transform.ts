/**
 * SSE streaming wrapper con header CDN-safe + flush immediato.
 *
 * Storia di 3 fix progressivi (vedi memory/cloudflare-brotli-sse-fix.md):
 *  1. `Cache-Control: no-cache, no-transform`: previene Cloudflare Brotli
 *     compression sui frame HTTP/2 (rompeva il protocollo → Chrome aborto).
 *  2. Custom wrapper anziché Hono `streamSSE`: il helper di Hono sovrascrive
 *     il Cache-Control con `no-cache` solo, perdendo `no-transform`.
 *  3. **Questo file**: `ReadableStream` con `highWaterMark: 0` invece di
 *     `TransformStream` di base Hono. Il TransformStream accumulava write
 *     piccoli (hello ~100 byte, ping ~30 byte) nel buffer V8 senza flush →
 *     Chrome riceveva solo i primi chunk grandi (padding 16KB) e poi
 *     timeout/reset. `highWaterMark: 0` forza flush a ogni `enqueue()`.
 *
 * Catena di rete (per riferimento):
 *   Chrome HTTP/2 → Cloudflare → nginx → Traefik → container Hono
 *
 * Tutti i layer passano i byte correttamente (confermato via curl con
 * cookie reale). Il bottleneck era il backend Node.js — risolto qui.
 */

import type { Context } from 'hono';

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
  /** Tempo prima della prossima riconnessione automatica del client (ms). */
  retry?: number;
}

export interface SSEStreamSafe {
  writeSSE(msg: SSEMessage): Promise<void>;
  /**
   * Scrive un commento SSE (riga `:`) ignorato dal client per spec.
   * Utile per (a) padding anti-buffer su Cloudflare HTTP/2 (~16KB first
   * flush) e (b) keepalive periodico che non genera event lato client.
   */
  writeComment(text: string): Promise<void>;
  onAbort(cb: () => void | Promise<void>): void;
  readonly closed: boolean;
}

/**
 * Formatta un messaggio SSE secondo RFC (event: / id: / retry: / data:).
 * Multi-line `data:` sono splittati su `\n` come prevede lo spec.
 */
function formatSSE(msg: SSEMessage): string {
  const lines: string[] = [];
  if (msg.event) lines.push(`event: ${msg.event}`);
  if (msg.id) lines.push(`id: ${msg.id}`);
  if (msg.retry !== undefined) lines.push(`retry: ${msg.retry}`);
  for (const dataLine of msg.data.split('\n')) {
    lines.push(`data: ${dataLine}`);
  }
  lines.push('', ''); // termina con riga vuota + newline finale
  return lines.join('\n');
}

/**
 * Stream SSE con flush immediato per ogni evento.
 *
 * Pattern enterprise 2026:
 *  - `ReadableStream({ highWaterMark: 0 })` → ogni `enqueue()` flusha
 *    immediato al socket TCP, senza accumulare nel buffer V8
 *  - `controller.enqueue(Uint8Array)` bypassa lo SSE helper di Hono
 *  - Header settati QUI, non sovrascritti
 *  - AbortSignal del request → cleanup automatico onAbort
 *
 * @example
 * return streamSSENoTransform(c, async (stream) => {
 *   await stream.writeComment(' '.repeat(16_384)); // CF buffer padding
 *   await stream.writeSSE({ event: 'hello', data: 'world' });
 *   stream.onAbort(() => cleanup());
 *   await new Promise<void>(() => {}); // hold open
 * });
 */
export function streamSSENoTransform(
  c: Context,
  cb: (stream: SSEStreamSafe) => Promise<void>,
  onError?: (e: Error, stream: SSEStreamSafe) => Promise<void> | void,
): Response {
  c.header('Content-Type', 'text/event-stream');
  // CRITICAL: `no-transform` previene Cloudflare Brotli su HTTP/2 SSE.
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('Content-Encoding', 'identity');
  c.header('Transfer-Encoding', 'chunked');
  c.header('X-Accel-Buffering', 'no');

  const encoder = new TextEncoder();
  let closed = false;
  const abortHandlers: (() => void | Promise<void>)[] = [];

  const signal = c.req.raw.signal;

  const readable = new ReadableStream<Uint8Array>(
    {
      async start(controller): Promise<void> {
        const sse: SSEStreamSafe = {
          writeSSE(msg: SSEMessage): Promise<void> {
            if (closed) return Promise.resolve();
            try {
              controller.enqueue(encoder.encode(formatSSE(msg)));
            } catch {
              closed = true;
            }
            return Promise.resolve();
          },
          writeComment(text: string): Promise<void> {
            if (closed) return Promise.resolve();
            const lines = text.split('\n').map((l) => `:${l}`).join('\n');
            try {
              controller.enqueue(encoder.encode(lines + '\n\n'));
            } catch {
              closed = true;
            }
            return Promise.resolve();
          },
          onAbort(fn: () => void | Promise<void>): void {
            abortHandlers.push(fn);
          },
          get closed(): boolean {
            return closed;
          },
        };

        // Detect client abort (browser tab close, navigate away, network).
        const onClientAbort = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          for (const fn of abortHandlers) {
            try {
              await fn();
            } catch {
              /* swallow: cleanup callback errors non devono propagare */
            }
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        signal.addEventListener('abort', () => { void onClientAbort(); }, { once: true });

        try {
          await cb(sse);
        } catch (err) {
          if (onError) {
            try {
              await onError(err as Error, sse);
            } catch {
              /* swallow handler error */
            }
          } else {
            controller.error(err);
            return;
          }
        } finally {
          if (!closed) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            closed = true;
          }
        }
      },
      cancel(): void {
        // Chiamato quando il consumer (Node response) si chiude.
        closed = true;
        for (const fn of abortHandlers) {
          try {
            void fn();
          } catch {
            /* swallow */
          }
        }
      },
    },
    // CRITICAL: highWaterMark 0 = flush immediato a ogni enqueue.
    // Default Web Streams è 1 (chunk) — sufficiente in teoria, ma il
    // Hono `stream()` wrappa con TransformStream che accumulava i
    // chunk piccoli (hello ~100B, ping ~30B) ritardandoli abbastanza
    // da causare ERR_HTTP2_PROTOCOL_ERROR su Chrome. Bypass con
    // c.body(ReadableStream) + hwm 0 elimina il middle buffer.
    { highWaterMark: 0 },
  );

  return c.body(readable, 200);
}
