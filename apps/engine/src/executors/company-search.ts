/**
 * Server-side executor per `action_company_search`.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { logLlmExchange } from '@medea/engine-nodes-stdlib';
import { companySearch } from '@/services/company-search.service.js';

export const companySearchExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const seedPrompt = coerceString(config.seedPrompt ?? '').trim();
  if (!seedPrompt) {
    throw new Error('action_company_search: config.seedPrompt è obbligatorio');
  }

  const opts: Parameters<typeof companySearch>[1] = {
    maxResults: parseNum(config.maxResults, 20),
    queryExpansionCount: parseNum(config.queryExpansionCount, 5),
    skipLLMExpansion: parseBool(config.skipLLMExpansion, false),
    validateTimeoutMs: parseNum(config.validateTimeoutMs, 5000),
  };
  const country = coerceString(config.country ?? '').trim();
  if (country) opts.country = country;
  const requireKeyword = coerceString(config.requireKeyword ?? '').trim();
  if (requireKeyword) opts.requireKeyword = requireKeyword;
  const extra = coerceString(config.extraBlocklist ?? '').trim();
  if (extra) opts.extraBlocklist = extra.split(/[,;\s]+/).filter((s) => s.length > 0);

  // Tenant per LLM resolver
  const tenantId = (context as { tenantId?: string })?.tenantId;
  if (tenantId) opts.tenantId = tenantId;

  const result = await companySearch(seedPrompt, opts);

  // Fase 3 (#15): prompt+risposta della query expansion → StepLog 'llm'
  // (NON nell'output del nodo: è telemetria, non dato del workflow).
  if (result.llm_exchange) {
    logLlmExchange(context, {
      provider: result.llm_provider ?? 'liara',
      model: result.llm_model ?? `${result.llm_provider ?? 'liara'}-default`,
      system: result.llm_exchange.system,
      user: result.llm_exchange.user,
      response: result.llm_exchange.response,
      phase: 'query-expansion',
    });
  }

  return {
    output: {
      companies: result.companies,
      // Flat array di URL per uso semplice in JSONata downstream
      urls: result.companies.map((c) => c.url),
      queries_used: result.queries_used,
      queries_generated_by_llm: result.queries_generated_by_llm,
      llm_provider: result.llm_provider ?? null,
      total_raw_results: result.total_raw_results,
      filtered_directory: result.filtered_directory,
      filtered_validation: result.filtered_validation,
      took_ms: result.took_ms,
      count: result.companies.length,
      // Fase 1b (#13): usage standard cross-nodo. Presente SOLO se la query
      // expansion LLM è davvero avvenuta (skipLLM/no-provider → nessun token speso).
      ...(result.llm_usage !== undefined ? {
        _llm: {
          inputTokens: result.llm_usage.input,
          outputTokens: result.llm_usage.output,
          model: result.llm_model ?? `${result.llm_provider ?? 'liara'}-default`,
          provider: result.llm_provider ?? 'liara',
          fromApi: result.llm_usage.fromApi,
        },
      } : {}),
    },
    durationMs: Date.now() - start,
  };
};

function parseNum(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(coerceString(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = coerceString(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
}
