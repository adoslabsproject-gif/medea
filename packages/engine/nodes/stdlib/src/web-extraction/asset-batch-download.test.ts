/**
 * Tests for the asset batch downloader.
 *
 * Real filesystem under `os.tmpdir()` so atomic-write + resume semantics are
 * verified end-to-end; `safeFetchWithRedirects` is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { deriveLocalPath, runAssetBatchDownload } from './asset-batch-download-engine.js';
import { assetBatchDownloadNode } from './asset-batch-download.js';

vi.mock('@medea/engine-safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
  SsrfBlockedError: class extends Error {},
}));
const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = safeFetchWithRedirects as unknown as ReturnType<typeof vi.fn>;

function bin(buf: Buffer, contentType = 'application/octet-stream'): Response {
  return new Response(buf, { status: 200, headers: { 'content-type': contentType } });
}

let tmpBase = '';
beforeEach(async () => {
  mockedFetch.mockReset();
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-test-'));
});
afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

describe('deriveLocalPath', () => {
  it('maps URL pathname to nested directory', () => {
    const p = deriveLocalPath('https://x.com/a/b/c.png', '/base', path);
    expect(p).toBe('/base/a/b/c.png');
  });
  it('appends index.html for trailing slash', () => {
    expect(deriveLocalPath('https://x.com/', '/base', path)).toBe('/base/index.html');
    expect(deriveLocalPath('https://x.com/about/', '/base', path)).toBe('/base/about/index.html');
  });
  it('URL constructor normalizes traversal — derived path stays inside basePath by construction', () => {
    // Node's URL constructor resolves `..` and `%2E%2E` BEFORE we see the
    // pathname (RFC 3986 §5.2). So `deriveLocalPath` cannot be tricked via
    // the URL — the path-traversal vector is `item.savePath` instead,
    // tested at the engine level (see "rejects unsafe savePath …").
    const p = deriveLocalPath('https://x.com/../etc/passwd', '/base', path);
    expect(p).toBe('/base/etc/passwd');
    expect(p?.startsWith('/base/')).toBe(true);
  });
  it('rejects null bytes', () => {
    expect(deriveLocalPath('https://x.com/a%00b', '/base', path)).toBeNull();
  });
  it('rejects malformed URLs', () => {
    expect(deriveLocalPath('not a url', '/base', path)).toBeNull();
  });
});

describe('runAssetBatchDownload', () => {
  it('downloads + writes to disk + emits assetMap', async () => {
    const png = Buffer.from('PNG-FAKE-BODY-1');
    mockedFetch.mockResolvedValue(bin(png, 'image/png'));
    const r = await runAssetBatchDownload({
      items: [{ url: 'https://x.test/img/logo.png' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: true,
    });
    expect(r.stats.downloaded).toBe(1);
    const onDisk = await fs.readFile(path.join(tmpBase, 'img', 'logo.png'));
    expect(onDisk.toString()).toBe('PNG-FAKE-BODY-1');
    expect(r.stats.assetMap['https://x.test/img/logo.png']).toBe(
      path.join(tmpBase, 'img', 'logo.png'),
    );
  });

  it('skips re-download on second run when file + sha256 match', async () => {
    const body = Buffer.from('STABLE');
    mockedFetch.mockResolvedValue(bin(body, 'image/png'));
    const opts = {
      items: [{ url: 'https://x.test/a.png' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: true,
    };
    const first = await runAssetBatchDownload(opts);
    expect(first.stats.downloaded).toBe(1);
    const second = await runAssetBatchDownload(opts);
    expect(second.stats.downloaded).toBe(0);
    expect(second.stats.skippedExisting).toBe(1);
    // Network only hit once.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('records HTTP errors without aborting the batch', async () => {
    mockedFetch.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('bad')) {
        return new Response('nope', { status: 500 });
      }
      return bin(Buffer.from('ok'), 'text/plain');
    });
    const r = await runAssetBatchDownload({
      items: [{ url: 'https://x.test/bad.png' }, { url: 'https://x.test/good.txt' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: false,
    });
    expect(r.stats.downloaded).toBe(1);
    expect(r.stats.errors).toBe(1);
    expect(r.results.find((x) => x.url.includes('bad'))?.status).toBe('error');
  });

  it('caps total bytes — stops downloading once budget hit', async () => {
    const big = Buffer.alloc(800);
    mockedFetch.mockResolvedValue(bin(big, 'application/octet-stream'));
    const r = await runAssetBatchDownload({
      items: Array.from({ length: 5 }, (_, i) => ({ url: `https://x.test/a${String(i)}.bin` })),
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1500,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: false,
    });
    // Each is 800 bytes, cap is 1500 → first 2 downloads exceed cap.
    expect(r.stats.downloaded).toBeGreaterThanOrEqual(1);
    expect(r.stats.downloaded).toBeLessThanOrEqual(2);
  });

  it('caps per-asset bytes — marks oversized as skipped-cap', async () => {
    const big = Buffer.alloc(5_000);
    mockedFetch.mockResolvedValue(bin(big, 'application/octet-stream'));
    const r = await runAssetBatchDownload({
      items: [{ url: 'https://x.test/big.bin' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024,
      resumeOnSha256Match: false,
    });
    expect(r.stats.skippedCap).toBe(1);
  });

  it('rejects unsafe savePath that escapes basePath via traversal', async () => {
    mockedFetch.mockImplementation(async () => bin(Buffer.from('x'), 'text/plain'));
    // The real traversal vector is user-supplied `savePath` (URL constructor
    // already normalizes URL-based traversal away). `path.resolve` would
    // happily walk outside basePath; the engine catches that with a
    // `startsWith(baseAbs)` guard.
    const r = await runAssetBatchDownload({
      items: [{ url: 'https://x.test/ok.txt', savePath: '../../../etc/passwd' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: false,
    });
    expect(r.results[0]?.status).toBe('error');
    expect(r.results[0]?.error).toMatch(/unsafe path/);
  });

  it('computes SHA-256 correctly', async () => {
    const body = Buffer.from('determinism');
    const expectHash = crypto.createHash('sha256').update(body).digest('hex');
    mockedFetch.mockResolvedValue(bin(body, 'text/plain'));
    const r = await runAssetBatchDownload({
      items: [{ url: 'https://x.test/d.txt' }],
      basePath: tmpBase,
      userAgent: 'test',
      referer: undefined,
      concurrency: 1,
      perHostMinDelayMs: 0,
      timeoutMs: 5000,
      maxAssets: 100,
      maxTotalBytes: 1024 * 1024,
      maxPerAssetBytes: 1024 * 1024,
      resumeOnSha256Match: false,
    });
    expect(r.results[0]?.sha256).toBe(expectHash);
  });
});

describe('assetBatchDownloadNode — NodeModule', () => {
  it('declares correct NodeDef shape', () => {
    expect(assetBatchDownloadNode.def.id).toBe('action_asset_batch_download');
    expect(typeof assetBatchDownloadNode.executor).toBe('function');
  });

  it('rejects relative basePath', async () => {
    await expect(
      assetBatchDownloadNode.executor!(
        { items: 'https://x.com/a.png', basePath: 'relative/dir' },
        {},
        { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
      ),
    ).rejects.toThrow(/absolute path/);
  });

  it('parses newline-separated URLs', async () => {
    // Each fetch must get a fresh Response — the body is single-use stream.
    mockedFetch.mockImplementation(async () => bin(Buffer.from('x')));
    const r = await assetBatchDownloadNode.executor!(
      { items: 'https://x.test/a.txt\nhttps://x.test/b.txt', basePath: tmpBase, concurrency: '1' },
      {},
      { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    );
    const out = r.output as { stats: { downloaded: number } };
    expect(out.stats.downloaded).toBe(2);
  });

  it('parses JSON array of {url, savePath}', async () => {
    mockedFetch.mockResolvedValue(bin(Buffer.from('z')));
    const r = await assetBatchDownloadNode.executor!(
      {
        items: '[{"url":"https://x.test/abc.bin","savePath":"custom/out.bin"}]',
        basePath: tmpBase,
        concurrency: '1',
      },
      {},
      { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    );
    const out = r.output as { stats: { downloaded: number; assetMap: Record<string, string> } };
    expect(out.stats.downloaded).toBe(1);
    expect(out.stats.assetMap['https://x.test/abc.bin']).toContain('custom/out.bin');
  });

  it('throws when items list is empty', async () => {
    await expect(
      assetBatchDownloadNode.executor!(
        { items: '', basePath: tmpBase },
        {},
        { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
      ),
    ).rejects.toThrow(/items required/);
  });
});
