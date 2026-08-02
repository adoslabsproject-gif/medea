/**
 * action_browser_stealth — Puppeteer-stealth BYO endpoint wrapper.
 *
 * Killer node #1: scraping resistente ad anti-bot enterprise (Cloudflare
 * Turnstile, Akamai, DataDome, PerimeterX, hCaptcha-soft). Architettura BYO
 * stessa di action_browser_render — il server stealth gira separato
 * (browserless.io self-host con stealth plugin OR managed Zeli endpoint).
 *
 * Pattern Streammy: realtà come Streamingcommunity/SporTV usano fingerprint
 * detection enterprise. Le contromisure standard (puppeteer-extra-plugin-stealth)
 * coprono ~20 evasioni: navigator.webdriver, chrome.runtime, plugins.length,
 * iframe.contentWindow, languages, vendor, WebGL renderer, WebGL vendor,
 * canvas fingerprint, audio context, font enumeration, broken images, hairline,
 * media codecs, permission.query, source URL, viewport, touch points, hardware
 * concurrency.
 *
 * Endpoint compatibile:
 *   POST {endpoint}/stealth-render
 *   { url, fingerprint, scrollLazy, humanLike, captureHar, screenshot, ... }
 *
 * Response:
 *   { html, cookies, finalUrl, screenshotBase64?, harBase64?, metrics }
 */

import { safeFetchWithRedirects, assertUrlSafe } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

// Preset fingerprint pools — randomizzazione pre-call lato runtime.
// Lo schema lato server applica TUTTE le evasioni stealth + questi preset.
const FINGERPRINT_PRESETS = {
  'desktop-chrome-it': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'it-IT',
    timezone: 'Europe/Rome',
    platform: 'Win32',
  },
  'desktop-chrome-en': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezone: 'America/New_York',
    platform: 'MacIntel',
  },
  'desktop-firefox-it': {
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    viewport: { width: 1680, height: 1050 },
    locale: 'it-IT',
    timezone: 'Europe/Rome',
    platform: 'Linux x86_64',
  },
  'mobile-safari-it': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'it-IT',
    timezone: 'Europe/Rome',
    platform: 'iPhone',
  },
  'mobile-chrome-android': {
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    platform: 'Linux armv8l',
  },
} as const;

type FingerprintPresetKey = keyof typeof FINGERPRINT_PRESETS;

const isFingerprintPresetKey = (k: string): k is FingerprintPresetKey =>
  Object.prototype.hasOwnProperty.call(FINGERPRINT_PRESETS, k);

