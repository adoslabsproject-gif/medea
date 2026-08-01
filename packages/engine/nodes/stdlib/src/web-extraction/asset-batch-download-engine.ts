/**
 * Asset batch downloader — pure engine.
 *
 * What this does
 * ──────────────
 * Take a list of URLs (images, PDFs, JS/CSS, anything binary) and download
 * them to disk preserving the URL path-tree. The "scrape your own site
 * offline" companion for `action_recursive_spider`:
 *
 *   spider → [pages with HTML + extracted asset URLs]
 *       ↓
 *   asset_batch_download → /opt/mirror/zelistore.it/
 *                            ├── index.html
 *                            ├── assets/img/logo.png
 *                            ├── assets/css/main.css
 *                            └── ...
 *
 * Design choices that matter
 * ──────────────────────────
 *   - SHA-256 dedup + resume: if the target file exists AND its sha256
 *     matches, we skip the network call entirely. Re-running the workflow
 *     on the same site is cheap.
 *   - Atomic writes: download to `<target>.tmp-<runId>`, then rename. Crash
 *     mid-download never leaves a half file in place.
 *   - Worker pool with bounded concurrency: same pattern as the spider, so
 *     per-host rate limit applies symmetrically.
 *   - Per-host rate limit token bucket: prevents asset downloads from
 *     hammering the origin server (which the spider is already polite to).
 *   - Output is a single array of result records — easy to feed into
 *     `action_html_mirror_rewrite` as the assetMap source.
 *
 * Safety budget
 * ─────────────
 *   - `maxAssets` hard cap.
 *   - `maxTotalBytes` cumulative cap (default 1 GiB) — stop after.
 *   - `maxPerAssetBytes` (default 50 MiB) — protect against accidental
 *     binary blobs.
 *   - `basePath` MUST be an absolute path; never a relative one (we don't
 *     guess the cwd of the runtime container).
 *   - SSRF via `@flowforge/safe-fetch`.
 *
 * @module web-extraction/asset-batch-download-engine
 */

import { safeFetchWithRedirects } from '@flowforge/safe-fetch';

// node:* LAZY (regola stdlib: import statico node:* rompe il bundle Vite editor).
// Caricati una sola volta in runAssetBatchDownload (async) e iniettati dove servono
// — così le funzioni restano testabili e l'engine non finisce nel bundle browser.
type PathModule = typeof import('node:path');
type FsModule = typeof import('node:fs/promises');
type CryptoModule = typeof import('node:crypto');

// ─── Path safety ────────────────────────────────────────────────────────────

const ILLEGAL_SEGMENTS = new Set(['..', '']);

/**
 * Derive a safe filesystem path from a URL's pathname, joined under `basePath`.
 * Rejects traversal (`..`), null bytes, and ensures the resolved path is
 * still inside `basePath` (defence in depth against URL trickery).
 *
 * Trailing-slash URLs map to `<dir>/index.html` so a fresh
 * `https://example.com/` produces `<basePath>/index.html`.
 */
/**
 * H4 — `target` è DENTRO `baseAbs`? Uguale a baseAbs oppure sotto, con BOUNDARY di
 * separatore: un semplice `startsWith(baseAbs)` accetterebbe una dir SORELLA
 * (`/data/t1-evil` inizia per `/data/t1`) → scrittura fuori dalla dir autorizzata.
 * Helper PURO condiviso da `deriveLocalPath` E dal caller (anti ri-divergenza).
 */
export function isPathWithinBase(target: string, baseAbs: string, sep: string): boolean {
  return target === baseAbs || target.startsWith(baseAbs + sep);
}

