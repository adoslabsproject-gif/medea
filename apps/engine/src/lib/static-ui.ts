/**
 * Static UI serving for the bundled editor.
 *
 * When the binary runs, the editor's compiled `dist/` directory is shipped
 * alongside the runtime. This middleware serves index.html + asset files
 * for any non-API path so the same port hosts both the API and the UI.
 *
 * Asset resolution priority:
 *   1. MEDEA_UI_DIR env var (absolute path)
 *   2. ../../editor/dist relative to the running script
 *   3. ./ui relative to the binary executable
 *
 * SPA fallback: any non-asset GET that does not start with /api/, /webhooks/,
 * /forms/, /ws, /collab, /health returns index.html so client-side routing
 * works.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from './logger.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  // PWA web manifest — CRITICO content-type: senza application/manifest+json
  // Samsung Internet / Chrome PWA criteria validator RIFIUTA install.
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
};

function resolveUiDir(): string | null {
  if (process.env.MEDEA_UI_DIR && existsSync(process.env.MEDEA_UI_DIR)) {
    return process.env.MEDEA_UI_DIR;
  }
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Monorepo layout: dist di runtime e` `apps/engine/dist`,
    // editor e` `apps/flowforge-editor/dist`. Risolviamo entrambi i naming.
    candidates.push(resolve(here, '../../../flowforge-editor/dist'));
    candidates.push(resolve(here, '../../../editor/dist'));
    candidates.push(resolve(here, '../../flowforge-editor/dist'));
    candidates.push(resolve(here, '../../editor/dist'));
  } catch {
    // import.meta.url may be unavailable in some bundlers; fall through.
  }
  candidates.push(resolve(process.cwd(), 'apps/flowforge-editor/dist'));
  candidates.push(resolve(process.cwd(), 'apps/editor/dist'));
  candidates.push(resolve(process.cwd(), 'ui'));
  candidates.push(resolve(process.cwd(), 'editor-dist'));
  candidates.push(resolve(process.cwd(), 'dist/ui'));
  for (const c of candidates) {
    if (existsSync(c) && existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

const API_PREFIXES = ['/api/', '/webhooks/', '/forms/', '/ws', '/collab', '/health'];

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p.replace(/\/$/u, '') || path.startsWith(p));
}

function getMime(path: string): string {
  const idx = path.lastIndexOf('.');
  const ext = idx >= 0 ? path.slice(idx) : '';
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * Cache-Control policy per i file PWA-critical (sw.js, manifest, registerSW):
 *  - sw.js / registerSW.js: max-age=0 + must-revalidate. Critico — il browser
 *    DEVE revalidare il service worker ad ogni page load per attivare la
 *    versione nuova al deploy. `immutable` qui = users vedono vecchia versione
 *    per giorni (incident 2026-06-06 "PWA non si installa + vedo tutto uguale").
 *  - manifest.webmanifest: max-age=300 (5min) + must-revalidate. Necessario
 *    per propagare cambi a start_url / theme_color / icons rapidamente.
 *
 * Esportato per testabilita\` unit isolata (vedi static-ui.test.ts).
 */
export function isPwaCriticalFile(absPath: string): boolean {
  return /(?:sw\.js|registerSW\.js|manifest\.webmanifest|workbox-[a-f0-9]+\.js)$/u.test(absPath);
}

/** Public — pure helper esposto per test (no I/O, no Hono context). */
export function pickCacheControl(absPath: string): string {
  // App shell SPA: `no-store` (non solo `no-cache`) per impedire al back/forward
  // cache del browser di ripristinare lo shell autenticato DOPO un logout.
  // Con `no-cache` alcuni browser servono comunque lo snapshot bfcache (sessione
  // apparentemente ancora attiva). BUG FIX 2026-06-07.
  if (absPath.endsWith('index.html')) return 'no-store, no-cache, must-revalidate';
  if (isPwaCriticalFile(absPath)) {
    return absPath.endsWith('manifest.webmanifest')
      ? 'public, max-age=300, must-revalidate'
      : 'no-cache, max-age=0, must-revalidate';
  }
  return 'public, max-age=31536000, immutable';
}

/** Public — pure helper per content-type. Esposto per testabilita\`. */
export function pickContentType(absPath: string): string {
  return getMime(absPath);
}

function serveFile(c: Context, absPath: string): Response {
  const buf = readFileSync(absPath);
  const headers = new Headers({
    'Content-Type': pickContentType(absPath),
    'Cache-Control': pickCacheControl(absPath),
  });
  void c; // not used, just satisfies type
  return new Response(buf, { headers });
}

export function attachStaticUi(app: Hono): void {
  const uiDir = resolveUiDir();
  if (!uiDir) {
    logger.warn(
      'Static UI directory not found — runtime will only serve the API. Set MEDEA_UI_DIR or place dist/ next to the binary.',
    );
    return;
  }
  logger.info({ uiDir }, 'Serving bundled UI');

  /**
   * Serve the editor entry HTML with cache headers that PREVENT browsers
   * from caching index.html. Critical: without this, a deploy that changes
   * the hashed asset names leaves users with a stale index.html referencing
   * /assets/index-OLDHASH.css — which 404s, because the new build emitted
   * /assets/index-NEWHASH.css. The browser then "applies" a 404 response
   * (Content-Type text/plain) where CSS is expected, throws a MIME strict
   * error, and the entire page renders unstyled.
   *
   * The hashed assets themselves CAN be cached forever (immutable) because
   * their filenames change on every build. That is set in serveFile().
   */
  /**
   * Serve index.html SENZA inline script — necessario per una CSP strict
   * `script-src 'self'` (no 'unsafe-inline', no hash dinamici).
   *
   * Prima injecttavamo `<script>window.__MEDEA_API_URL__ = location.origin + '/api/v1'</script>`
   * ma il client (apps/editor/src/lib/api.ts) ha già il fallback equivalente
   * `${window.location.origin}/api/v1` come ultima priorità — l'inject era
   * ridondante. Rimuovendolo, l'HTML servito è 100% statico → CSP strict
   * funziona senza nonce dinamici. Standard 2026 / NHA pattern.
   */
  function serveIndexHtml(): Response {
    const html = readFileSync(join(uiDir!, 'index.html'), 'utf8');
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  }

  app.get('/', () => serveIndexHtml());

  app.get('*', (c) => {
    const path = new URL(c.req.url).pathname;
    if (isApiPath(path)) return c.notFound();

    const filePath = join(uiDir, path);
    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(c, filePath);
      }
    } catch {
      /* fall through */
    }

    // Asset-path discipline: any URL pointing at a file with a known
    // extension MUST be a real file. If it is not, return 404 — never
    // index.html, because the browser will reject the wrong MIME and the
    // page will silently break (e.g. CSS Refused with MIME 'text/html').
    const extIdx = path.lastIndexOf('.');
    const ext = extIdx >= 0 ? path.slice(extIdx) : '';
    if (path.startsWith('/assets/') || (ext !== '' && ext in MIME && ext !== '.html')) {
      return c.notFound();
    }

    // SPA fallback: same anti-cache treatment as the root.
    return serveIndexHtml();
  });
}
