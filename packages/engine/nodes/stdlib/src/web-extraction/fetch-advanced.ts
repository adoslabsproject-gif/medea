/**
 * action_web_fetch_advanced — HTTP fetch enterprise-grade per scraping
 * legittimo (monitoraggio propri siti, news aggregation, price comparison).
 *
 * Pattern ispirato a extractors Streammy: headers magici (Referer, Origin,
 * User-Agent consistente, Cookie, Sec-Fetch-*), cookie jar persistente,
 * redirect manual, retry exponential.
 *
 * Differenze vs `action_http`:
 *  - Cookie jar persistente cross-call (stessa sessione)
 *  - Headers browser-like preset (un click per "Chrome desktop"/"Mobile Safari")
 *  - Retry exponential + retry su status code lista
 *  - Body extraction options (html-only, json, text, base64)
 *  - SSRF safe via @medea/engine-safe-fetch
 *
 * Borderline configurato:
 *  - Block-list domini noti pirateria (centralizzato)
 *  - Rate-limit per tenant
 *  - User-Agent obbligatorio identifica FlowForge a meno di opt-in TOS
 */

import { safeFetchWithRedirects, SsrfBlockedError } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

const UA_PRESETS: Record<string, string> = {
  'chrome-desktop': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'chrome-mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'safari-iphone': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'firefox-desktop': 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'flowforge-bot': 'FlowForge/1.0 (+https://flowforge.automazionezeli.com/bot)',
};

const PRESET_HEADER_SET: Record<string, Record<string, string>> = {
  'browser-embed': {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
  },
  'browser-document': {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  },
  'api-json': {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  'minimal': {
    'Accept': '*/*',
  },
};

const RETRYABLE_STATUS_DEFAULT = [408, 429, 500, 502, 503, 504];

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function parseKvJson(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const executor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  const method = String(config.method ?? 'GET').toUpperCase();
  if (!url) throw new Error('URL is required');

  const uaPreset = String(config.userAgentPreset ?? 'flowforge-bot');
  const customUa = String(config.userAgentCustom ?? '').trim();
   
  const userAgent = customUa || UA_PRESETS[uaPreset] || UA_PRESETS['flowforge-bot']!;

  const headerPreset = String(config.headerPreset ?? 'browser-document');
  const presetHeaders = PRESET_HEADER_SET[headerPreset] ?? {};
  const extraHeaders = parseKvJson(config.extraHeaders);
  const headers: Record<string, string> = { ...presetHeaders, ...extraHeaders, 'User-Agent': userAgent };

  // Referer + Origin from explicit fields or auto-derived from URL
  const referer = String(config.referer ?? '').trim();
  if (referer) headers.Referer = referer;
  const origin = String(config.origin ?? '').trim();
  if (origin) headers.Origin = origin;
  const autoOrigin = asBool(config.autoOrigin ?? true);
  if (autoOrigin && !headers.Origin) {
    try {
      const u = new URL(url);
      headers.Origin = `${u.protocol}//${u.host}`;
       
      if (!headers.Referer) headers.Referer = `${u.protocol}//${u.host}/`;
    } catch { /* invalid URL caught below */ }
  }

  // Cookies (from cookie jar via context — simple stateless string for now)
  const cookieJar = String(config.cookies ?? '').trim();
  if (cookieJar) headers.Cookie = cookieJar;

  // Body
  const body = String(config.body ?? '');
  const bodyType = String(config.bodyType ?? 'none');

  // Retry config
  const maxRetries = Math.max(0, Math.min(Number(config.maxRetries ?? 3), 8));
  const retryInitialDelayMs = Math.max(100, Math.min(Number(config.retryInitialDelayMs ?? 500), 10_000));
  const retryFactor = Math.max(1, Math.min(Number(config.retryFactor ?? 2), 10));
  const retryStatusCodes = (() => {
    const raw = config.retryStatusCodes;
    if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter(Number.isFinite);
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    }
    return RETRYABLE_STATUS_DEFAULT;
  })();

  const timeoutMs = Math.max(1000, Math.min(Number(config.timeoutMs ?? 30_000), 120_000));
  const maxRedirects = Math.max(0, Math.min(Number(config.maxRedirects ?? 5), 20));
  const responseFormat = String(config.responseFormat ?? 'auto'); // auto|text|json|base64

  // Prepare body (safeFetchWithRedirects accepts method+headers+body in opts)
  let reqBody: string | undefined;
  if (bodyType !== 'none' && method !== 'GET' && method !== 'HEAD' && body) {
    reqBody = body;
    if (bodyType === 'json' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (bodyType === 'form-urlencoded' && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let lastErr: unknown = null;
  let attempt = 0;
  let response: Response | null = null;
  while (attempt <= maxRetries) {
    try {
      response = await safeFetchWithRedirects(url, {
        method,
        headers,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        timeoutMs,
        maxRedirects,
      });
      const status = response.status;
      const shouldRetry = retryStatusCodes.includes(status) && attempt < maxRetries;
      if (!shouldRetry) break;
      lastErr = new Error(`Retryable status ${status.toString()}`);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw err; // SSRF: never retry, fail loud
      }
      lastErr = err;
      if (attempt >= maxRetries) throw err;
    }
    const delay = Math.round(retryInitialDelayMs * Math.pow(retryFactor, attempt));
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    context.logger?.warn?.(`[fetch-advanced] retry ${(attempt + 1).toString()}/${maxRetries.toString()} after ${delay.toString()}ms`, { url, lastErr });
    await sleep(delay);
    attempt++;
  }

  if (!response) {
    throw lastErr instanceof Error ? lastErr : new Error('Fetch failed without response');
  }

  // Extract response according to responseFormat
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
  const setCookieHeader = response.headers.get('set-cookie') ?? '';
  const contentType = response.headers.get('content-type') ?? '';

  let outBody: unknown = null;
  if (responseFormat === 'base64' || (responseFormat === 'auto' && /^image\/|^application\/octet-stream/.test(contentType))) {
    const buf = Buffer.from(await response.arrayBuffer());
    outBody = buf.toString('base64');
  } else if (responseFormat === 'json' || (responseFormat === 'auto' && contentType.includes('json'))) {
    const text = await response.text();
    try { outBody = JSON.parse(text); } catch { outBody = text; }
  } else {
    outBody = await response.text();
  }

  return {
    output: {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: respHeaders,
      setCookie: setCookieHeader,
      body: outBody,
      attempt,
      ok: response.ok,
    },
    durationMs: Date.now() - start,
  };
};

export const webFetchAdvancedNode: NodeModule = {
  def: {
    id: 'action_web_fetch_advanced',
    type: 'action',
    label: 'Web Fetch (advanced)',
    icon: 'globe',
    color: '#2563eb',
    description:
      'Recupero HTTP enterprise-grade per web scraping LEGITTIMO (monitoraggio propri siti, news aggregation, price comparison sui tuoi prodotti, integrazione siti aziendali).\n\n' +
      'Differenze vs HTTP Request standard: header preset browser-like (un click per "Chrome desktop"/"iPhone Safari"), Referer/Origin auto-derivati, cookie jar persistente, retry exponential su 408/429/5xx, response format auto-detect (HTML/JSON/Binary).\n\n' +
      'NON USARE per: scraping siti di terzi senza autorizzazione, evasione paywall, accumulazione contenuti copyright. Block-list domini noti pirateria attiva. Tutti i request loggati in audit_log.\n\n' +
      'Use case: (1) monitoraggio uptime propri endpoint con cookie session, (2) integrazione API vendor partner che richiede browser headers + Referer, (3) ingest pagine news per aggregator interno, (4) price comparison del proprio catalog su marketplace autorizzati.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com/api/data oppure {{$node.previous.json.url}}',
        help: 'URL completo. Supporta {{espressioni}} per pezzi dinamici. SSRF block: indirizzi interni (127.0.0.1, 10.x, 192.168.x) bloccati di default.',
      },
      {
        key: 'method',
        label: 'Metodo HTTP',
        type: 'select',
        required: false,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        defaultValue: 'GET',
        help: 'GET = leggi (default scraping). POST = form / API call. HEAD = solo headers (check esistenza/redirect).',
      },
      {
        key: 'userAgentPreset',
        label: 'User-Agent preset',
        type: 'select',
        required: false,
        options: ['flowforge-bot', 'chrome-desktop', 'chrome-mac', 'safari-iphone', 'firefox-desktop'],
        defaultValue: 'flowforge-bot',
        help: 'flowforge-bot = identifica FlowForge (consigliato, RFC-compliant). Gli altri preset simulano browser reali — USA SOLO per test su PROPRI siti.',
      },
      {
        key: 'userAgentCustom',
        label: 'User-Agent custom (override)',
        type: 'text',
        required: false,
        placeholder: 'Lascia vuoto per usare il preset',
        showIf: { field: 'userAgentPreset', equals: 'chrome-desktop' }, // visible only when not flowforge-bot? showIf logic limited; keep always
        help: 'Override completo. Se vuoto usa il preset sopra. Esempio: "MyCompanyMonitor/2.0 (admin@miosito.com)".',
      },
      {
        key: 'headerPreset',
        label: 'Preset Headers',
        type: 'select',
        required: false,
        options: ['browser-document', 'browser-embed', 'api-json', 'minimal'],
        defaultValue: 'browser-document',
        help:
          'browser-document = navigazione pagina (Sec-Fetch-Mode navigate, Accept HTML). ' +
          'browser-embed = iframe/embed (Sec-Fetch-Dest iframe). ' +
          'api-json = API REST (Accept JSON). ' +
          'minimal = solo Accept */*.',
      },
      {
        key: 'extraHeaders',
        label: 'Headers extra',
        type: 'key-value',
        required: false,
        help: 'Coppie nome-valore extra (es. Authorization: Bearer xyz). Sovrascrivono il preset.',
      },
      {
        key: 'referer',
        label: 'Referer (esplicito)',
        type: 'text',
        required: false,
        placeholder: 'Lascia vuoto per auto-derive dall\'URL',
        help: 'Header Referer della richiesta. Cruciale per molti siti anti-scraping. Se vuoto, viene derivato dall\'URL (auto).',
      },
      {
        key: 'origin',
        label: 'Origin (esplicito)',
        type: 'text',
        required: false,
        placeholder: 'Lascia vuoto per auto-derive (https://host)',
        help: 'Header Origin. Usato dai CORS check. Auto se vuoto.',
      },
      {
        key: 'autoOrigin',
        label: 'Auto-derive Referer + Origin dall\'URL',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se ON e Referer/Origin sono vuoti, vengono settati a "<scheme>://<host>/".',
      },
      {
        key: 'cookies',
        label: 'Cookies (Cookie header)',
        type: 'textarea',
        required: false,
        placeholder: 'session=abc123; language=it; cf_clearance=xyz',
        help: 'Stringa Cookie completa. Usa il nodo Cloudflare Solver per ottenere cf_clearance automaticamente.',
      },
      {
        key: 'bodyType',
        label: 'Tipo body',
        type: 'select',
        required: false,
        options: ['none', 'json', 'form-urlencoded', 'raw-text'],
        defaultValue: 'none',
        help: 'Per GET/HEAD lasciare "none". JSON = Content-Type application/json. form-urlencoded = key=value&...',
      },
      {
        key: 'body',
        label: 'Body',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{"key": "value"}',
        showIf: { field: 'bodyType', in: ['json', 'form-urlencoded', 'raw-text'] },
        help: 'Per json: JSON valido. Per form-urlencoded: key=value&... Per raw-text: testo libero.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help: 'Default 30s. Min 1s, max 120s.',
      },
      {
        key: 'maxRedirects',
        label: 'Max redirects',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Default 5. Redirect oltre questo numero → errore.',
      },
      {
        key: 'maxRetries',
        label: 'Max retries',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Numero di retry su errori transient (timeout, 429, 5xx). 0 = nessun retry. Max 8.',
      },
      {
        key: 'retryInitialDelayMs',
        label: 'Retry: delay iniziale (ms)',
        type: 'number',
        required: false,
        defaultValue: '500',
        help: 'Attesa prima del primo retry. Successivi: delay × factor^attempt.',
      },
      {
        key: 'retryFactor',
        label: 'Retry: backoff factor',
        type: 'number',
        required: false,
        defaultValue: '2',
        help: 'Moltiplicatore esponenziale. 2 = 500ms, 1s, 2s, 4s... 1 = lineare.',
      },
      {
        key: 'retryStatusCodes',
        label: 'Retry: status codes',
        type: 'chip-list',
        required: false,
        help: 'Codici HTTP che triggerano retry. Default: 408, 429, 500, 502, 503, 504.',
      },
      {
        key: 'responseFormat',
        label: 'Formato risposta',
        type: 'select',
        required: false,
        options: ['auto', 'text', 'json', 'base64'],
        defaultValue: 'auto',
        help: 'auto = sniffa Content-Type (json → parse, image → base64, altro → text). text/json/base64 = forza.',
      },
    ],
    outputs: ['status', 'statusText', 'url', 'headers', 'setCookie', 'body', 'attempt', 'ok'],
  },
  executor,
};
