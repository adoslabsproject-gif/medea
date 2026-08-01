/**
 * `action_recursive_spider` — NodeModule wrapper for the in-process spider.
 *
 * The crawl engine lives in `recursive-spider-engine.ts` so the executor here
 * is a thin coercion + clamp layer + NodeDef metadata. See engine module for
 * the safety budget rationale (maxPages cap, robots.txt, rate limit, SSRF).
 *
 * Sibling alternatives in the catalog
 * ───────────────────────────────────
 *   - `action_sitemap_crawler`  — discovery via sitemap.xml only (no graph walk).
 *   - `action_crawler_distributed` — Bring-Your-Own crawler service (Redis,
 *     workers, persistence). Use for >5000 pages or resumable jobs.
 *   - THIS NODE — in-process BFS for the common "mirror this site / discover
 *     its URL graph" workflow up to 5000 pages.
 *
 * @module web-extraction/recursive-spider
 */

import type { NodeModule, NodeExecutor } from '../types.js';
import { runSpider } from './recursive-spider-engine.js';
import { safeUserRegex } from '../lib/safe-user-regex.js';

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

const executor: NodeExecutor = async (config) => {
  const seedsRaw = String(config.seeds ?? '').trim();
  if (!seedsRaw) throw new Error('seeds required (URLs comma/newline separated)');
  const seeds = seedsRaw
    .split(/[,\n]/).map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  if (seeds.length === 0) throw new Error('no valid seed URL (must start with http:// or https://)');

  const allowRaw = String(config.allowDomains ?? '').trim();
  const allowDomains = allowRaw
    ? allowRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : [];

  const denyRaw = String(config.denyPatterns ?? '').trim();
  const denyPatterns: RegExp[] = [];
  for (const p of denyRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    try { denyPatterns.push(safeUserRegex(p)); } catch { /* skip invalid o feature non-RE2 → ignora pattern */ }
  }

  const start = Date.now();
  const result = await runSpider({
    seeds,
    maxDepth: clampInt(config.maxDepth, 0, 50, 3),
    maxPages: clampInt(config.maxPages, 1, 5000, 100),
    sameOriginOnly: asBool(config.sameOriginOnly, true),
    allowDomains,
    denyPatterns,
    userAgent: String(config.userAgent ?? 'FlowForge-Spider/1.0 (+https://flowforge.automazionezeli.com)').trim(),
    perHostMinDelayMs: clampInt(config.perHostMinDelayMs, 0, 60_000, 500),
    concurrency: clampInt(config.concurrency, 1, 16, 4),
    respectRobots: asBool(config.respectRobots, true),
    timeoutMs: clampInt(config.timeoutMs, 1_000, 120_000, 20_000),
  });

  return { output: result, durationMs: Date.now() - start };
};

export const recursiveSpiderNode: NodeModule = {
  executor,
  def: {
    id: 'action_recursive_spider',
    type: 'action',
    label: 'Recursive Spider (in-process)',
    icon: 'spider',
    color: '#7c3aed',
    description:
      'Crawler ricorsivo in-process per discovery URL e mirror sito SENZA hostare un servizio esterno (a differenza di action_crawler_distributed BYO). ' +
      'Esegue una BFS bounded sui seed con dedup Set, depth limit, max-pages hard cap, concurrency worker pool, rate-limit per-host (token bucket) e rispetto robots.txt cache-once-per-host. ' +
      'Output per-pagina: HTML completo (solo text/html), links extracted same-origin filtrabili via allow/deny, status HTTP, content-type, bytes, durata, error. ' +
      'Use case: (1) mirror del proprio sito + asset (combinato con action_asset_batch_download), (2) audit SEO interno (broken links + orphan pages), (3) discovery URL per RAG/embedding internal docs, (4) competitor catalog monitor (USA SOLO su siti propri o con autorizzazione). ' +
      'Safety: hard cap 5000 pagine/run, SSRF guard, robots.txt rispettato di default, identifica come "FlowForge-Spider/1.0" RFC-compliant (override consentito).',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      { key: 'seeds', label: 'Seed URLs', type: 'text', required: true,
        placeholder: 'https://example.com/, https://example.com/blog',
        help: 'Lista URL di partenza separati da virgola o newline. Devono essere http(s)://. Lo spider farà BFS partendo da questi.' },
      { key: 'maxDepth', label: 'Profondità massima', type: 'number', required: false, defaultValue: '3',
        help: 'Quanti livelli di link seguire dai seed. 0 = solo i seed. 3 = seed → click → click → click. Max 50.' },
      { key: 'maxPages', label: 'Pagine massime (hard cap)', type: 'number', required: false, defaultValue: '100',
        help: 'Stop al raggiungimento. Le pagine non visitate restano in `frontier` (output) per resume futuro. Max 5000.' },
      { key: 'sameOriginOnly', label: 'Solo same-origin', type: 'boolean', required: false, defaultValue: 'true',
        help: 'Se ON, i link verso altri host vengono ignorati. Combinare con allowDomains per multi-host controllato.' },
      { key: 'allowDomains', label: 'Domini consentiti (whitelist)', type: 'text', required: false,
        placeholder: 'example.com, sub.example.com',
        help: 'Override di sameOriginOnly: se valorizzato, accetta link verso questi host (anche sotto-domini). Vuoto = solo origin del seed.' },
      { key: 'denyPatterns', label: 'Pattern URL da escludere (regex)', type: 'text', required: false,
        placeholder: '/login, \\.pdf$, /admin/',
        help: 'Regex valutate sull\'URL assoluto. Separati da virgola o newline. Es. "/admin/, /api/, \\.pdf$".' },
      { key: 'concurrency', label: 'Concorrenza (fetch in parallelo)', type: 'number', required: false, defaultValue: '4',
        help: 'Worker simultanei. 1=seriale, 4=default sano per single tenant, max 16. Più alto = più veloce ma più aggressivo sul server target.' },
      { key: 'perHostMinDelayMs', label: 'Delay minimo per host (ms)', type: 'number', required: false, defaultValue: '500',
        help: 'Token bucket per-host: garantisce >= N ms fra due request allo stesso host. 0 = nessun rate limit. Default 500ms = ~2 req/sec.' },
      { key: 'respectRobots', label: 'Rispetta robots.txt', type: 'boolean', required: false, defaultValue: 'true',
        help: 'Fetch /robots.txt una volta per host, applica Disallow + Crawl-Delay. Spegnere SOLO se hai diritti sul target.' },
      { key: 'timeoutMs', label: 'Timeout per pagina (ms)', type: 'number', required: false, defaultValue: '20000',
        help: 'Hard timeout sulla singola fetch. Pagine timeout vanno nei result con error="timeout..." e link=[].' },
      { key: 'userAgent', label: 'User-Agent', type: 'text', required: false,
        placeholder: 'FlowForge-Spider/1.0 (+https://flowforge.automazionezeli.com)',
        help: 'User-Agent dichiarato. Default RFC-compliant. Override SOLO per propri siti che bloccano UA generici.' },
    ],
  },
};
