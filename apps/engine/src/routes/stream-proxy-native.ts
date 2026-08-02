/**
 * Stream Proxy Native — endpoint host-side che bypassa il sandbox isolated-vm
 * per traffic HLS (m3u8/ts/key/vtt/mp4/m4s/aac/webvtt).
 *
 * Why bypass: il bundle stream_proxy nel sandbox:
 *   - legge l'intero body in arrayBuffer → base64 → JSON
 *   - 128MB memory limit del sandbox = OOM sui video chunks 2-3MB ripetuti
 *   - ogni chunk = workflow run completo = sandbox boot ~150ms latency
 *   - no Range request support → VLC seek/buffering rotto
 *   - cade dopo alcuni secondi di playback
 *
 * Native approach:
 *   - Pipe diretto upstream → response (no buffer in memoria)
 *   - Range header pass-through + status 206 Partial Content
 *   - M3U8 detection: leggi tutto + rewrite inline (URL signing host-side)
 *   - Latency: 1 fetch invece di sandbox boot + N round-trips
 *
 * Security: stesso schema HMAC del bundle (u/e/sig + signSecret del workflow).
 * Il signSecret viene letto dal nodo `custom_action_stream_proxy` del workflow
 * trovato via customPath lookup — multi-tenant generico, no hardcode.
 *
 * @module routes/stream-proxy-native
 */
import type { Context } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger.js';
import { readTextTruncated } from '@/lib/capped-response.js';
import type { WorkflowService } from '@/services/workflow.service.js';

interface ProxyConfig {
  signSecret: string;
  referer: string;
  userAgent: string;
  timeoutMs: number;
}

/**
 * Pattern: /webhooks/c/stream/proxy.(m3u8|m3u|ts|vtt|key|mp4|m4s|aac|webvtt)/:token?u=...&e=...&sig=...
 *
 * Match HLS-related extensions only. Altri webhook customPath continuano al
 * route legacy customPathHandler.
 */
