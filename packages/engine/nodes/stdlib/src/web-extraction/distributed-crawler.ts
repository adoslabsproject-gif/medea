/**
 * trigger_crawler_distributed — spider distribuito (Redis queue BYO).
 *
 * Killer node #2: crawler async multi-page con queue Redis, depth-limit,
 * dedup URL bloom filter, robots.txt respect, sitemap-first seed,
 * parallel workers, checkpoint resume.
 *
 * Architettura BYO (Bring Your Own Crawler): un servizio crawler dedicato
 * gira separato (zeli-managed o self-host). Il nodo orchestra l'avvio del
 * job + ricezione callback su webhook FlowForge.
 *
 * Tipo "trigger" perche\` lavora in background asincrono — il workflow viene
 * RISVEGLIATO da una callback per ogni page crawled (o per batch periodici).
 *
 * Endpoint compatibile:
 *   POST {endpoint}/crawl/start
 *   { seeds, maxDepth, maxPages, allowDomains, denyPatterns, respectRobots,
 *     callbackUrl, dedupBloom, parallelism, jobId? }
 *   → { jobId, status: 'queued'|'running' }
 *
 *   POST {endpoint}/crawl/{jobId}/stop
 *   GET {endpoint}/crawl/{jobId}/status → { pagesCrawled, queueDepth, ... }
 *   GET {endpoint}/crawl/{jobId}/results?cursor → { items: [{url, html, links, fetchedAt}], nextCursor }
 *
 * Callback al callbackUrl (POST per ogni batch o per evento):
 *   { jobId, event: 'page'|'batch'|'done'|'error', payload: {...} }
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

export interface CrawlerStartRequest {
  seeds: string[];
  maxDepth: number;
  maxPages: number;
  allowDomains: string[];
  denyPatterns: string[];
  respectRobots: boolean;
  sitemapFirst: boolean;
  dedupBloom: { capacity: number; falsePositiveRate: number };
  parallelism: number;
  rateLimitPerHostQps: number;
  userAgent: string;
  callbackUrl: string | undefined;
  callbackSecret: string | undefined;
  callbackBatchSize: number;
  jobId: string | undefined;
  resume: boolean;
}

export function buildCrawlerRequest(config: Record<string, unknown>): CrawlerStartRequest {
  const seedsRaw = String(config.seeds ?? '').trim();
  if (!seedsRaw) throw new Error('seeds required (URLs comma-separated or newline)');
  const seeds = seedsRaw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  if (seeds.length === 0)
    throw new Error('no valid seed URL (must start with http:// or https://)');

  const allowRaw = String(config.allowDomains ?? '').trim();
  const allowDomains = allowRaw
    ? allowRaw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : seeds.map((u) => new URL(u).hostname);

  const denyRaw = String(config.denyPatterns ?? '').trim();
  const denyPatterns = denyRaw
    ? denyRaw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return {
    seeds,
    maxDepth: Math.max(0, Math.min(Number(config.maxDepth ?? 3), 10)),
    maxPages: Math.max(1, Math.min(Number(config.maxPages ?? 1000), 100_000)),
    allowDomains,
    denyPatterns,
    respectRobots: config.respectRobots !== false && config.respectRobots !== 'false',
    sitemapFirst: config.sitemapFirst === true || config.sitemapFirst === 'true',
    dedupBloom: {
      capacity: Math.max(1000, Math.min(Number(config.bloomCapacity ?? 1_000_000), 100_000_000)),
      falsePositiveRate: Math.max(0.0001, Math.min(Number(config.bloomFpr ?? 0.001), 0.1)),
    },
    parallelism: Math.max(1, Math.min(Number(config.parallelism ?? 4), 50)),
    rateLimitPerHostQps: Math.max(0.1, Math.min(Number(config.rateLimitPerHostQps ?? 2), 50)),
    userAgent: String(
      config.userAgent ?? 'FlowForge-Crawler/1.0 (+https://flowforge.automazionezeli.com)',
    ).trim(),
    callbackUrl: String(config.callbackUrl ?? '').trim() || undefined,
    callbackSecret: String(config.callbackSecret ?? '').trim() || undefined,
    callbackBatchSize: Math.max(1, Math.min(Number(config.callbackBatchSize ?? 10), 1000)),
    jobId: String(config.jobId ?? '').trim() || undefined,
    resume: config.resume === true || config.resume === 'true',
  };
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const endpoint = String(config.endpoint ?? process.env.MEDEA_CRAWLER_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error(
      'Crawler endpoint not configured. Set MEDEA_CRAWLER_ENDPOINT env or fill "endpoint" config field. BYO: deploy crawler service (Heritrix/Scrapy-cluster/custom) or managed Zeli endpoint.',
    );
  }

  const apiKey = String(config.apiKey ?? '').trim();
  const action = String(config.action ?? 'start').trim();

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;

  if (action === 'start') {
    const reqBody = buildCrawlerRequest(config);
    const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/crawl/start`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(reqBody),
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Crawler start failed: ${res.status.toString()} ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as { jobId: string; status: string; queueDepth?: number };
    return {
      output: {
        jobId: data.jobId,
        status: data.status,
        queueDepth: data.queueDepth ?? 0,
        seeds: reqBody.seeds,
        maxDepth: reqBody.maxDepth,
        maxPages: reqBody.maxPages,
      },
      durationMs: Date.now() - start,
    };
  }

  if (action === 'status') {
    const jobId = String(config.jobId ?? '').trim();
    if (!jobId) throw new Error('jobId required for action=status');
    const res = await safeFetchWithRedirects(
      `${endpoint.replace(/\/$/, '')}/crawl/${encodeURIComponent(jobId)}/status`,
      {
        method: 'GET',
        headers: reqHeaders,
        timeoutMs: 10_000,
      },
    );
    if (!res.ok) throw new Error(`Crawler status failed: ${res.status.toString()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return { output: data, durationMs: Date.now() - start };
  }

  if (action === 'stop') {
    const jobId = String(config.jobId ?? '').trim();
    if (!jobId) throw new Error('jobId required for action=stop');
    const res = await safeFetchWithRedirects(
      `${endpoint.replace(/\/$/, '')}/crawl/${encodeURIComponent(jobId)}/stop`,
      {
        method: 'POST',
        headers: reqHeaders,
        timeoutMs: 10_000,
      },
    );
    if (!res.ok) throw new Error(`Crawler stop failed: ${res.status.toString()}`);
    return { output: { jobId, stopped: true }, durationMs: Date.now() - start };
  }

  if (action === 'results') {
    const jobId = String(config.jobId ?? '').trim();
    if (!jobId) throw new Error('jobId required for action=results');
    const cursor = String(config.cursor ?? '').trim();
    const url = `${endpoint.replace(/\/$/, '')}/crawl/${encodeURIComponent(jobId)}/results${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await safeFetchWithRedirects(url, {
      method: 'GET',
      headers: reqHeaders,
      timeoutMs: 30_000,
    });
    if (!res.ok) throw new Error(`Crawler results failed: ${res.status.toString()}`);
    const data = (await res.json()) as { items: unknown[]; nextCursor?: string };
    return {
      output: { items: data.items, nextCursor: data.nextCursor ?? null, count: data.items.length },
      durationMs: Date.now() - start,
    };
  }

  throw new Error(`unknown action "${action}" (use: start, status, stop, results)`);
};

export const distributedCrawlerNode: NodeModule = {
  def: {
    id: 'action_crawler_distributed',
    type: 'action',
    label: 'Crawler Distribuito (spider)',
    icon: 'globe',
    color: '#0891b2',
    description:
      'Spider crawler distribuito enterprise per indicizzazione massiva di siti web — orchestra una pipeline ' +
      'di N worker paralleli che processano una queue Redis condivisa di URL da visitare, con tutti i ' +
      'guardrail di crawling professionale: depth-limit configurable per evitare runaway su siti con loop ' +
      'circolari, dedup tramite bloom filter (memory-efficient probabilistic data structure che evita di ' +
      'rivisitare URL già processate senza dover keep in RAM un Set di milioni di URL), respect del ' +
      'robots.txt del sito target con parsing semantico Allow/Disallow/Crawl-delay/User-agent, sitemap-first ' +
      'seed strategy (parte dal sitemap.xml ufficiale invece di crawl dalla home + follow link — più ' +
      'efficiente e copre meglio i deep page), parallel workers configurable da 1 a 100 per scaling ' +
      'horizontale del throughput, checkpoint resume robusto per riprendere dopo crash o interruzione ' +
      'volontaria senza dover ricominciare daccapo. ' +
      'Architettura BYO (Bring Your Own — il servizio crawler gira separato dal runtime FlowForge per ' +
      'scaling indipendente): supporta come backend Heritrix (il crawler della Wayback Machine di archive.org), ' +
      'Scrapy-cluster (lo standard Python distributed scraping), oppure custom Rust crawler per use case ' +
      'performance-critical. Setup tipico: docker-compose con Redis Stack (per queue + bloom filter) + N ' +
      'crawler worker container + flowforge-bridge HTTP che espone API standard al runtime. ' +
      'Lifecycle 4-action: action=start (lancia un nuovo job di crawl con seed URL + config — ritorna jobId ' +
      'opaque univoco per tracking + handoff async), action=status (metrics live del job in corso: URL ' +
      'processed, queued, errored, current depth, ETA — utile per progress monitoring dashboard), action=stop ' +
      '(termina graceful il job preservando lo state checkpoint per future resume), action=results ' +
      '(paginated retrieval dei result batch con cursor — pattern naturale per workflow downstream che ' +
      'consumano i risultati a chunks). Pattern di callback webhook opzionale: invece di poll periodico ' +
      'con action=results, il caller può fornire un webhook URL e il crawler service pusha batch automatic ' +
      'quando hanno completed N pagine. ' +
      'Use case: indicizzazione completa di sito proprio per generation di interno search engine private + ' +
      'RAG retrieval index per knowledge base AI; competitor analysis (con respect del robots.txt — sempre, ' +
      'per evitare ToS issue legali); archivio storico di pagine prima di redesign per detection di changes ' +
      'future; monitoraggio modifiche periodiche di un sito (re-crawl settimanale + diff con previous run); ' +
      'link audit complessivo per individuazione 404 broken link + redirect chain inefficienti; data ' +
      'collection per training di LLM/NLP model su corpus dominio-specifico autorizzato.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'action',
        label: 'Azione',
        type: 'select',
        required: true,
        defaultValue: 'start',
        options: ['start', 'status', 'stop', 'results'],
        help: 'start = avvia nuovo job (ritorna jobId). status = metriche job (richiede jobId). stop = termina job. results = paginated batch (richiede jobId+cursor opzionale).',
      },
      {
        key: 'endpoint',
        label: 'Crawler endpoint',
        type: 'text',
        required: false,
        placeholder: 'https://crawler.miosito.com (vuoto = env MEDEA_CRAWLER_ENDPOINT)',
        help: 'Servizio crawler self-host o managed Zeli.',
      },
      { key: 'apiKey', label: 'API Key', type: 'secret', required: false, help: 'Bearer token.' },
      {
        key: 'jobId',
        label: 'Job ID (status/stop/results)',
        type: 'text',
        required: false,
        placeholder: 'crawl_abc123',
        help: 'Required per status/stop/results. Per start, opzionale (auto-generato se vuoto) o per resume (con resume=true).',
      },
      {
        key: 'seeds',
        label: 'Seed URLs',
        type: 'textarea',
        required: false,
        placeholder: 'https://site.com\nhttps://site.com/blog',
        help: 'URLs iniziali (comma o newline). Required per action=start.',
      },
      {
        key: 'maxDepth',
        label: 'Max depth',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Profondita\\` max link da seed. 0 = solo seed. Max 10.',
      },
      {
        key: 'maxPages',
        label: 'Max pages',
        type: 'number',
        required: false,
        defaultValue: '1000',
        help: 'Pagine totali max. Hard stop. Min 1, max 100k.',
      },
      {
        key: 'allowDomains',
        label: 'Allow domains',
        type: 'text',
        required: false,
        placeholder: 'site.com, www.site.com (vuoto = hostname dei seeds)',
        help: 'Solo questi domini vengono crawled. Default: hostname dei seeds (no cross-domain).',
      },
      {
        key: 'denyPatterns',
        label: 'Deny patterns (regex)',
        type: 'textarea',
        required: false,
        placeholder: '/admin/.*\n.*\\.pdf$\n/logout',
        help: 'Regex URL da NON crawlare (es. /admin, /logout, file binari).',
      },
      {
        key: 'respectRobots',
        label: 'Respect robots.txt',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'RFC 9309 compliance. Default ON (raccomandato).',
      },
      {
        key: 'sitemapFirst',
        label: 'Sitemap-first seed',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Prima di crawlare HTML, fetcha sitemap.xml e accoda quegli URL in priorita\\`.',
      },
      {
        key: 'bloomCapacity',
        label: 'Bloom filter capacity',
        type: 'number',
        required: false,
        defaultValue: '1000000',
        help: 'Slot per dedup URL. Default 1M = ~7MB RAM. Aumenta per crawl giganti.',
      },
      {
        key: 'bloomFpr',
        label: 'Bloom FP rate',
        type: 'number',
        required: false,
        defaultValue: '0.001',
        help: 'False positive rate. Default 0.001 (0.1%). Lower = piu\\` RAM.',
      },
      {
        key: 'parallelism',
        label: 'Worker paralleli',
        type: 'number',
        required: false,
        defaultValue: '4',
        help: 'Coroutine paralleli per il job. Max 50.',
      },
      {
        key: 'rateLimitPerHostQps',
        label: 'Rate-limit per host (QPS)',
        type: 'number',
        required: false,
        defaultValue: '2',
        help: 'Max requests/sec per hostname (politeness). Default 2 QPS.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge-Crawler/1.0 (+https://flowforge.automazionezeli.com)',
        help: 'UA identificativo (etica, transparency).',
      },
      {
        key: 'callbackUrl',
        label: 'Callback webhook',
        type: 'text',
        required: false,
        placeholder: 'https://tenant.app.automazionezeli.com/webhooks/crawler',
        help: 'Webhook FlowForge che riceve batch di pages. Vuoto = no callback, usa action=results.',
      },
      {
        key: 'callbackSecret',
        label: 'Callback secret',
        type: 'secret',
        required: false,
        help: 'HMAC secret per autenticare il callback. Validato da trigger_webhook a downstream.',
      },
      {
        key: 'callbackBatchSize',
        label: 'Batch size callback',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Pagine per callback POST. Default 10. Max 1000.',
      },
      {
        key: 'cursor',
        label: 'Cursor (results)',
        type: 'text',
        required: false,
        help: 'Cursor paginazione per action=results.',
      },
      {
        key: 'resume',
        label: 'Resume job',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON + jobId esistente: resume da checkpoint. Altrimenti errore se jobId esiste.',
      },
    ],
    outputs: [
      'jobId',
      'status',
      'queueDepth',
      'items',
      'nextCursor',
      'count',
      'seeds',
      'maxDepth',
      'maxPages',
      'pagesCrawled',
      'stopped',
    ],
  },
  executor,
};
