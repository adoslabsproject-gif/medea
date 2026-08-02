/**
 * `action_asset_batch_download` — NodeModule wrapper.
 *
 * Pairs with `action_recursive_spider` (consume `pages[].links` filtered for
 * asset extensions) and `action_html_mirror_rewrite` (feed `stats.assetMap`
 * back as the URL→localPath map).
 *
 * Input format
 * ────────────
 * `items` accepts EITHER:
 *   - A newline/comma-separated string of URLs (one URL per line/segment); OR
 *   - A pre-built JSON array of `{ url, savePath? }` objects (when the upstream
 *     node already knows where each asset must land).
 *
 * @module web-extraction/asset-batch-download
 */

import type { NodeModule, NodeExecutor } from '../types.js';
// SOLO type (erased dal bundle). L'engine usa node:fs/path/crypto: è caricato
// LAZY nell'executor (await import) così l'editor — che importa il catalogo
// nodi per i metadata — non lo trascina nel bundle browser. Vedi guard
// `nodes-browser-safe.test.ts`.
import type { AssetItem } from './asset-batch-download-engine.js';

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return def;
}

function parseItems(raw: unknown): AssetItem[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry): AssetItem[] => {
      if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) return [{ url: entry }];
      if (entry !== null && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        if (typeof e.url === 'string' && /^https?:\/\//i.test(e.url)) {
          return [
            { url: e.url, ...(typeof e.savePath === 'string' ? { savePath: e.savePath } : {}) },
          ];
        }
      }
      return [];
    });
  }
  if (typeof raw === 'string' && raw.trim()) {
    const tryJson = raw.trim();
    if (tryJson.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(tryJson);
        return parseItems(parsed);
      } catch {
        /* fall through to newline/comma split */
      }
    }
    return raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s))
      .map((url) => ({ url }));
  }
  return [];
}

