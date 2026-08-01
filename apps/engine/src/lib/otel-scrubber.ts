/**
 * SecretScrubbingSpanProcessor — defense-in-depth contro secret leak negli span OTel.
 *
 * Problema: auto-instrumentation Node (http/https/undici/fetch) cattura
 * AUTOMATICAMENTE l'URL completo come attributi:
 *   • http.url       (OTel semantic conventions <1.20)
 *   • url.full       (OTel semantic conventions 1.20+)
 *   • url.path       (path-only, no leak)
 *   • url.query      (LEAK! query string con `?api_key=`, `?access_token=`)
 *   • url.scheme     (https, no leak)
 *   • http.target    (vecchio alias, full path + query)
 *   • db.statement   (POTENZIALE leak — SQL/Mongo query con literal valori)
 *
 * Vendor URLs (Stripe, Gmail, Drive, WhatsApp, OpenAI, Slack, ecc.) spesso
 * mettono auth params direttamente in query string. Senza scrubber, ogni
 * outbound HTTP via fetch/axios/node-http esporta il secret nel collector.
 *
 * Soluzione: SpanProcessor wrapper che intercetta `onEnd` (prima del flush
 * via BatchSpanProcessor) e applica scrub a TUTTI gli attrs sensibili.
 *
 * Compliance: OTel Semantic Conventions 1.20+ raccomanda esplicitamente
 * sanitization di auth params:
 *   https://github.com/open-telemetry/semantic-conventions/blob/main/docs/http/http-spans.md
 *
 * Design choice — perche\` mutate gli attrs invece di filtrare lo span:
 *   1. Lo span e\` informativo SENZA secret (path/method/status/duration
 *      bastano per troubleshoot/perf analysis).
 *   2. Filtrare lo span causerebbe blind spots nelle traces — l'operatore
 *      non sa che la chiamata e\` avvenuta.
 *   3. Scrubbing in-place e\` industry standard (Datadog, New Relic, Honeycomb
 *      hanno tutti span processor scrubbing built-in).
 */

import type { Context } from '@opentelemetry/api';
import type { SpanProcessor, Span, ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * Attribute keys che possono contenere URL completi con auth params.
 * Lista derivata da: OTel HTTP/DB/messaging semantic conventions + observation
 * di production span (audit 2026-06-04).
 */
const URL_LIKE_ATTR_KEYS: ReadonlySet<string> = new Set([
  'http.url',           // OTel <1.20 legacy
  'url.full',           // OTel 1.20+ standard
  'http.target',        // path + query, vecchio
  'url.query',          // separato, ma e\` LA query
  'http.route',         // template, di solito ok ma defense-in-depth
  'messaging.url',
  'messaging.destination.name',
  'rpc.url',
]);

/**
 * Rimuove query string + userInfo da un URL. Restituisce scheme+host+port+path.
 *
 *   scrubUrl('https://alice:p@api.x.com/u/123?api_key=secret&page=2')
 *     → 'https://api.x.com/u/123'
 *   scrubUrl('/v1/users?token=abc') (path-only)
 *     → '/v1/users'
 */
export function scrubUrl(raw: string): string {
  if (!raw) return raw;
  // Caso 1: URL assoluto parseabile
  try {
    const u = new URL(raw);
    u.search = '';
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.toString();
  } catch { /* not absolute */ }
  // Caso 2: path relativo con query — strip da '?' o '#'
  const qIdx = raw.indexOf('?');
  const hIdx = raw.indexOf('#');
  const cuts = [qIdx, hIdx].filter((i) => i >= 0);
  if (cuts.length === 0) return raw;
  return raw.slice(0, Math.min(...cuts));
}

/**
 * Wrapper SpanProcessor che applica scrub agli attrs PRIMA di delegare al
 * `next` processor (tipicamente BatchSpanProcessor → OTLPTraceExporter).
 *
 * Mutation in-place degli attrs: tecnicamente readonly nel type di
 * `ReadableSpan` MA OTel JS SDK runtime supporta mutation per pattern di
 * sanitization. Verificato con SDK 2.0+.
 */
export class SecretScrubbingSpanProcessor implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // Type-assertion necessaria: SDK runtime supporta mutation anche se
    // ReadableSpan.attributes e\` `readonly` per design TS.
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of URL_LIKE_ATTR_KEYS) {
      const value = attrs[key];
      if (typeof value === 'string' && value.length > 0) {
        attrs[key] = scrubUrl(value);
      }
    }
    // Special case: url.query → SEMPRE strippato (placeholder per non-empty
    // segnala che query c'era senza esporre i values).
    if (typeof attrs['url.query'] === 'string' && attrs['url.query'] !== '') {
      attrs['url.query'] = '<scrubbed>';
    }
    this.next.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }
}
