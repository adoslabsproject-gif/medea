/**
 * Bug-bounty UNIT — executors/company-search.ts (file era SENZA test; colmato
 * in Fase 1b #13). Il service è mockato; si pinna la RESPONSABILITÀ
 * dell'executor: seedPrompt obbligatorio, parsing opzioni difensivo
 * (numeri rotti → default), propagazione tenantId, mapping output completo
 * e il NUOVO campo standard `_llm` (da result.llm_usage, solo se presente).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMock = vi.fn();
vi.mock('@/services/company-search.service.js', () => ({
  companySearch: (...a: unknown[]) => searchMock(...a),
}));

import { companySearchExecutor } from './company-search.js';

const ctx = (tenantId = 'tenant-x') =>
  ({
    workflowId: 'wf',
    runId: 'r',
    nodeId: 'n',
    tenantId,
    userId: 'u',
    defId: 'action_company_search',
    secrets: {},
    llmProviders: [],
    nodeOutputs: {},
  }) as unknown as Parameters<typeof companySearchExecutor>[2];

const run = (config: Record<string, unknown>) =>
  companySearchExecutor(config as never, null as never, ctx());

const BASE_RESULT = {
  companies: [
    {
      url: 'https://acme.it/',
      domain: 'acme.it',
      title: 'Acme',
      snippet: 's',
      source_provider: 'ddg',
      matched_query: 'seed',
      boost_factors: [],
    },
  ],
  queries_used: ['seed'],
  queries_generated_by_llm: false,
  total_raw_results: 1,
  filtered_directory: 0,
  filtered_validation: 0,
  took_ms: 5,
};

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue(BASE_RESULT);
});

describe('company-search — validazione + opzioni', () => {
  it('seedPrompt mancante → throw, service NON chiamato', async () => {
    await expect(run({})).rejects.toThrow(/seedPrompt è obbligatorio/);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('maxResults non numerico → default 20 (parsing difensivo)', async () => {
    await run({ seedPrompt: 'seed', maxResults: 'boh' });
    expect((searchMock.mock.calls[0]![1] as { maxResults: number }).maxResults).toBe(20);
  });

  it('tenantId dal context propagato al service (serve al llmResolver)', async () => {
    await run({ seedPrompt: 'seed' });
    expect((searchMock.mock.calls[0]![1] as { tenantId?: string }).tenantId).toBe('tenant-x');
  });
});

describe('company-search — mapping output', () => {
  it('campi base mappati + urls derivato + count', async () => {
    const res = await run({ seedPrompt: 'seed' });
    const o = res.output as Record<string, unknown>;
    expect(o.urls).toEqual(['https://acme.it/']);
    expect(o.count).toBe(1);
    expect(o.llm_provider).toBeNull();
    expect('_llm' in o).toBe(false);
  });

  // Fase 1b (#13): llm_usage del service → campo standard _llm del nodo.
  it('result con llm_usage → output._llm {inputTokens,outputTokens,model,provider,fromApi}', async () => {
    searchMock.mockResolvedValue({
      ...BASE_RESULT,
      queries_generated_by_llm: true,
      llm_provider: 'liara',
      llm_model: 'nha-v1',
      llm_usage: { input: 40, output: 12, fromApi: true },
    });
    const res = await run({ seedPrompt: 'seed' });
    expect((res.output as { _llm: unknown })._llm).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      model: 'nha-v1',
      provider: 'liara',
      fromApi: true,
    });
  });

  it('llm_usage presente ma llm_model assente → model fallback "<provider>-default"', async () => {
    searchMock.mockResolvedValue({
      ...BASE_RESULT,
      llm_provider: 'liara',
      llm_usage: { input: 1, output: 1, fromApi: false },
    });
    const res = await run({ seedPrompt: 'seed' });
    expect((res.output as { _llm: { model: string } })._llm.model).toBe('liara-default');
  });
});
