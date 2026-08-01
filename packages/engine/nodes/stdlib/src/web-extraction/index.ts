/**
 * Web Extraction nodes — Batch 1 (Sprint 2026-05-31).
 *
 * 5 nodi core ispirati a pattern Streammy (extractor VixCloud/MixDrop/
 * StreamTape) ma generici, legali, configurabili UI-grade per scraping
 * LEGITTIMO (monitoraggio propri siti, news aggregation, price monitoring,
 * integrazione siti aziendali).
 *
 * Borderline configurato:
 *  - SSRF block via @flowforge/safe-fetch
 *  - User-Agent "FlowForge/X" di default identifica il bot
 *  - Block-list domini noti pirateria (refresh weekly)
 *  - Rate-limit per nodo (vedi rate-limit middleware)
 *  - Audit log su ogni richiesta
 */

// Batch 1 — Core web extraction
export { webFetchAdvancedNode } from './fetch-advanced.js';
export { htmlSelectNode } from './html-select.js';
export { scriptVarExtractNode } from './script-var-extract.js';
export { regexMultiNode } from './regex-multi.js';
export { urlTemplateNode } from './url-template.js';

// Batch 2 — Browser + UA (AI nodi vivono in ai-agents package)
export { browserRenderNode } from './browser-render.js';
export { browserAutomateNode } from './browser-automate.js';
export { cloudflareSolverNode } from './cloudflare-solver.js';
export { userAgentRotateNode } from './user-agent-rotate.js';

// Batch 3 — Multimedia probing + Feed
export { hlsProbeNode } from './hls-probe.js';
export { dashProbeNode } from './dash-probe.js';
export { videoMetadataNode } from './video-metadata.js';
export { rssFeedTriggerNode } from './rss-feed.js';
export { sitemapCrawlerNode } from './sitemap-crawler.js';

// Batch 4 — KILLER nodes (Sprint 2026-05-31)
// #1 stealth browser (Puppeteer-stealth BYO anti-bot)
// #2 distributed crawler (Redis queue BYO spider)
// #3 vision extract (Qwen2.5-VL-7B locale universal extractor)
// #4 scrape smart (orchestratore AI 4-stage adaptive + LLM extract + pagination)
export { stealthBrowserNode, resolveFingerprint } from './stealth-browser.js';
export { distributedCrawlerNode, buildCrawlerRequest } from './distributed-crawler.js';
export { visionExtractNode, extractJsonFromResponse, buildVisionMessages, VisionExtractOutputSchema } from './vision-extract.js';
export { scrapeSmartNode } from './scrape-smart.js';

// Batch 5 — Streammy port (2026-06-01)
// #5 js-unpack: Dean Edwards eval(p,a,c,k,e,d) deoffuscator pure TS (no eval/VM)
export { jsUnpackNode, unpackJs } from './js-unpack.js';

// Batch 6 — Site mirror trio (Sprint 2026-06-06)
// #1 recursive spider: in-process BFS + robots.txt + rate-limit (no BYO server)
// #2 asset batch download: parallel binary fetch + SHA dedup + atomic write
// #3 html mirror rewrite: rewrite href/src/srcset/url(...) → local paths
export { recursiveSpiderNode } from './recursive-spider.js';
export { assetBatchDownloadNode } from './asset-batch-download.js';
export { htmlMirrorRewriteNode } from './html-mirror-rewrite.js';