const executor: NodeExecutor = async (config) => {
  const items = parseItems(config.items);
  if (items.length === 0)
    throw new Error(
      'items required (newline/comma-separated URLs OR JSON array of {url, savePath?})',
    );

  const basePathRaw = String(config.basePath ?? '').trim();
  if (!basePathRaw) throw new Error('basePath required (absolute filesystem path)');
  if (!basePathRaw.startsWith('/'))
    throw new Error('basePath must be an absolute path (start with "/")');

  const start = Date.now();
  // Lazy: l'engine (node:fs/crypto/path) entra nel grafo SOLO a runtime server.
  const { runAssetBatchDownload } = await import('./asset-batch-download-engine.js');
  const result = await runAssetBatchDownload({
    items,
    basePath: basePathRaw,
    userAgent: String(config.userAgent ?? 'FlowForge-AssetFetch/1.0').trim(),
    referer: config.referer ? String(config.referer).trim() : undefined,
    concurrency: clampInt(config.concurrency, 1, 16, 4),
    perHostMinDelayMs: clampInt(config.perHostMinDelayMs, 0, 60_000, 100),
    timeoutMs: clampInt(config.timeoutMs, 1_000, 300_000, 30_000),
    maxAssets: clampInt(config.maxAssets, 1, 50_000, 1_000),
    maxTotalBytes: clampInt(
      config.maxTotalBytes,
      1_024,
      50 * 1024 * 1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxPerAssetBytes: clampInt(
      config.maxPerAssetBytes,
      1_024,
      1024 * 1024 * 1024,
      50 * 1024 * 1024,
    ),
    resumeOnSha256Match: asBool(config.resumeOnSha256Match, true),
  });

  return { output: result, durationMs: Date.now() - start };
};

export const assetBatchDownloadNode: NodeModule = {
  executor,
  def: {
    id: 'action_asset_batch_download',
    type: 'action',
    label: 'Asset Batch Download',
    icon: 'download-cloud',
    color: '#0ea5e9',
    description:
      'Scarica in parallelo array di URL binari (immagini, PDF, video, CSS, JS) e salva su disco preservando il path-tree del sito. Companion di action_recursive_spider per fare un mirror offline. ' +
      'Features: SHA-256 dedup + resume (skip se file esiste con stesso hash), atomic write tmp+rename (no file mezzi-scritti), worker pool bounded, rate-limit per-host, hard cap bytes totali + per-asset (default 1 GiB / 50 MiB), path traversal-safe (rifiuta "..", null bytes, escapes basePath). ' +
      'Output `assetMap` (url→savePath) consumabile direttamente da action_html_mirror_rewrite per riscrivere i link nel HTML offline. ' +
      'Use case: (1) mirror immagini/PDF di un proprio catalogo prodotti, (2) backup di un proprio sito statico, (3) ingest asset per CDN privato, (4) snapshot legale di una pagina (con audit). ' +
      'Safety: SSRF guard, basePath obbligatoriamente assoluto, traversal-safe, hard caps anti-runaway.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'items',
        label: 'URL da scaricare',
        type: 'text',
        required: true,
        placeholder:
          'https://x.com/img/a.png\nhttps://x.com/img/b.jpg\n— OR — JSON [{"url":"...","savePath":"img/a.png"}]',
        help: 'Uno per riga o virgola-separati. In alternativa JSON array di {url, savePath?}. savePath è relativo a basePath; se omesso, derivato da URL.pathname.',
      },
      {
        key: 'basePath',
        label: 'Directory base (assoluta)',
        type: 'text',
        required: true,
        placeholder: '/opt/zeliai/shared/mirror/zelistore.it',
        help: 'Directory dove salvare. DEVE essere assoluta. Verrà creata se non esiste. Tutti i file finiscono dentro questa cartella (traversal-safe).',
      },
      {
        key: 'concurrency',
        label: 'Concorrenza download',
        type: 'number',
        required: false,
        defaultValue: '4',
        help: 'Numero di download paralleli. Default 4. Max 16. Più alto = più veloce ma più aggressivo sul server.',
      },
      {
        key: 'perHostMinDelayMs',
        label: 'Delay minimo per host (ms)',
        type: 'number',
        required: false,
        defaultValue: '100',
        help: 'Pausa minima tra request allo stesso host. Asset = file statici servibili da CDN, default 100ms basso.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout per asset (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help: 'Timeout sulla singola download. Default 30s. Aumenta per video grandi.',
      },
      {
        key: 'maxAssets',
        label: 'Max asset per run',
        type: 'number',
        required: false,
        defaultValue: '1000',
        help: 'Hard cap sul numero di asset scaricati. Default 1000, max 50000.',
      },
      {
        key: 'maxTotalBytes',
        label: 'Max bytes totali',
        type: 'number',
        required: false,
        defaultValue: '1073741824',
        help: 'Hard cap sui bytes totali scaricati nella run. Default 1 GiB. Quando raggiunto, gli asset rimanenti vengono marcati "skipped-cap".',
      },
      {
        key: 'maxPerAssetBytes',
        label: 'Max bytes per asset',
        type: 'number',
        required: false,
        defaultValue: '52428800',
        help: 'Hard cap sulla singola download. Default 50 MiB. Asset più grandi vengono marcati "skipped-cap".',
      },
      {
        key: 'resumeOnSha256Match',
        label: 'Resume su SHA256 esistente',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se ON e il file esiste già su disco, calcola SHA-256 locale e skippa la fetch (risparmia banda). Spegnere per forzare re-download.',
      },
      {
        key: 'referer',
        label: 'Referer (esplicito)',
        type: 'text',
        required: false,
        placeholder: 'https://x.com/',
        help: 'Header Referer da inviare. Alcuni CDN bloccano hotlink senza Referer corretto.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge-AssetFetch/1.0',
        help: 'User-Agent dichiarato. Default RFC-compliant.',
      },
    ],
  },
};