export function deriveLocalPath(rawUrl: string, basePath: string, pathMod: PathModule): string | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return null; }
  const pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname.includes('\0')) return null;
  const segments = pathname.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (ILLEGAL_SEGMENTS.has(seg)) return null;
  }
  // `/` or `/foo/` (trailing slash) → suffix with `index.html`.
  const last = segments[segments.length - 1];
  const needsIndex = !last || pathname.endsWith('/');
  const finalSegments = needsIndex ? [...segments, 'index.html'] : segments;
  const target = pathMod.resolve(basePath, ...finalSegments);
  const baseAbs = pathMod.resolve(basePath);
  if (!isPathWithinBase(target, baseAbs, pathMod.sep)) return null;
  return target;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface AssetItem { url: string; savePath?: string }

export interface AssetDownloadOptions {
  items: readonly AssetItem[];
  basePath: string;
  userAgent: string;
  referer: string | undefined;
  concurrency: number;
  perHostMinDelayMs: number;
  timeoutMs: number;
  maxAssets: number;
  maxTotalBytes: number;
  maxPerAssetBytes: number;
  resumeOnSha256Match: boolean;
}

export interface AssetResult {
  url: string;
  savePath: string;
  contentType: string;
  bytes: number;
  sha256: string;
  status: 'downloaded' | 'skipped-existing' | 'skipped-cap' | 'error';
  error: string | null;
  fetchedAt: string;
  durationMs: number;
}

interface BatchResult {
  results: AssetResult[];
  stats: {
    downloaded: number;
    skippedExisting: number;
    skippedCap: number;
    errors: number;
    totalBytes: number;
    durationMsTotal: number;
    /** Map url → savePath, ready for `action_html_mirror_rewrite.assetMap`. */
    assetMap: Record<string, string>;
  };
}

