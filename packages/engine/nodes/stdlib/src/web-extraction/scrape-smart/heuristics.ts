/**
 * Heuristics: decide quale stage successivo eseguire in scrape-smart.
 *
 * Pattern enterprise: invece di un singolo executor monolitico, ogni stage
 * espone una heuristic detect() funzione pura → orchestratore decide.
 */

/**
 * HTML scarno: pagina SPA che ritorna shell vuota + bundle JS.
 * Indicatori:
 *  - <body> contenuto < 500 chars (shell stub)
 *  - <noscript> con messaggio "JavaScript required"
 *  - root container vuoto: <div id="root"></div> / <div id="app"></div>
 *  - script tag count >> testo visibile
 */
export interface ThinHtmlSignals {
  isThin: boolean;
  bodyContentLength: number;
  hasNoScriptWarning: boolean;
  hasEmptyAppContainer: boolean;
  scriptVsContentRatio: number;
}

export function detectThinHtml(html: string): ThinHtmlSignals {
  if (!html) {
    return {
      isThin: true,
      bodyContentLength: 0,
      hasNoScriptWarning: false,
      hasEmptyAppContainer: false,
      scriptVsContentRatio: 0,
    };
  }
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const bodyContent = bodyMatch?.[1] ?? html;
  const stripped = bodyContent
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bodyContentLength = stripped.length;

  const hasNoScriptWarning = /<noscript[^>]*>[\s\S]*?(javascript|enable)[\s\S]*?<\/noscript>/i.test(
    html,
  );
  const hasEmptyAppContainer =
    /<div\s+id=["'](?:root|app|__next|svelte|nuxt)["'][^>]*>\s*<\/div>/i.test(html);

  const scriptCount = (html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? []).length;
  const scriptVsContentRatio =
    bodyContentLength > 0 ? scriptCount / Math.max(1, bodyContentLength / 100) : scriptCount;

  const isThin =
    bodyContentLength < 500 ||
    hasNoScriptWarning ||
    hasEmptyAppContainer ||
    scriptVsContentRatio > 0.5;

  return {
    isThin,
    bodyContentLength,
    hasNoScriptWarning,
    hasEmptyAppContainer,
    scriptVsContentRatio,
  };
}

/**
 * Anti-bot challenge: HTML/headers contengono indicatori Cloudflare/Akamai/
 * DataDome/captcha. Trigger fallback verso stealth.
 */
export interface AntiBotSignals {
  isChallenged: boolean;
  vendor:
    | 'cloudflare'
    | 'akamai'
    | 'datadome'
    | 'perimeterx'
    | 'recaptcha'
    | 'hcaptcha'
    | 'cloudfront'
    | 'incapsula'
    | 'unknown'
    | null;
  evidence: string;
}

const ANTI_BOT_PATTERNS: { vendor: AntiBotSignals['vendor']; re: RegExp }[] = [
  {
    vendor: 'cloudflare',
    re: /(cf-ray|cloudflare|cf_clearance|checking your browser|__cf_chl_|cf-mitigated|just a moment\.\.\.|attention required.*cloudflare)/i,
  },
  {
    vendor: 'akamai',
    re: /(akamai|akamai\.com\/bot|akamai bot manager|reference #18\.[a-f0-9]+)/i,
  },
  { vendor: 'datadome', re: /(datadome|geo\.captcha-delivery\.com|dd_cookie_test)/i },
  {
    vendor: 'perimeterx',
    re: /(perimeterx|px-cdn|_px3|please verify you are a human|enable javascript and cookies)/i,
  },
  { vendor: 'recaptcha', re: /(recaptcha|g-recaptcha|grecaptcha\.execute)/i },
  { vendor: 'hcaptcha', re: /(hcaptcha|h-captcha|hcaptcha\.com)/i },
  { vendor: 'cloudfront', re: /(cloudfront.*forbidden|access denied.*cloudfront)/i },
  { vendor: 'incapsula', re: /(incapsula|_incap_ses|visid_incap)/i },
];

export function detectAntiBot(html: string, statusCode?: number): AntiBotSignals {
  if (!html) return { isChallenged: false, vendor: null, evidence: '' };
  // Common challenge status codes
  if (statusCode === 403 || statusCode === 503 || statusCode === 429) {
    for (const { vendor, re } of ANTI_BOT_PATTERNS) {
      const m = re.exec(html);
      if (m) return { isChallenged: true, vendor, evidence: m[0].slice(0, 100) };
    }
    return { isChallenged: true, vendor: 'unknown', evidence: `HTTP ${statusCode.toString()}` };
  }
  for (const { vendor, re } of ANTI_BOT_PATTERNS) {
    const m = re.exec(html);
    if (m) return { isChallenged: true, vendor, evidence: m[0].slice(0, 100) };
  }
  return { isChallenged: false, vendor: null, evidence: '' };
}

/**
 * Visually-only: contenuto richiede vision LLM perche\` esiste solo a livello
 * pixel (es. tabelle in canvas/SVG, dati in screenshot, PDF embedded).
 */
export function detectVisuallyOnly(html: string): { needsVision: boolean; reason: string } {
  if (!html) return { needsVision: false, reason: '' };
  // Canvas-heavy (es. dashboard rendering)
  if (/<canvas[^>]+(?:width|height)=["']\d{3,}/i.test(html)) {
    return { needsVision: true, reason: 'large canvas detected' };
  }
  // PDF/iframe embedded
  if (/<embed[^>]+type=["']application\/pdf|<iframe[^>]+src=["'][^"']+\.pdf/i.test(html)) {
    return { needsVision: true, reason: 'pdf embedded' };
  }
  // SVG-heavy data viz (più di 50 path elements)
  const svgPathCount = (html.match(/<path[^>]*>/gi) ?? []).length;
  if (svgPathCount > 50) {
    return { needsVision: true, reason: `svg-heavy (${svgPathCount.toString()} paths)` };
  }
  return { needsVision: false, reason: '' };
}
