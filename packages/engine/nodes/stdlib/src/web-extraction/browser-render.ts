/**
 * action_browser_render — render headless di pagine JS-heavy via endpoint
 * BYO (Bring Your Own Browser).
 *
 * Pattern: Playwright/Puppeteer richiede ~300MB di binari Chromium → non
 * sostenibile in stdlib per OGNI container tenant. Soluzione enterprise:
 * il tenant configura un endpoint HTTP che gira Playwright (managed Zeli
 * o self-hosted con Browserless.io/Playwright Server). Il nodo è un wrapper
 * cliente.
 *
 * Endpoint compatibile (request body):
 *   POST {endpoint}/render
 *   { url, waitFor, waitTimeoutMs, viewport, screenshot, headers, cookies }
 *
 * Response:
 *   { html: string, cookies: string[], screenshotBase64?: string, finalUrl: string }
 *
 * Provider supportati out-of-the-box:
 *  - flowforge-managed (default Zeli, eventuale add-on a pagamento)
 *  - browserless (https://browserless.io self-host)
 *  - custom (qualsiasi endpoint compatibile)
 */

import { safeFetchWithRedirects, assertUrlSafe } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required');
  // SSRF-by-proxy (#2): `url` è la PAGINA che il browser BYO naviga (non l'endpoint, già
  // protetto da safeFetchWithRedirects). Senza, url=http://169.254.169.254/… o un host
  // cross-tenant su flowforge-net farebbe SSRF VIA il servizio browser. Coerente con
  // browser-automate, che valida ogni URL navigato.
  assertUrlSafe(url);

  const endpoint = String(config.endpoint ?? process.env.MEDEA_BROWSER_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error(
      'Browser render endpoint not configured. Set MEDEA_BROWSER_ENDPOINT env or fill "endpoint" config field. BYO: deploy Playwright server (browserless.io or self-hosted) and point this here.',
    );
  }

  const apiKey = String(config.apiKey ?? '').trim();
  const waitFor = String(config.waitFor ?? '').trim(); // CSS selector
  const waitTimeoutMs = Math.max(1000, Math.min(Number(config.waitTimeoutMs ?? 15_000), 60_000));
  const screenshot = config.screenshot === true || config.screenshot === 'true';
  const viewportWidth = Math.max(320, Math.min(Number(config.viewportWidth ?? 1280), 3840));
  const viewportHeight = Math.max(240, Math.min(Number(config.viewportHeight ?? 800), 2160));
  const cookiesStr = String(config.cookies ?? '').trim();
  const extraHeadersRaw = config.extraHeaders;
  let extraHeaders: Record<string, string> = {};
  if (typeof extraHeadersRaw === 'string' && extraHeadersRaw.trim()) {
    try {
      extraHeaders = JSON.parse(extraHeadersRaw) as Record<string, string>;
    } catch {
      /* ignore */
    }
  } else if (extraHeadersRaw && typeof extraHeadersRaw === 'object') {
    extraHeaders = extraHeadersRaw as Record<string, string>;
  }

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;

  const reqBody = {
    url,
    waitFor: waitFor || undefined,
    waitTimeoutMs,
    viewport: { width: viewportWidth, height: viewportHeight },
    screenshot,
    cookies: cookiesStr || undefined,
    extraHeaders,
  };

  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/render`, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
    timeoutMs: waitTimeoutMs + 5000,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Browser render failed: ${res.status.toString()} ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    html?: string;
    cookies?: string[];
    screenshotBase64?: string;
    finalUrl?: string;
  };

  return {
    output: {
      html: data.html ?? '',
      cookies: data.cookies ?? [],
      finalUrl: data.finalUrl ?? url,
      screenshotBase64: data.screenshotBase64 ?? null,
    },
    durationMs: Date.now() - start,
  };
};

export const browserRenderNode: NodeModule = {
  def: {
    id: 'action_browser_render',
    type: 'action',
    label: 'Browser Render (headless)',
    icon: 'monitor',
    color: '#0d9488',
    description:
      'Renderizza una pagina con browser headless (Chrome) per scraping di SPA / siti JavaScript-heavy (React/Vue/Angular). Aspetta che il selettore appaia, poi ritorna HTML completo + cookies + screenshot opzionale.\n\n' +
      'Usa quando: action_web_fetch_advanced ritorna HTML scarno perché il contenuto viene generato da JS post-load (es. listing prodotti SPA, dashboard che carica dati via fetch).\n\n' +
      "Architettura BYO (Bring Your Own Browser): per non far esplodere ogni container con 300MB di Chromium, il nodo chiama un endpoint Playwright esterno (browserless.io self-host, Playwright Server, o managed Zeli add-on). Configura l'endpoint in Settings → Integrazioni → Browser Render.\n\n" +
      'Use case: (1) scraping listing prodotti SPA con prezzi caricati via fetch, (2) audit propria dashboard con screenshot SLA-grade, (3) ingest pagina React-based che action_fetch_url restituirebbe vuota, (4) screenshot per archivio legale di una landing competitor (snapshot dated).',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com/dashboard',
        help: 'URL della pagina da renderizzare. Il browser aspetterà che il contenuto JS si carichi.',
      },
      {
        key: 'endpoint',
        label: 'Browser endpoint',
        type: 'text',
        required: false,
        placeholder: 'https://browser.miosito.com (vuoto = usa env MEDEA_BROWSER_ENDPOINT)',
        help: 'URL del Playwright server. Setup tipici: 1) browserless.io self-host (docker run browserless/chrome), 2) Playwright Server. Per la versione managed, contatta il supporto.',
      },
      {
        key: 'apiKey',
        label: 'API Key (se richiesta)',
        type: 'secret',
        required: false,
        help: "Bearer token per autenticare al browser endpoint. Vuoto se l'endpoint è loopback/trusted.",
      },
      {
        key: 'waitFor',
        label: 'Aspetta selettore CSS',
        type: 'text',
        required: false,
        placeholder: '.product-list, #app, [data-loaded="true"]',
        help: 'Il browser aspetta che questo CSS selector compaia prima di ritornare HTML. Lascia vuoto per ritornare appena DOMContentLoaded.',
      },
      {
        key: 'waitTimeoutMs',
        label: 'Timeout attesa (ms)',
        type: 'number',
        required: false,
        defaultValue: '15000',
        help: 'Max attesa per "Aspetta selettore CSS". Default 15s, min 1s, max 60s.',
      },
      {
        key: 'viewportWidth',
        label: 'Viewport width (px)',
        type: 'number',
        required: false,
        defaultValue: '1280',
        help: 'Larghezza finestra browser. 1280 = desktop, 375 = iPhone, 768 = tablet.',
      },
      {
        key: 'viewportHeight',
        label: 'Viewport height (px)',
        type: 'number',
        required: false,
        defaultValue: '800',
        help: 'Altezza finestra browser. Default 800.',
      },
      {
        key: 'screenshot',
        label: 'Screenshot incluso',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON, ritorna anche uno screenshot PNG base64 della pagina renderizzata.',
      },
      {
        key: 'cookies',
        label: 'Cookies iniziali',
        type: 'textarea',
        required: false,
        placeholder: 'session=xyz; cf_clearance=abc',
        help: 'Cookies da iniettare prima del navigate. Utile dopo un action_cloudflare_solver.',
      },
      {
        key: 'extraHeaders',
        label: 'Headers extra',
        type: 'key-value',
        required: false,
        help: 'Headers HTTP custom (es. User-Agent, Authorization).',
      },
    ],
    outputs: ['html', 'cookies', 'finalUrl', 'screenshotBase64'],
  },
  executor,
};