async function existingSha256(filepath: string, fsMod: FsModule, cryptoMod: CryptoModule): Promise<string | null> {
  try {
    const buf = await fsMod.readFile(filepath);
    return cryptoMod.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

export async function runAssetBatchDownload(opts: AssetDownloadOptions): Promise<BatchResult> {
  const start = Date.now();
  const results: AssetResult[] = [];
  const hostNextSlot = new Map<string, number>();
  let totalBytes = 0;
  let downloaded = 0, skippedExisting = 0, skippedCap = 0, errors = 0;

  // node:* caricati UNA volta qui (async) e usati nelle closure sotto.
  const [pathMod, fsMod, cryptoMod] = await Promise.all([
    import('node:path'), import('node:fs/promises'), import('node:crypto'),
  ]);

  await fsMod.mkdir(opts.basePath, { recursive: true });
  const baseAbs = pathMod.resolve(opts.basePath);

  const queue = opts.items.slice(0, opts.maxAssets);
  const queueIdx = { i: 0 };

  async function downloadOne(item: AssetItem): Promise<void> {
    const t0 = Date.now();
    const derived = item.savePath
      ? pathMod.resolve(baseAbs, item.savePath)
      : deriveLocalPath(item.url, baseAbs, pathMod);
    // H4 — boundary check con SEPARATORE (helper condiviso con deriveLocalPath):
    // `startsWith(baseAbs)` da solo accetta una dir SORELLA (`/data/t1-evil` inizia per
    // `/data/t1`) → un `item.savePath` ostile (`../t1-evil/x`) scriverebbe FUORI dalla dir.
    if (!derived || !isPathWithinBase(derived, baseAbs, pathMod.sep)) {
      results.push({
        url: item.url, savePath: '', contentType: '', bytes: 0, sha256: '',
        status: 'error', error: 'unsafe path (traversal or non-absolute base)',
        fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      }); errors++; return;
    }

    // Pre-budget check — must run BEFORE the network call.
    if (totalBytes >= opts.maxTotalBytes) {
      results.push({
        url: item.url, savePath: derived, contentType: '', bytes: 0, sha256: '',
        status: 'skipped-cap', error: null, fetchedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
      }); skippedCap++; return;
    }

    // Resume: skip if file already exists and `resumeOnSha256Match` is on.
    if (opts.resumeOnSha256Match) {
      const existingHash = await existingSha256(derived, fsMod, cryptoMod);
      if (existingHash) {
        const stat = await fsMod.stat(derived).catch(() => null);
        results.push({
          url: item.url, savePath: derived, contentType: '',
          bytes: stat?.size ?? 0, sha256: existingHash,
          status: 'skipped-existing', error: null,
          fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
        }); skippedExisting++; return;
      }
    }

    // Per-host rate limit.
    let host = '';
    try { host = new URL(item.url).host; } catch {/* ignore */}
    const now = Date.now();
    const nextSlot = hostNextSlot.get(host) ?? 0;
    if (nextSlot > now) await new Promise<void>((r) => setTimeout(r, nextSlot - now));
    hostNextSlot.set(host, Date.now() + opts.perHostMinDelayMs);

    try {
      const headers: Record<string, string> = { 'User-Agent': opts.userAgent, Accept: '*/*' };
      if (opts.referer) headers.Referer = opts.referer;
      // maxResponseBytes onora il budget per-asset: il body-read è cappato a
      // maxPerAssetBytes DALLA Response stessa (streaming, RangeError oltre) →
      // un asset enorme non viene mai bufferizzato per intero (anti-OOM).
      const res = await safeFetchWithRedirects(item.url, {
        method: 'GET', headers, timeoutMs: opts.timeoutMs, maxResponseBytes: opts.maxPerAssetBytes,
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      let buf: Buffer;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (capErr) {
        if (capErr instanceof RangeError) {
          results.push({
            url: item.url, savePath: derived, contentType: res.headers.get('content-type') ?? '',
            bytes: opts.maxPerAssetBytes, sha256: '',
            status: 'skipped-cap', error: `asset oltre maxPerAssetBytes (${String(opts.maxPerAssetBytes)})`,
            fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
          }); skippedCap++; return;
        }
        throw capErr;
      }
      // Difesa anche quando il body NON è cappato dal proxy (es. Response mock o
      // cap più alto): scarta gli asset oltre il budget per-asset.
      if (buf.byteLength > opts.maxPerAssetBytes) {
        results.push({
          url: item.url, savePath: derived, contentType: res.headers.get('content-type') ?? '',
          bytes: buf.byteLength, sha256: '',
          status: 'skipped-cap', error: `bytes ${String(buf.byteLength)} > maxPerAssetBytes`,
          fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
        }); skippedCap++; return;
      }
      const sha = cryptoMod.createHash('sha256').update(buf).digest('hex');
      await fsMod.mkdir(pathMod.dirname(derived), { recursive: true });
      const tmp = `${derived}.tmp-${cryptoMod.randomBytes(4).toString('hex')}`;
      await fsMod.writeFile(tmp, buf);
      await fsMod.rename(tmp, derived);
      totalBytes += buf.byteLength; downloaded++;
      results.push({
        url: item.url, savePath: derived,
        contentType: res.headers.get('content-type') ?? '',
        bytes: buf.byteLength, sha256: sha,
        status: 'downloaded', error: null,
        fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      });
    } catch (e) {
      errors++;
      results.push({
        url: item.url, savePath: derived, contentType: '', bytes: 0, sha256: '',
        status: 'error', error: e instanceof Error ? e.message : String(e),
        fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      });
    }
  }

  const inflight = new Set<Promise<void>>();
  while (queueIdx.i < queue.length || inflight.size > 0) {
    while (inflight.size < opts.concurrency && queueIdx.i < queue.length && totalBytes < opts.maxTotalBytes) {
      const item = queue[queueIdx.i++]!;
      const task = downloadOne(item).finally(() => { inflight.delete(task); });
      inflight.add(task);
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight);
  }
  await Promise.allSettled([...inflight]);

  const assetMap: Record<string, string> = {};
  for (const r of results) {
    if (r.status === 'downloaded' || r.status === 'skipped-existing') {
      assetMap[r.url] = r.savePath;
    }
  }

  return {
    results,
    stats: { downloaded, skippedExisting, skippedCap, errors, totalBytes, durationMsTotal: Date.now() - start, assetMap },
  };
}
