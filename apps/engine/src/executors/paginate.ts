import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

function getNested(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseLinkHeader(header: string): string | null {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header);
  return match ? (match[1] ?? null) : null;
}

const DEFAULT_MAX_ITEMS = 50_000;
const DEFAULT_MAX_DURATION_MS = 300_000; // 5 minuti
const MAX_429_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Fetch con gestione 429: rispetta Retry-After (capped) e ritenta la STESSA pagina. */
async function fetchWithRetry(
  url: string,
  method: string,
  headers: Record<string, string>,
): Promise<{ res: Response; requests: number }> {
  let requests = 0;
  let res = await safeOutboundFetch(url, { method, headers });
  requests += 1;
  let retries = 0;
  while (res.status === 429 && retries < MAX_429_RETRIES) {
    const raSec = Number(res.headers.get('retry-after'));
    const waitMs = Math.min(
      Number.isFinite(raSec) && raSec > 0 ? raSec * 1000 : 1000,
      MAX_RETRY_AFTER_MS,
    );
    await sleep(waitMs);
    res = await safeOutboundFetch(url, { method, headers });
    requests += 1;
    retries += 1;
  }
  return { res, requests };
}

export const paginateExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const urlTemplate = typeof config.urlTemplate === 'string' ? config.urlTemplate : '';
  const method = typeof config.method === 'string' ? config.method.toUpperCase() : 'GET';
  const strategy = typeof config.pageStrategy === 'string' ? config.pageStrategy : 'page-number';
  const dataPath = typeof config.dataPath === 'string' ? config.dataPath : '';
  const cursorPath = typeof config.cursorPath === 'string' ? config.cursorPath : '';
  const maxPages = Number(config.maxPages ?? 100);
  const limit = Math.max(1, Number(config.limit ?? 50));
  const maxItems = Math.max(1, Number(config.maxItems ?? DEFAULT_MAX_ITEMS));
  const maxDurationMs = Math.max(1_000, Number(config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS));

  if (!urlTemplate) throw new Error('logic_paginate: missing urlTemplate');

  let headers: Record<string, string> = {};
  const headersJson = config.headersJson;
  if (typeof headersJson === 'string' && headersJson.trim() !== '') {
    try {
      const parsed = JSON.parse(headersJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      throw new Error('logic_paginate: headersJson invalid');
    }
  }

  const allItems: unknown[] = [];
  let page = 1;
  let offset = 0;
  let cursor = '';
  let finalCursor: string | null = null;
  let nextUrl = '';
  let requestsCount = 0;
  let truncated = false;

  while (page <= maxPages) {
    // Cap di durata totale: una API che pagina all'infinito non deve bloccare il run.
    if (Date.now() - start > maxDurationMs) {
      truncated = true;
      break;
    }

    let url: string;
    if (strategy === 'link-header' && nextUrl) {
      url = nextUrl;
    } else if (strategy === 'cursor') {
      url = urlTemplate.replace(/\{\{cursor\}\}/g, encodeURIComponent(cursor));
    } else if (strategy === 'offset-limit') {
      url = urlTemplate
        .replace(/\{\{offset\}\}/g, offset.toString())
        .replace(/\{\{limit\}\}/g, limit.toString());
    } else {
      url = urlTemplate.replace(/\{\{page\}\}/g, page.toString());
    }

    const { res, requests } = await fetchWithRetry(url, method, headers);
    requestsCount += requests;
    if (!res.ok)
      throw new Error(
        `paginate ${String(res.status)}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 300)}`,
      );
    const body: unknown = await readJsonCapped<unknown>(res);
    const items: unknown = dataPath ? getNested(body, dataPath) : body;
    const itemsArr: unknown[] = Array.isArray(items) ? items : [];
    // loop, NON allItems.push(...itemsArr): una pagina con un array enorme → RangeError.
    for (const it of itemsArr) {
      if (allItems.length >= maxItems) {
        truncated = true;
        break;
      }
      allItems.push(it);
    }
    if (truncated) break;

    if (strategy === 'link-header') {
      const linkHeader = res.headers.get('link') ?? '';
      const next = parseLinkHeader(linkHeader);
      if (!next) break;
      nextUrl = next;
    } else if (strategy === 'cursor') {
      const next = cursorPath ? getNested(body, cursorPath) : null;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
      finalCursor = next;
    } else if (strategy === 'offset-limit') {
      // Stop quando la pagina è incompleta (< limit) o vuota: niente altri dati.
      if (itemsArr.length < limit) break;
      offset += limit;
    } else {
      if (itemsArr.length === 0) break;
      page += 1;
      continue;
    }
    page += 1;
  }
  if (page > maxPages) truncated = true;

  return {
    output: {
      items: allItems,
      pages: page,
      totalCount: allItems.length,
      requestsCount,
      truncated,
      finalCursor,
    },
    durationMs: Date.now() - start,
  };
};
