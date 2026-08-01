/**
 * Test reali heuristics scrape-smart. NO smoke fake.
 * Asseriscono detection ACCURATA su HTML reali (campioni SPA, anti-bot,
 * visually-only).
 */
import { describe, it, expect } from 'vitest';
import { detectThinHtml, detectAntiBot, detectVisuallyOnly } from './heuristics.js';

describe('detectThinHtml', () => {
  it('HTML vuoto → thin', () => {
    const r = detectThinHtml('');
    expect(r.isThin).toBe(true);
    expect(r.bodyContentLength).toBe(0);
  });

  it('HTML < 100 chars → thin', () => {
    expect(detectThinHtml('<html>tiny</html>').isThin).toBe(true);
  });

  it('SPA shell vuota (Next.js stile) → thin', () => {
    const spa = `<html><head><title>App</title></head><body><div id="__next"></div><script src="/_next/static/main.js"></script></body></html>`;
    const r = detectThinHtml(spa);
    expect(r.isThin).toBe(true);
    expect(r.hasEmptyAppContainer).toBe(true);
  });

  it('React shell vuota (#root) → thin', () => {
    const html = `<!DOCTYPE html><html><body><div id="root"></div><script src="bundle.js"></script></body></html>`;
    expect(detectThinHtml(html).hasEmptyAppContainer).toBe(true);
  });

  it('noscript warning → thin', () => {
    const html = `<html><body><noscript>Please enable JavaScript to use this app.</noscript><div>content here ${'x'.repeat(600)}</div></body></html>`;
    expect(detectThinHtml(html).hasNoScriptWarning).toBe(true);
    expect(detectThinHtml(html).isThin).toBe(true);
  });

  it('Body content > 500 chars NO scripts → NOT thin', () => {
    const article = `<html><body><article>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}</article></body></html>`;
    const r = detectThinHtml(article);
    expect(r.isThin).toBe(false);
    expect(r.bodyContentLength).toBeGreaterThan(500);
  });

  it('Script-heavy ratio > 0.5 → thin (bundle obfuscated)', () => {
    const scripts = '<script>x=1</script>'.repeat(20);
    const html = `<html><body>${scripts}<p>tiny</p></body></html>`;
    expect(detectThinHtml(html).isThin).toBe(true);
  });

  it('bodyContentLength conta SOLO testo visibile (no script/style/tags)', () => {
    const html = `<html><body><style>.x{color:red}</style><script>var a=1</script><p>HELLO</p></body></html>`;
    expect(detectThinHtml(html).bodyContentLength).toBe(5); // "HELLO"
  });
});

describe('detectAntiBot', () => {
  it('HTML pulito → no challenge', () => {
    const r = detectAntiBot('<html><body><p>welcome</p></body></html>');
    expect(r.isChallenged).toBe(false);
    expect(r.vendor).toBeNull();
  });

  it('Cloudflare "checking your browser" → cloudflare', () => {
    const html = `<html><body>Just a moment...<br>Checking your browser before accessing</body></html>`;
    const r = detectAntiBot(html);
    expect(r.isChallenged).toBe(true);
    expect(r.vendor).toBe('cloudflare');
  });

  it('Cloudflare cf-ray header marker', () => {
    const r = detectAntiBot('<html>cf-ray: abc123</html>');
    expect(r.vendor).toBe('cloudflare');
  });

  it('Akamai reference', () => {
    const r = detectAntiBot('<html>Reference #18.abc123def Access Denied</html>');
    expect(r.vendor).toBe('akamai');
  });

  it('DataDome', () => {
    const r = detectAntiBot('<html>blocked by datadome captcha</html>');
    expect(r.vendor).toBe('datadome');
  });

  it('PerimeterX', () => {
    const r = detectAntiBot('<html>Please verify you are a human (perimeterx)</html>');
    expect(r.vendor).toBe('perimeterx');
  });

  it('reCAPTCHA inline', () => {
    const r = detectAntiBot('<div class="g-recaptcha" data-sitekey="x"></div>');
    expect(r.vendor).toBe('recaptcha');
  });

  it('hCaptcha', () => {
    const r = detectAntiBot('<div class="h-captcha"></div>');
    expect(r.vendor).toBe('hcaptcha');
  });

  it('Status 403 + no vendor pattern → challenged "unknown"', () => {
    const r = detectAntiBot('<html>forbidden</html>', 403);
    expect(r.isChallenged).toBe(true);
    expect(r.vendor).toBe('unknown');
    expect(r.evidence).toContain('403');
  });

  it('Status 200 + no pattern → NOT challenged', () => {
    const r = detectAntiBot('<html><h1>hello</h1></html>', 200);
    expect(r.isChallenged).toBe(false);
  });

  it('Incapsula visid_incap cookie marker', () => {
    expect(detectAntiBot('<script>document.cookie="visid_incap_xxx=yyy"</script>').vendor).toBe('incapsula');
  });

  it('evidence troncata a 100 chars', () => {
    const huge = 'cloudflare ' + 'x'.repeat(500);
    const r = detectAntiBot(huge);
    expect(r.evidence.length).toBeLessThanOrEqual(100);
  });
});

describe('detectVisuallyOnly', () => {
  it('HTML normale → NOT needs vision', () => {
    expect(detectVisuallyOnly('<p>texty</p>').needsVision).toBe(false);
  });

  it('Canvas grande (width >= 100) → needs vision', () => {
    expect(detectVisuallyOnly('<canvas width="800" height="600"></canvas>').needsVision).toBe(true);
    expect(detectVisuallyOnly('<canvas width="800" height="600"></canvas>').reason).toContain('canvas');
  });

  it('Canvas piccolo (width 50) → NOT vision', () => {
    expect(detectVisuallyOnly('<canvas width="50" height="50"></canvas>').needsVision).toBe(false);
  });

  it('PDF embedded → needs vision', () => {
    expect(detectVisuallyOnly('<embed type="application/pdf" src="/doc.pdf">').needsVision).toBe(true);
    expect(detectVisuallyOnly('<iframe src="/file.pdf"></iframe>').needsVision).toBe(true);
  });

  it('SVG con > 50 path → needs vision', () => {
    const svg = '<svg>' + '<path d="M0 0"/>'.repeat(60) + '</svg>';
    expect(detectVisuallyOnly(svg).needsVision).toBe(true);
    expect(detectVisuallyOnly(svg).reason).toContain('60 paths');
  });

  it('SVG con 10 path → NOT vision', () => {
    const svg = '<svg>' + '<path d="M0 0"/>'.repeat(10) + '</svg>';
    expect(detectVisuallyOnly(svg).needsVision).toBe(false);
  });
});
