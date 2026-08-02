/**
 * Binary download — serve i blob del BinaryStore content-addressed del tenant
 * (gap #6 masterplan: tab Binary nel data viewer).
 *
 * `GET /api/v1/binary/:ref` dove `:ref` è il content-address (sha256 64-hex) di
 * un `BinaryData { encoding:'ref', ref }` presente nell'output di un nodo.
 *
 * SICUREZZA (centro del bug-bounty):
 *   • Anti-traversal: il BinaryStore valida `ref` come sha256 64-hex PRIMA di
 *     toccare il filesystem (InvalidBinaryRefError → 400). Impossibile uscire
 *     da baseDir.
 *   • Content-Length dal SERVER (size reale del blob), MAI dal client.
 *   • Anti-XSS: il `mime` arriva dal client (il server è content-addressed,
 *     non conosce il tipo). NON ci fidiamo per il rendering inline:
 *       - Default: `Content-Disposition: attachment` + `application/octet-stream`
 *         → il browser SCARICA, non esegue.
 *       - `?inline=1` consentito SOLO per immagini raster in allowlist
 *         (mai image/svg+xml → vettore XSS, mai text/html). Allora si serve
 *         con il mime reale + inline, per la preview nel viewer.
 *     `X-Content-Type-Options: nosniff` sempre, così il browser non indovina
 *     un tipo eseguibile da un octet-stream.
 *   • fileName sanitizzato per Content-Disposition (no CRLF injection, RFC 5987
 *     filename* per UTF-8 + fallback ASCII).
 *
 * Tenant isolation: il runtime è per-tenant (un container = un tenant) e il
 * BinaryStore serve il disco di QUEL tenant — l'auth middleware globale basta,
 * non serve un gate cross-tenant (i blob altrui vivono in altri container).
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { Readable } from 'node:stream';
import {
  getBinaryStore,
  InvalidBinaryRefError,
  BinaryNotFoundError,
} from '@/services/binary-store.service.js';
import { logger } from '@/lib/logger.js';

const log = logger.child({ mod: 'binary-route' });

/**
 * Immagini RASTER sicure da servire inline (preview nel viewer). Esclusi di
 * proposito: image/svg+xml (può contenere <script>), qualsiasi text/* e
 * application/* — quelli passano SEMPRE come attachment octet-stream.
 */
const INLINE_SAFE_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

/** Sanitizza un fileName per l'header Content-Disposition (anti CRLF / quote). */
function dispositionFileName(raw: string | undefined): string {
  const name = (raw ?? 'download').replace(/[\r\n"\\/]/gu, '_').slice(0, 200) || 'download';
  // ASCII fallback (token semplice) + filename* RFC 5987 per UTF-8 completo.
  const ascii = name.replace(/[^\x20-\x7E]/gu, '_');
  const encoded = encodeURIComponent(name);
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function createBinaryRoutes(): Hono {
  const app = new Hono();

  app.get('/binary/:ref', async (c) => {
    const ref = c.req.param('ref');
    const store = getBinaryStore();

    // size() valida il ref (sha256) e trova il blob; distingue 400 (ref non
    // valido = anti-traversal) da 404 (blob assente) — vedi BinaryStore.
    let size: number;
    try {
      size = await store.size(ref);
    } catch (err) {
      if (err instanceof InvalidBinaryRefError) return c.json({ error: 'Invalid binary ref' }, 400);
      if (err instanceof BinaryNotFoundError) return c.json({ error: 'Binary not found' }, 404);
      log.error({ err: String(err), ref }, 'binary size failed');
      return c.json({ error: 'Binary read error' }, 500);
    }

    const reqMime = c.req.query('mime') ?? '';
    const wantInline = c.req.query('inline') === '1';
    const fileName = c.req.query('name') ?? undefined;
    const inlineSafe = wantInline && INLINE_SAFE_MIME.has(reqMime);

    // Anti-XSS: inline SOLO per immagini raster allowlisted; altrimenti
    // octet-stream + attachment (download, mai esecuzione nel browser).
    c.header('Content-Type', inlineSafe ? reqMime : 'application/octet-stream');
    c.header('Content-Length', String(size));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=0, no-store');
    c.header(
      'Content-Disposition',
      `${inlineSafe ? 'inline' : 'attachment'}; ${dispositionFileName(fileName)}`,
    );

    // Stream a basso uso di memoria (i byte non passano tutti in RAM).
    const nodeStream = store.readStream(ref);
    return stream(c, async (s) => {
      await s.pipe(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>);
    });
  });

  return app;
}
