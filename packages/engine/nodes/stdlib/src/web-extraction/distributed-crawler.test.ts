/**
 * Test reali per distributed-crawler. NO smoke fake.
 * Asseriscono: parsing seed multi-format, dedup config bloom params,
 * action routing, status/results parsing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { distributedCrawlerNode, buildCrawlerRequest } from './distributed-crawler.js';

vi.mock('@medea/engine-safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {}, llmProviders: {} } as const;

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.MEDEA_CRAWLER_ENDPOINT;
});

describe('buildCrawlerRequest', () => {
  it('seeds vuoti → throw', () => {
    expect(() => buildCrawlerRequest({})).toThrow(/seeds required/);
  });

  it('seeds invalidi (no http) → throw "no valid seed URL"', () => {
    expect(() => buildCrawlerRequest({ seeds: 'foo, bar' })).toThrow(/no valid seed URL/);
  });

  it('seeds comma-separated → parse', () => {
    const r = buildCrawlerRequest({ seeds: 'https://a.com, https://b.com' });
    expect(r.seeds).toEqual(['https://a.com', 'https://b.com']);
  });

  it('seeds newline-separated → parse', () => {
    const r = buildCrawlerRequest({ seeds: 'https://a.com\nhttps://b.com\nhttps://c.com' });
    expect(r.seeds).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('allowDomains vuoto → derive da hostname seeds', () => {
    const r = buildCrawlerRequest({ seeds: 'https://www.acme.com\nhttps://blog.acme.com' });
    expect(r.allowDomains).toEqual(['www.acme.com', 'blog.acme.com']);
  });

  it('allowDomains custom → override', () => {
    const r = buildCrawlerRequest({ seeds: 'https://a.com', allowDomains: 'a.com, b.com' });
    expect(r.allowDomains).toEqual(['a.com', 'b.com']);
  });

  it('denyPatterns parse newline', () => {
    const r = buildCrawlerRequest({ seeds: 'https://a.com', denyPatterns: '/admin/.*\n.*\\.pdf$' });
    expect(r.denyPatterns).toEqual(['/admin/.*', '.*\\.pdf$']);
  });

  it('maxDepth clamp [0, 10]', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', maxDepth: -5 }).maxDepth).toBe(0);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', maxDepth: 50 }).maxDepth).toBe(10);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', maxDepth: 5 }).maxDepth).toBe(5);
  });

  it('maxPages clamp [1, 100k]', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', maxPages: 0 }).maxPages).toBe(1);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', maxPages: 999_999 }).maxPages).toBe(100_000);
  });

  it('parallelism clamp [1, 50]', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', parallelism: 100 }).parallelism).toBe(50);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', parallelism: 0 }).parallelism).toBe(1);
  });

  it('rateLimitPerHostQps clamp [0.1, 50]', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', rateLimitPerHostQps: 0 }).rateLimitPerHostQps).toBe(0.1);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', rateLimitPerHostQps: 1000 }).rateLimitPerHostQps).toBe(50);
  });

  it('bloom filter capacity + fpr clamps', () => {
    const r = buildCrawlerRequest({ seeds: 'https://a.com', bloomCapacity: 0, bloomFpr: 0 });
    expect(r.dedupBloom.capacity).toBe(1000);
    expect(r.dedupBloom.falsePositiveRate).toBe(0.0001);
  });

  it('respectRobots default true', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com' }).respectRobots).toBe(true);
  });

  it('respectRobots false explicit', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', respectRobots: false }).respectRobots).toBe(false);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', respectRobots: 'false' }).respectRobots).toBe(false);
  });

  it('callbackBatchSize clamp [1, 1000]', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com', callbackBatchSize: 0 }).callbackBatchSize).toBe(1);
    expect(buildCrawlerRequest({ seeds: 'https://a.com', callbackBatchSize: 9999 }).callbackBatchSize).toBe(1000);
  });

  it('userAgent default identifica FlowForge', () => {
    expect(buildCrawlerRequest({ seeds: 'https://a.com' }).userAgent).toContain('FlowForge-Crawler');
  });
});

describe('distributedCrawlerNode.def', () => {
  it('id corretto + outputs include jobId+items+nextCursor', () => {
    expect(distributedCrawlerNode.def.id).toBe('action_crawler_distributed');
    expect(distributedCrawlerNode.def.outputs).toContain('jobId');
    expect(distributedCrawlerNode.def.outputs).toContain('items');
    expect(distributedCrawlerNode.def.outputs).toContain('nextCursor');
  });

  it('action field ha 4 options (start, status, stop, results)', () => {
    const f = distributedCrawlerNode.def.configFields?.find((x) => x.key === 'action');
    expect(f && 'options' in f ? [...(f.options ?? [])].sort() : []).toEqual(['results', 'start', 'status', 'stop']);
  });
});

describe('distributedCrawlerNode.executor', () => {
  it('endpoint mancante → throw con BYO instructions', async () => {
    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    await expect(
      distributedCrawlerNode.executor({ action: 'start', seeds: 'https://a.com' }, null, ctx),
    ).rejects.toThrow(/Crawler endpoint not configured/);
  });

  it('action=start → POST /crawl/start con body, ritorna jobId', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://crawler.x.com';
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jobId: 'crawl_abc', status: 'queued', queueDepth: 5 }),
    } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    const res = await distributedCrawlerNode.executor(
      { action: 'start', seeds: 'https://target.com', maxDepth: 2 }, null, ctx,
    );
    const [url, opts] = mockedFetch.mock.calls[0]!;
    expect(url).toBe('https://crawler.x.com/crawl/start');
    expect((opts as { method: string }).method).toBe('POST');
    const body = JSON.parse((opts as { body: string }).body) as { seeds: string[]; maxDepth: number };
    expect(body.seeds).toEqual(['https://target.com']);
    expect(body.maxDepth).toBe(2);
    const out = res.output as { jobId: string; status: string; queueDepth: number };
    expect(out.jobId).toBe('crawl_abc');
    expect(out.status).toBe('queued');
    expect(out.queueDepth).toBe(5);
  });

  it('action=status senza jobId → throw', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    await expect(
      distributedCrawlerNode.executor({ action: 'status' }, null, ctx),
    ).rejects.toThrow(/jobId required for action=status/);
  });

  it('action=status con jobId → GET /crawl/{id}/status', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ pagesCrawled: 42, queueDepth: 13, status: 'running' }),
    } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    const res = await distributedCrawlerNode.executor({ action: 'status', jobId: 'job_xyz' }, null, ctx);
    expect(mockedFetch.mock.calls[0]![0]).toBe('https://x.com/crawl/job_xyz/status');
    expect((mockedFetch.mock.calls[0]![1] as { method: string }).method).toBe('GET');
    expect((res.output as { pagesCrawled: number }).pagesCrawled).toBe(42);
  });

  it('action=stop → POST /crawl/{id}/stop', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    const res = await distributedCrawlerNode.executor({ action: 'stop', jobId: 'jx' }, null, ctx);
    expect(mockedFetch.mock.calls[0]![0]).toBe('https://x.com/crawl/jx/stop');
    expect((res.output as { stopped: boolean }).stopped).toBe(true);
  });

  it('action=results con cursor → GET con query string', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ items: [{ url: 'a' }, { url: 'b' }], nextCursor: 'cur_2' }),
    } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    const res = await distributedCrawlerNode.executor({ action: 'results', jobId: 'jx', cursor: 'cur_1' }, null, ctx);
    expect(mockedFetch.mock.calls[0]![0]).toBe('https://x.com/crawl/jx/results?cursor=cur_1');
    const out = res.output as { items: unknown[]; count: number; nextCursor: string };
    expect(out.count).toBe(2);
    expect(out.nextCursor).toBe('cur_2');
  });

  it('action=results senza cursor → no query string', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ items: [] }),
    } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    await distributedCrawlerNode.executor({ action: 'results', jobId: 'jx' }, null, ctx);
    expect(mockedFetch.mock.calls[0]![0]).toBe('https://x.com/crawl/jx/results');
  });

  it('action unknown → throw lista azioni valide', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    await expect(
      distributedCrawlerNode.executor({ action: 'wat' }, null, ctx),
    ).rejects.toThrow(/unknown action "wat".*start.*status.*stop.*results/);
  });

  it('endpoint non-ok su start → throw con status', async () => {
    process.env.MEDEA_CRAWLER_ENDPOINT = 'https://x.com';
    mockedFetch.mockResolvedValue({
      ok: false, status: 503, text: async () => 'queue full',
    } as unknown as Response);

    if (!distributedCrawlerNode.executor) throw new Error('executor mancante');
    await expect(
      distributedCrawlerNode.executor({ action: 'start', seeds: 'https://a.com' }, null, ctx),
    ).rejects.toThrow(/Crawler start failed: 503 queue full/);
  });
});
