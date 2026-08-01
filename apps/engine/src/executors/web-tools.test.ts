/**
 * Bug-bounty UNIT — executors/web-tools.ts (audit coverage 2026-06-12: 7%).
 * Il service (fetch+SSRF+cheerio) è mockato; si pinna la responsabilità degli
 * executor: validazione, CLAMP del limit [1,20] (anti-abuso del web_search),
 * mapping output, count derivato dai risultati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchUrlMock = vi.fn();
const webSearchMock = vi.fn();
vi.mock('@/services/web-tools.service.js', () => ({
  fetchUrl: (...a: unknown[]) => fetchUrlMock(...a),
  webSearch: (...a: unknown[]) => webSearchMock(...a),
}));

import { fetchUrlExecutor, webSearchExecutor } from './web-tools.js';

const ctx = () => ({
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'action_web', secrets: {}, llmProviders: [], nodeOutputs: {},
}) as unknown as Parameters<typeof fetchUrlExecutor>[2];

beforeEach(() => { fetchUrlMock.mockReset(); webSearchMock.mockReset(); });

describe('fetch_url executor', () => {
  it('url mancante → throw, service mai chiamato', async () => {
    await expect(fetchUrlExecutor({} as never, null as never, ctx())).rejects.toThrow(/url è obbligatorio/);
    expect(fetchUrlMock).not.toHaveBeenCalled();
  });

  it('mapping output completo + null-safe su title/description', async () => {
    fetchUrlMock.mockResolvedValue({
      url: 'http://x.it', finalUrl: 'https://x.it', status: 200, content: 'body',
      contentType: 'text/html', truncated: false, // title/description assenti
    });
    const res = await fetchUrlExecutor({ url: '  http://x.it  ' } as never, null as never, ctx());
    expect(fetchUrlMock).toHaveBeenCalledWith('http://x.it'); // trim
    const o = res.output as { title: unknown; description: unknown; status: number };
    expect(o.title).toBeNull();
    expect(o.description).toBeNull();
    expect(o.status).toBe(200);
  });
});

describe('web_search executor', () => {
  beforeEach(() => {
    webSearchMock.mockResolvedValue({ query: 'q', provider: 'brave', results: [{ t: 1 }, { t: 2 }] });
  });

  it('query mancante → throw', async () => {
    await expect(webSearchExecutor({} as never, null as never, ctx())).rejects.toThrow(/query è obbligatorio/);
  });

  it('limit clampato a [1,20]: 0→1, 999→20, NaN→default 10', async () => {
    await webSearchExecutor({ query: 'q', limit: 0 } as never, null as never, ctx());
    expect(webSearchMock).toHaveBeenLastCalledWith('q', 1);
    await webSearchExecutor({ query: 'q', limit: 999 } as never, null as never, ctx());
    expect(webSearchMock).toHaveBeenLastCalledWith('q', 20);
    await webSearchExecutor({ query: 'q', limit: 'abc' } as never, null as never, ctx());
    expect(webSearchMock).toHaveBeenLastCalledWith('q', 10);
  });

  it('count derivato dal numero REALE di risultati (non dal limit richiesto)', async () => {
    const res = await webSearchExecutor({ query: 'q', limit: 10 } as never, null as never, ctx());
    const o = res.output as { count: number; results: unknown[] };
    expect(o.count).toBe(2); // 2 risultati, anche se limit=10
    expect(o.results).toHaveLength(2);
  });
});