export function resolveFingerprint(
  presetKey: string,
): (typeof FINGERPRINT_PRESETS)[FingerprintPresetKey] {
  if (presetKey === 'random') {
    const keys = Object.keys(FINGERPRINT_PRESETS) as FingerprintPresetKey[];
    const pick = keys[Math.floor(Math.random() * keys.length)];
    if (!pick) throw new Error('fingerprint pool empty');
    return FINGERPRINT_PRESETS[pick];
  }
  if (isFingerprintPresetKey(presetKey)) return FINGERPRINT_PRESETS[presetKey];
  return FINGERPRINT_PRESETS['desktop-chrome-it'];
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '').trim();
  if (!url) throw new Error('url required');
  // SSRF-by-proxy (#2): valida la PAGINA navigata dal browser BYO (coerente con
  // browser-automate) — IP privato/interno via il servizio stealth altrimenti.
  assertUrlSafe(url);

  const endpoint = String(
    config.endpoint ??
      process.env.MEDEA_STEALTH_ENDPOINT ??
      process.env.MEDEA_BROWSER_ENDPOINT ??
      '',
  ).trim();
  if (!endpoint) {
    throw new Error(
      'Stealth browser endpoint not configured. Set MEDEA_STEALTH_ENDPOINT env or fill "endpoint" config field. BYO: deploy browserless/chrome + puppeteer-extra-plugin-stealth or use managed Zeli endpoint.',
    );
  }

  const apiKey = String(config.apiKey ?? '').trim();
  const fingerprintPreset = String(config.fingerprintPreset ?? 'random').trim();
  const fingerprint = resolveFingerprint(fingerprintPreset);

  const waitFor = String(config.waitFor ?? '').trim();
  const waitTimeoutMs = Math.max(1000, Math.min(Number(config.waitTimeoutMs ?? 25_000), 90_000));
  const scrollLazy = config.scrollLazy === true || config.scrollLazy === 'true';
  const scrollSteps = Math.max(0, Math.min(Number(config.scrollSteps ?? 5), 30));
  const scrollDelayMs = Math.max(100, Math.min(Number(config.scrollDelayMs ?? 800), 5000));
  const humanLike = config.humanLike === true || config.humanLike === 'true';
  const captureHar = config.captureHar === true || config.captureHar === 'true';
  const screenshot = config.screenshot === true || config.screenshot === 'true';
  const fullPageScreenshot =
    config.fullPageScreenshot === true || config.fullPageScreenshot === 'true';
  const blockResources = String(config.blockResources ?? '').trim();
  const blockResourceList = blockResources
    ? blockResources
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

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
    fingerprint: {
      userAgent: fingerprint.ua,
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezone: fingerprint.timezone,
      platform: fingerprint.platform,
    },
    waitFor: waitFor || undefined,
    waitTimeoutMs,
    scrollLazy: scrollLazy ? { steps: scrollSteps, delayMs: scrollDelayMs } : undefined,
    humanLike,
    captureHar,
    screenshot: screenshot ? { fullPage: fullPageScreenshot } : undefined,
    blockResources: blockResourceList,
    cookies: cookiesStr || undefined,
    extraHeaders,
    stealthPlugins: [
      'navigator.webdriver',
      'chrome.runtime',
      'iframe.contentWindow',
      'media.codecs',
      'navigator.plugins',
      'navigator.languages',
      'webgl.vendor',
      'webgl.renderer',
      'canvas.fingerprint',
      'hairline',
      'permissions.query',
      'window.chrome',
      'sourceurl',
      'navigator.vendor',
    ],
  };

  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/stealth-render`, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
    timeoutMs: waitTimeoutMs + 10_000,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Stealth browser failed: ${res.status.toString()} ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    html?: string;
    cookies?: string[];
    finalUrl?: string;
    screenshotBase64?: string;
    harBase64?: string;
    metrics?: { ttfbMs?: number; loadMs?: number; scriptCount?: number; xhrCount?: number };
  };

  return {
    output: {
      html: data.html ?? '',
      cookies: data.cookies ?? [],
      finalUrl: data.finalUrl ?? url,
      screenshotBase64: data.screenshotBase64 ?? null,
      harBase64: data.harBase64 ?? null,
      metrics: data.metrics ?? null,
      fingerprintUsed: {
        ua: fingerprint.ua,
        viewport: fingerprint.viewport,
        locale: fingerprint.locale,
        timezone: fingerprint.timezone,
      },
    },
    durationMs: Date.now() - start,
  };
};

export const stealthBrowserNode: NodeModule = {
  def: {
    id: 'action_browser_stealth',
    type: 'action',
    label: 'Browser Stealth (anti-bot)',
    icon: 'shield',
    color: '#7c3aed',
    description:
      'Browser headless con anti-detection enterprise (Puppeteer-stealth). Bypassa Cloudflare Turnstile, Akamai Bot Manager, DataDome, PerimeterX, hCaptcha-soft.\n\n' +
      'Applica ~20 contromisure: navigator.webdriver hide, canvas/WebGL fingerprint spoof, chrome.runtime fake, plugins.length match, languages/vendor consistency, iframe.contentWindow patch, font enumeration block, hairline detection, permission.query overwrite.\n\n' +
      'Features avanzate: fingerprint preset pool (desktop/mobile, IT/EN), auto-scroll lazy-load (per Infinite scroll), human-like delays (mouse jitter, typing pause), HAR capture, resource blocking (immagini/font per velocità).\n\n' +
      'Architettura BYO (Bring Your Own Browser): il nodo chiama un endpoint Playwright/Puppeteer con plugin stealth installato. Setup: docker run -p 3000:3000 ghcr.io/browserless/chromium:stealth oppure managed Zeli endpoint.\n\n' +
      'Use case: (1) monitoraggio prezzi su propri marketplace dietro CF/Akamai, (2) audit competitor pricing pages CF-protected con autorizzazione, (3) sync dati internal SPA che usa anti-bot a livello service, (4) snapshot legale di pagine sotto challenge browser-side.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        required: true,
        placeholder: 'https://target-site.com',
        help: 'URL della pagina da scrappare con stealth.',
      },
      {
        key: 'endpoint',
        label: 'Stealth endpoint',
        type: 'text',
        required: false,
        placeholder: 'https://stealth.miosito.com (vuoto = env MEDEA_STEALTH_ENDPOINT)',
        help: 'Browserless con plugin stealth o managed Zeli.',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'secret',
        required: false,
        help: 'Bearer token endpoint stealth.',
      },
      {
        key: 'fingerprintPreset',
        label: 'Fingerprint preset',
        type: 'select',
        required: false,
        defaultValue: 'random',
        options: [
          'random',
          'desktop-chrome-it',
          'desktop-chrome-en',
          'desktop-firefox-it',
          'mobile-safari-it',
          'mobile-chrome-android',
        ],
        help: 'Preset UA + viewport + locale + timezone. random = pesca diversa ogni call (raccomandato per evasione). desktop-chrome-it (Windows 1920x1080), desktop-chrome-en (macOS 1440x900), desktop-firefox-it (Linux 1680x1050), mobile-safari-it (iPhone 390x844), mobile-chrome-android (Pixel 412x915).',
      },
      {
        key: 'waitFor',
        label: 'Aspetta selettore CSS',
        type: 'text',
        required: false,
        placeholder: '.product, [data-loaded]',
        help: 'Selector CSS da aspettare. Vuoto = domcontentloaded.',
      },
      {
        key: 'waitTimeoutMs',
        label: 'Timeout attesa (ms)',
        type: 'number',
        required: false,
        defaultValue: '25000',
        help: 'Max 90s. Default 25s (anti-bot challenge richiede tempo).',
      },
      {
        key: 'scrollLazy',
        label: 'Auto-scroll lazy-load',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Scrolla la pagina N volte per triggerare lazy-load (Infinite scroll, immagini lazy).',
      },
      {
        key: 'scrollSteps',
        label: 'Scroll steps',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Quante volte scrolla. Default 5, max 30.',
      },
      {
        key: 'scrollDelayMs',
        label: 'Delay scroll (ms)',
        type: 'number',
        required: false,
        defaultValue: '800',
        help: 'Pausa tra ogni scroll. Default 800ms (human-like).',
      },
      {
        key: 'humanLike',
        label: 'Human-like interactions',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Mouse jitter, typing delay random, pause variabili. Disabilita per speed.',
      },
      {
        key: 'captureHar',
        label: 'Cattura HAR',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Salva HTTP Archive completo (network requests). Utile per reverse-engineering API XHR.',
      },
      {
        key: 'screenshot',
        label: 'Screenshot',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'PNG base64 della pagina.',
      },
      {
        key: 'fullPageScreenshot',
        label: 'Screenshot full-page',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: "Screenshot dell'intera pagina scrollata (non solo viewport).",
      },
      {
        key: 'blockResources',
        label: 'Blocca risorse',
        type: 'text',
        required: false,
        placeholder: 'image,font,media',
        help: 'Lista CSV: image,font,stylesheet,media,websocket. Speed-up se non servono.',
      },
      {
        key: 'cookies',
        label: 'Cookies iniziali',
        type: 'textarea',
        required: false,
        placeholder: 'session=xyz; auth=abc',
        help: 'Cookies pre-navigate.',
      },
      {
        key: 'extraHeaders',
        label: 'Headers extra',
        type: 'key-value',
        required: false,
        help: 'Headers HTTP custom.',
      },
    ],
    outputs: [
      'html',
      'cookies',
      'finalUrl',
      'screenshotBase64',
      'harBase64',
      'metrics',
      'fingerprintUsed',
    ],
  },
  executor,
};