const STREAM_PROXY_RE =
  /^\/webhooks\/c\/stream\/proxy\.(m3u8|m3u|ts|vtt|key|mp4|m4s|aac|webvtt)\/([^/?#]+)$/u;

function base64UrlDecode(s: string): string | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/=+$/u, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function computeSig(secret: string, u: string, e: number): string {
  return createHmac('sha256', secret).update(`${u}|${e}`).digest('hex');
}

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

interface VerifyOk {
  ok: true;
  url: string;
}
interface VerifyFail {
  ok: false;
  reason: string;
}
export function verifyProxySignature(
  u: string,
  e: string,
  sig: string,
  secret: string,
): VerifyOk | VerifyFail {
  const expNum = parseInt(e, 10);
  if (!Number.isFinite(expNum) || expNum <= 0) return { ok: false, reason: 'bad-exp' };
  if (expNum < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const expectedSig = computeSig(secret, u, expNum);
  if (!safeStringEqual(expectedSig, sig)) return { ok: false, reason: 'sig-mismatch' };
  const decoded = base64UrlDecode(u);
  if (!decoded || !/^https?:\/\//iu.test(decoded)) return { ok: false, reason: 'bad-url' };
  return { ok: true, url: decoded };
}

/** Sign una URL nuova con TTL ridotto (1h sufficient per VLC playback) */
function signProxyUrl(
  upstreamUrl: string,
  proxyBase: string,
  secret: string,
  ttlSec: number,
): string {
  const e = Math.floor(Date.now() / 1000) + ttlSec;
  const u = base64UrlEncode(upstreamUrl);
  const sig = computeSig(secret, u, e);
  const sep = proxyBase.includes('?') ? '&' : '?';
  return `${proxyBase}${sep}u=${u}&e=${e}&sig=${sig}`;
}

/**
 * Rewrite M3U8 — sostituisci ogni URL assoluto con il proxy-signed equivalent.
 * Pattern minimo: regex su URL http(s):// in linee non-comment + URI="..." in
 * EXT-X-MEDIA. Stesso behavior del bundle ma scritto inline (no import).
 */
function rewriteM3u(
  body: string,
  opts: { baseUrl: string; proxyBase: string; secret: string; ttlSec: number },
): string {
  const lines = body.split(/\r?\n/u);
  const out: string[] = [];
  for (const line of lines) {
    let mutated = line;
    // URI="..." within EXT-X-MEDIA / EXT-X-KEY tags
    mutated = mutated.replace(/URI="([^"]+)"/gu, (_full, urlMatch: string) => {
      const abs = resolveUrl(urlMatch, opts.baseUrl);
      if (!abs) return _full;
      return `URI="${signProxyUrl(abs, opts.proxyBase, opts.secret, opts.ttlSec)}"`;
    });
    // Plain URL line (no leading # = stream target line)
    if (!mutated.startsWith('#') && mutated.trim().length > 0) {
      const abs = resolveUrl(mutated.trim(), opts.baseUrl);
      if (abs) mutated = signProxyUrl(abs, opts.proxyBase, opts.secret, opts.ttlSec);
    }
    out.push(mutated);
  }
  return out.join('\n');
}

function resolveUrl(url: string, baseUrl: string): string | null {
  if (!url || url.length === 0) return null;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

function looksLikeM3u8(asText: string, contentType: string): boolean {
  if (/mpegurl|m3u8/iu.test(contentType)) return true;
  return asText.startsWith('#EXTM3U');
}

/**
 * Estrai la config del nodo `custom_action_stream_proxy` (seed o serve) dal
 * workflow. Multi-trigger workflow (m3u8 + ts) condividono lo stesso signSecret.
 *
 * Accetta sia `Workflow.nodes` (array parsato) sia `nodesJson` (string raw)
 * per back-compat. `findProxyConfig` interno: usa nodes array. Per test
 * con string JSON è esposta `findProxyConfigJson` su __testExports.
 */
interface ProxyNodeShape {
  defId?: string;
  config?: Record<string, unknown>;
}
function findProxyConfig(nodes: ProxyNodeShape[]): ProxyConfig | null {
  const proxyNode = nodes.find((n) => n.defId === 'custom_action_stream_proxy');
  if (!proxyNode?.config) return null;
  const cfg = proxyNode.config;
  const signSecret = typeof cfg.signSecret === 'string' ? cfg.signSecret : '';
  if (signSecret.length < 16) return null;
  return {
    signSecret,
    referer: typeof cfg.referer === 'string' ? cfg.referer : '',
    userAgent: typeof cfg.userAgent === 'string' ? cfg.userAgent : 'Mozilla/5.0',
    timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 30_000,
  };
}
function findProxyConfigJson(nodesJson: string): ProxyConfig | null {
  try {
    const nodes = JSON.parse(nodesJson) as ProxyNodeShape[];
    return findProxyConfig(nodes);
  } catch {
    return null;
  }
}

interface ProxyDeps {
  workflows: WorkflowService;
}

/**
 * Costruisce il middleware Hono. Da montare SU app PRIMA di /webhooks/c/*
 * customPathHandler — l'ordine di registrazione conta in Hono.
 */
export function createStreamProxyNativeMiddleware(deps: ProxyDeps) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const match = STREAM_PROXY_RE.exec(c.req.path);
    if (!match) return next();

    const ext = match[1]!;
    const token = match[2]!;
    const url = new URL(c.req.url);
    const u = url.searchParams.get('u');
    const e = url.searchParams.get('e');
    const sig = url.searchParams.get('sig');
    if (!u || !e || !sig) return c.json({ error: 'STREAM_PROXY_BAD_QUERY: missing u/e/sig' }, 400);

    // Lookup workflow via token + customPath. Same logic of customPathHandler
    // but inline — extension è già splitted (m3u8|ts|...), customPath è
    // sempre `stream/proxy.<ext>`.
    const customPath = `stream/proxy.${ext}`;
    const matches = await deps.workflows.listByCustomWebhookPathAnyTenant(customPath);
    if (matches.length === 0) return c.json({ error: 'No webhook for that custom path' }, 404);
    const wf = matches[0]!;

    // Token check: il trigger_webhook NODE ha un token autorizzato. Same logic
    // del runWebhook. Per HLS hint il token può essere ${realToken}.<ext>.
    // Qui non c'è hint (ext è già nel path before slash), quindi token == raw.
    const nodes = wf.nodes as ProxyNodeShape[];
    const triggerNode = nodes.find(
      (n) =>
        n.defId === 'trigger_webhook' &&
        typeof n.config?.customPath === 'string' &&
        n.config.customPath === customPath,
    );
    if (!triggerNode) return c.json({ error: 'No matching webhook trigger' }, 404);
    const expectedToken =
      typeof triggerNode.config?.token === 'string' ? triggerNode.config.token : '';
    if (expectedToken && !safeStringEqual(expectedToken, token))
      return c.json({ error: 'Token mismatch' }, 403);

    // Read proxy config
    const proxyConfig = findProxyConfig(nodes);
    if (!proxyConfig) return c.json({ error: 'No stream_proxy config in workflow' }, 500);

    // Verify HMAC signature
    const verified = verifyProxySignature(u, e, sig, proxyConfig.signSecret);
    if (!verified.ok) {
      logger.warn(
        { reason: verified.reason, path: c.req.path },
        '[stream-proxy-native] verify failed',
      );
      return c.json({ error: `STREAM_PROXY_VERIFY_FAILED: ${verified.reason}` }, 403);
    }

    // Fetch upstream with Range pass-through
    const upstreamHeaders: Record<string, string> = { Accept: '*/*' };
    if (proxyConfig.referer) upstreamHeaders.Referer = proxyConfig.referer;
    if (proxyConfig.userAgent) upstreamHeaders['User-Agent'] = proxyConfig.userAgent;
    const rangeHeader = c.req.header('range');
    if (rangeHeader) upstreamHeaders.Range = rangeHeader;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proxyConfig.timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetch(verified.url, {
        method: 'GET',
        headers: upstreamHeaders,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ err, url: verified.url }, '[stream-proxy-native] upstream fetch failed');
      return c.json({ error: 'STREAM_PROXY_UPSTREAM_FAILED' }, 502);
    }
    clearTimeout(timer);

    const upstreamCT = upstream.headers.get('content-type') ?? '';

    // M3U8 path: read text, rewrite URLs to proxy, return new playlist.
    // M3U8 è piccolo (~5-50KB) → buffer OK + necessario rewrite.
    if (
      upstream.status === 200 &&
      (/\.(?:m3u8|m3u)$/u.test(verified.url) || /mpegurl|m3u8/iu.test(upstreamCT))
    ) {
      const text = (await readTextTruncated(upstream, 10 * 1024 * 1024)).text; // M3U8 cap anti-OOM
      if (looksLikeM3u8(text, upstreamCT)) {
        // proxyBase preserva path + scheme + host del request entrante
        const proxyBase = `${url.protocol}//${url.host}${url.pathname}`;
        const rewritten = rewriteM3u(text, {
          baseUrl: upstream.url || verified.url,
          proxyBase,
          secret: proxyConfig.signSecret,
          ttlSec: 7200, // 2h
        });
        return c.body(rewritten, 200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }
      // text/* ma non m3u8: pass-through come-is
      return c.body(text, 200, {
        'Content-Type': upstreamCT || 'text/plain',
        'Cache-Control': 'no-store',
      });
    }

    // Binary streaming pass-through (Range support nativo).
    // upstream.body è ReadableStream<Uint8Array> — pipiamo direct.
    const responseHeaders: Record<string, string> = {
      'Content-Type': upstreamCT || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) responseHeaders['Accept-Ranges'] = acceptRanges;

    if (!upstream.body) {
      return new Response(null, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    // Pipe diretto upstream → response. Niente buffer intero in memoria.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  };
}

/**
 * Helper di test — esposta separatamente per unit test del path matching/
 * sign verification senza dover startare Hono e mocking workflow service.
 */
export const __testExports = {
  base64UrlDecode,
  base64UrlEncode,
  computeSig,
  safeStringEqual,
  rewriteM3u,
  looksLikeM3u8,
  findProxyConfig: findProxyConfigJson,
  STREAM_PROXY_RE,
};
