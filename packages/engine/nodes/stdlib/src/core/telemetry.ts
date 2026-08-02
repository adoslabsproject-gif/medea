/**
 * Telemetry — wrapper OpenTelemetry NO-DEP per executor stdlib.
 *
 * Lo stdlib NON puo\` dipendere da `@opentelemetry/api` (sarebbe forced dep
 * runtime per ogni installazione community). Soluzione: feature-detect a
 * runtime via globalThis: il runtime tenant container inizializza `lib/otel.ts`
 * che a sua volta inietta `globalThis.__flowforge_tracer__` (un riferimento
 * al `trace.getTracer('flowforge')`).
 *
 * Se NESSUN tracer e\` registrato (test, runtime senza OTEL, CLI standalone),
 * `withSpan()` esegue il body direttamente — zero overhead, zero throw.
 *
 * API minima: emette span con name + attributes, marca error.type + message
 * se l'op throwa, chiude lo span on finally. Conforme OTEL semantic conventions
 * per `code.function`, `error.type`, `error.message`.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/general/trace/
 */

export type SpanAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Tracer shape che NON dipende da @opentelemetry/api per runtime.
 * Il runtime app initializzazione fa:
 *
 *   import { trace } from '@opentelemetry/api';
 *   (globalThis as any).__flowforge_tracer__ = trace.getTracer('flowforge-stdlib');
 *
 * Compatibile con `tracer.startActiveSpan(name, fn)` di @opentelemetry/api 1.x.
 */
interface MinimalSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  setStatus(status: { code: 0 | 1 | 2; message?: string }): void;
  recordException(exception: Error): void;
  end(): void;
}

interface MinimalTracer {
  startActiveSpan<T>(name: string, fn: (span: MinimalSpan) => Promise<T> | T): Promise<T> | T;
}

function getTracer(): MinimalTracer | null {
  const t = (globalThis as { __flowforge_tracer__?: MinimalTracer }).__flowforge_tracer__;
  return t ?? null;
}

/**
 * Setter test-only — il runtime app la chiama dopo aver inizializzato OTEL SDK.
 * Esposta separatamente per non hard-codare globalThis assignment dappertutto.
 */
export function registerTracer(tracer: MinimalTracer): void {
  (globalThis as { __flowforge_tracer__?: MinimalTracer }).__flowforge_tracer__ = tracer;
}

export function unregisterTracer(): void {
  delete (globalThis as { __flowforge_tracer__?: MinimalTracer }).__flowforge_tracer__;
}

/**
 * Wrap an async/sync op in a span. If no tracer is registered, executes
 * the body directly with zero overhead.
 *
 *   const result = await withSpan('node.http.request', { 'http.method': 'POST' }, async () => {
 *     return await fetch(url);
 *   });
 *
 * Se il body throwa, lo span registra exception + status=ERROR e RE-THROWS
 * (non altera il comportamento del chiamante).
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  body: () => Promise<T> | T,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) return body();

  return tracer.startActiveSpan(name, async (span) => {
    // Set initial attributes — filter undefined per non spammare gli span.
    const cleanAttrs: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) cleanAttrs[k] = v;
    }
    if (Object.keys(cleanAttrs).length > 0) span.setAttributes(cleanAttrs);

    try {
      const result = await body();
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: 2, message: error.message }); // ERROR
      span.setAttribute('error.type', error.name);
      span.setAttribute('error.message', error.message);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Semantic conventions helper per HTTP nodes — costruisce gli attributes
 * standard OTEL per request HTTP outbound.
 *
 *   const attrs = httpSpanAttrs('GET', 'https://api.x.com/v1/users', { status: 200 });
 *
 * SECURITY: query string + userInfo (user:pass@) sono STRIPPATI prima di
 * mettere l'URL nello span. Vendor URLs spesso contengono `?api_key=...`,
 * `?access_token=...`, `?session=...` — esportarli al collector OTel sarebbe
 * un secret-leak silenzioso. La policy e\` fail-safe by default — il chiamante
 * NON puo\` accidentalmente leakare anche se non lo sa.
 *
 * Compliance: OTel semantic conventions 1.20+ raccomanda esplicitamente di
 * SCRUBBARE auth params (vedi spec `http.url`):
 *   https://github.com/open-telemetry/semantic-conventions/blob/main/docs/http/http-spans.md
 */
export function httpSpanAttrs(
  method: string,
  url: string,
  opts?: { status?: number; userAgent?: string },
): SpanAttributes {
  let host = 'unknown';
  const scrubbedUrl = scrubUrl(url);
  try {
    host = new URL(url).host;
  } catch {
    /* keep unknown */
  }
  return {
    'http.method': method.toUpperCase(),
    'http.url': scrubbedUrl,
    'http.host': host,
    ...(opts?.status !== undefined ? { 'http.status_code': opts.status } : {}),
    ...(opts?.userAgent ? { 'http.user_agent': opts.userAgent } : {}),
  };
}

/**
 * Rimuove query string + userInfo da un URL. Restituisce scheme+host+port+path.
 *
 *   scrubUrl('https://alice:p@api.x.com/u/123?api_key=secret&page=2')
 *     → 'https://api.x.com/u/123'
 *
 * Best-effort: URL malformato → ritorna placeholder (no throw, mai leak input
 * grezzo che potrebbe contenere segreti se la function fosse used in error path).
 */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '<unparseable>';
  }
}
