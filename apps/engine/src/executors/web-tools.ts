/**
 * Server-side executors per i nodi action_fetch_url e action_web_search.
 *
 * Riusano il service `web-tools.service.ts` (stesso codice usato dai tool
 * della chat AI). Single source of truth: il comportamento dell'AI Chat e
 * il comportamento dei nodi workflow è IDENTICO — niente divergenze
 * fra "tool della chat" e "nodi del workflow".
 *
 * I NodeDef stanno in packages/nodes/stdlib/src/actions/web-tools.ts
 * (browser-safe), gli executor invocano il service Node-only (cheerio,
 * fetch streaming, SSRF guard).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { fetchUrl, webSearch } from '@/services/web-tools.service.js';

export const fetchUrlExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = coerceString(config.url ?? '').trim();
  if (!url) {
    throw new Error('action_fetch_url: config.url è obbligatorio');
  }
  const result = await fetchUrl(url);
  return {
    output: {
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      title: result.title ?? null,
      description: result.description ?? null,
      content: result.content,
      contentType: result.contentType,
      truncated: result.truncated,
    },
    durationMs: Date.now() - start,
  };
};

export const webSearchExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const query = coerceString(config.query ?? '').trim();
  if (!query) {
    throw new Error('action_web_search: config.query è obbligatorio');
  }
  const limitRaw = Number(config.limit ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw))) : 10;
  const result = await webSearch(query, limit);
  return {
    output: {
      query: result.query,
      provider: result.provider,
      results: result.results,
      count: result.results.length,
    },
    durationMs: Date.now() - start,
  };
};
