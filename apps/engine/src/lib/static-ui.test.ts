/**
 * Test 2026-grade — static-ui pure helpers (isPwaCriticalFile, pickCacheControl,
 * pickContentType).
 *
 * INCIDENT 2026-06-06: "PWA non si installa su Samsung Internet + vedo tutto
 * uguale a prima da mobile". Root cause:
 *   1. manifest.webmanifest serviva content-type=application/octet-stream
 *      (MIME map mancava .webmanifest) -> Samsung/Chrome RIFIUTANO install.
 *   2. sw.js + manifest cache-control=public,max-age=31536000,immutable ->
 *      browser non risceglie mai versione nuova al deploy.
 *
 * Coverage:
 *  - .webmanifest -> application/manifest+json (PWA install REQUIRES questo)
 *  - .webp -> image/webp (modern image format, fallback no octet-stream)
 *  - sw.js -> no-cache, max-age=0, must-revalidate
 *  - registerSW.js -> no-cache, max-age=0
 *  - workbox-<hash>.js -> no-cache (parte del SW)
 *  - manifest.webmanifest -> max-age=300 must-revalidate (5min refresh)
 *  - index.html -> no-cache (deploy puo` cambiare hash asset)
 *  - assets/index-<hash>.js -> immutable 1 year (filename hashato safe)
 *  - assets/index-<hash>.css -> immutable 1 year
 *  - icon-512.png -> immutable 1 year (assetti statici hash-named o stabili)
 *  - regression: file con substring "sw.js" ma diverso es. "preview.js" NON
 *    matchato come PWA-critical
 */
import { describe, it, expect } from 'vitest';
import { isPwaCriticalFile, pickCacheControl, pickContentType } from './static-ui.js';

describe('isPwaCriticalFile — riconoscimento PWA boot files', () => {
  it('riconosce sw.js', () => {
    expect(isPwaCriticalFile('/srv/dist/sw.js')).toBe(true);
  });

  it('riconosce registerSW.js', () => {
    expect(isPwaCriticalFile('/srv/dist/registerSW.js')).toBe(true);
  });

  it('riconosce workbox-<hash>.js', () => {
    expect(isPwaCriticalFile('/srv/dist/workbox-abeb32eb.js')).toBe(true);
  });

  it('riconosce manifest.webmanifest', () => {
    expect(isPwaCriticalFile('/srv/dist/manifest.webmanifest')).toBe(true);
  });

  it('NON matcha sw.js.map (sourcemap separato dal SW)', () => {
    expect(isPwaCriticalFile('/srv/dist/sw.js.map')).toBe(false);
  });

  it('NON matcha file chunk asset con hash', () => {
    expect(isPwaCriticalFile('/srv/dist/assets/index-Du35oA28.js')).toBe(false);
  });

  it('NON matcha CSS', () => {
    expect(isPwaCriticalFile('/srv/dist/assets/index-CYfrS9VV.css')).toBe(false);
  });

  it('NON matcha file con "sw" nel nome ma non sw.js (es. "answer.js")', () => {
    expect(isPwaCriticalFile('/srv/dist/answer.js')).toBe(false);
  });

  it('NON matcha workbox-no-hash.js (regex hex obbligatorio)', () => {
    expect(isPwaCriticalFile('/srv/dist/workbox-no-hash.js')).toBe(false);
  });
});

describe('pickCacheControl — policy critica PWA', () => {
  it('sw.js -> no-cache + max-age=0 + must-revalidate (deploy auto-update)', () => {
    expect(pickCacheControl('/srv/dist/sw.js')).toBe('no-cache, max-age=0, must-revalidate');
  });

  it('registerSW.js -> no-cache + max-age=0', () => {
    expect(pickCacheControl('/srv/dist/registerSW.js')).toBe(
      'no-cache, max-age=0, must-revalidate',
    );
  });

  it('workbox-<hash>.js -> no-cache + max-age=0 (parte SW)', () => {
    expect(pickCacheControl('/srv/dist/workbox-abeb32eb.js')).toBe(
      'no-cache, max-age=0, must-revalidate',
    );
  });

  it('manifest.webmanifest -> max-age=300 must-revalidate (5min refresh)', () => {
    expect(pickCacheControl('/srv/dist/manifest.webmanifest')).toBe(
      'public, max-age=300, must-revalidate',
    );
  });

  it('index.html -> no-store (mai stale + anti-bfcache post-logout)', () => {
    // no-store impedisce al back/forward cache di ripristinare lo shell
    // autenticato dopo il logout (BUG FIX 2026-06-07).
    expect(pickCacheControl('/srv/dist/index.html')).toBe('no-store, no-cache, must-revalidate');
  });

  it('REGRESSION: assets/index-<hash>.js -> immutable 1 year (filename hashato safe)', () => {
    expect(pickCacheControl('/srv/dist/assets/index-Du35oA28.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('assets/index-<hash>.css -> immutable 1 year', () => {
    expect(pickCacheControl('/srv/dist/assets/index-CYfrS9VV.css')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('icon-192x192.png -> immutable 1 year (asset stabile)', () => {
    expect(pickCacheControl('/srv/dist/icon-192x192.png')).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});

describe('pickContentType — REGRESSION incident PWA install rifiutato', () => {
  it('REGRESSION: .webmanifest -> application/manifest+json (CRITICO Samsung Internet install)', () => {
    expect(pickContentType('/srv/dist/manifest.webmanifest')).toBe('application/manifest+json');
  });

  it('.webp -> image/webp (modern image format)', () => {
    expect(pickContentType('/srv/dist/hero.webp')).toBe('image/webp');
  });

  it('.png -> image/png', () => {
    expect(pickContentType('/srv/dist/icon.png')).toBe('image/png');
  });

  it('.svg -> image/svg+xml', () => {
    expect(pickContentType('/srv/dist/favicon.svg')).toBe('image/svg+xml');
  });

  it('.js -> application/javascript', () => {
    expect(pickContentType('/srv/dist/sw.js')).toBe('application/javascript; charset=utf-8');
  });

  it('.css -> text/css', () => {
    expect(pickContentType('/srv/dist/index.css')).toBe('text/css; charset=utf-8');
  });

  it('.html -> text/html', () => {
    expect(pickContentType('/srv/dist/index.html')).toBe('text/html; charset=utf-8');
  });

  it('.json -> application/json', () => {
    expect(pickContentType('/srv/dist/data.json')).toBe('application/json; charset=utf-8');
  });

  it('.woff2 -> font/woff2', () => {
    expect(pickContentType('/srv/dist/Inter.woff2')).toBe('font/woff2');
  });

  it('fallback per estensione sconosciuta -> application/octet-stream', () => {
    expect(pickContentType('/srv/dist/unknown.xyz')).toBe('application/octet-stream');
  });

  it('REGRESSION: no extension -> application/octet-stream (no crash)', () => {
    expect(pickContentType('/srv/dist/noext')).toBe('application/octet-stream');
  });
});
