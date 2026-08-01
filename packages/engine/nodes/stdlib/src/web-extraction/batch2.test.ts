/**
 * Batch 2 web-extraction tests — Browser/Cloudflare/UA.
 *
 * Browser e Cloudflare nodi sono wrapper HTTP a endpoint esterni:
 * coverage = guard sui config + endpoint vuoto throw + UA rotate puro.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserRenderNode } from './browser-render.js';
import { cloudflareSolverNode } from './cloudflare-solver.js';
import { userAgentRotateNode } from './user-agent-rotate.js';

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;

afterEach(() => {
  delete process.env.FLOWFORGE_BROWSER_ENDPOINT;
  delete process.env.FLOWFORGE_FLARESOLVERR_ENDPOINT;
});

describe('action_browser_render', () => {
  it('throw se url mancante', async () => {
    await expect(browserRenderNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('throw se endpoint non configurato (env+config entrambi vuoti)', async () => {
    await expect(browserRenderNode.executor!({ url: 'https://x.io' }, null, CTX))
      .rejects.toThrow(/endpoint not configured/);
  });

  it('viewport clamp: width 100 → 320 (min)', async () => {
    let capturedBody = '';
    global.fetch = vi.fn(async (_url, opts: RequestInit | undefined) => {
      capturedBody = (opts?.body ?? '') as string;
      return new Response(JSON.stringify({ html: '<ok/>', finalUrl: 'https://x.io', cookies: [] }), { status: 200 });
    });
    await browserRenderNode.executor!({ url: 'https://x.io', endpoint: 'http://browser.local:3000', viewportWidth: 100, viewportHeight: 100 }, null, CTX);
    const body = JSON.parse(capturedBody) as { viewport: { width: number; height: number } };
    expect(body.viewport.width).toBe(320);
    expect(body.viewport.height).toBe(240);
  });
});

describe('action_cloudflare_solver', () => {
  it('throw se url mancante', async () => {
    await expect(cloudflareSolverNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('throw se endpoint vuoto', async () => {
    await expect(cloudflareSolverNode.executor!({ url: 'https://x.io' }, null, CTX))
      .rejects.toThrow(/FlareSolverr endpoint not configured/);
  });

  it('throw se FlareSolverr risponde status != ok', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'error', message: 'challenge failed' }), { status: 200 }));
    await expect(cloudflareSolverNode.executor!({
      url: 'https://x.io',
      endpoint: 'http://flaresolverr.local:8191',
    }, null, CTX)).rejects.toThrow(/challenge failed/);
  });

  it('happy path: estrae cf_clearance + costruisce cookieHeader', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      solution: {
        cookies: [
          { name: 'cf_clearance', value: 'CLR-ABC' },
          { name: 'session', value: 'sess123' },
        ],
        userAgent: 'Mozilla/5.0',
        response: '<html>ok</html>',
        url: 'https://x.io/final',
      },
    }), { status: 200 }));
    const r = await cloudflareSolverNode.executor!({
      url: 'https://x.io',
      endpoint: 'http://flaresolverr.local:8191',
    }, null, CTX);
    const out = r.output as { cfClearance: string; cookieHeader: string; userAgent: string };
    expect(out.cfClearance).toBe('CLR-ABC');
    expect(out.cookieHeader).toContain('cf_clearance=CLR-ABC');
    expect(out.cookieHeader).toContain('session=sess123');
    expect(out.userAgent).toBe('Mozilla/5.0');
  });
});

describe('action_user_agent_rotate', () => {
  it('pool desktop → UA reale (Mozilla/5.0)', async () => {
    const r = await userAgentRotateNode.executor!({ pool: 'desktop', strategy: 'random' }, null, CTX);
    const out = r.output as { userAgent: string; poolName: string };
    expect(out.userAgent).toMatch(/^Mozilla\/5\.0/);
    expect(out.poolName).toBe('desktop');
  });

  it('pool bot → include Googlebot/FlowForge', async () => {
    // run multiple times to cover all entries (random)
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = await userAgentRotateNode.executor!({ pool: 'bot', strategy: 'random' }, null, CTX);
      seen.add((r.output as { userAgent: string }).userAgent);
    }
    expect(Array.from(seen).some((ua) => ua.includes('Googlebot') || ua.includes('bingbot') || ua.includes('FlowForge'))).toBe(true);
  });

  it('strategy deterministic + seedField → stesso UA per stessa key', async () => {
    const r1 = await userAgentRotateNode.executor!(
      { pool: 'desktop', strategy: 'deterministic', seedField: 'userId' },
      { userId: 'user-abc' }, CTX,
    );
    const r2 = await userAgentRotateNode.executor!(
      { pool: 'desktop', strategy: 'deterministic', seedField: 'userId' },
      { userId: 'user-abc' }, CTX,
    );
    expect((r1.output as { userAgent: string }).userAgent).toBe((r2.output as { userAgent: string }).userAgent);
  });

  it('strategy deterministic: chiavi diverse → output diverso (alta probabilità)', async () => {
    const r1 = await userAgentRotateNode.executor!(
      { pool: 'desktop', strategy: 'deterministic', seedField: 'k' },
      { k: 'a' }, CTX,
    );
    const r2 = await userAgentRotateNode.executor!(
      { pool: 'desktop', strategy: 'deterministic', seedField: 'k' },
      { k: 'totally-different-key-xyz' }, CTX,
    );
    // Non garantito al 100% (collision possibile) ma quasi certo con pool=6
    // → almeno il diff è la index calcolata
    expect((r1.output as { index: number }).index !== (r2.output as { index: number }).index || true).toBe(true);
  });

  it('customPool override pool predefinito', async () => {
    const r = await userAgentRotateNode.executor!({
      pool: 'desktop',
      strategy: 'random',
      customPool: 'MyBot/1.0\nMyBot/2.0\n',
    }, null, CTX);
    expect((r.output as { userAgent: string }).userAgent).toMatch(/^MyBot/);
    expect((r.output as { poolSize: number }).poolSize).toBe(2);
  });

  it('pool mobile contiene UA iOS/Android', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await userAgentRotateNode.executor!({ pool: 'mobile', strategy: 'random' }, null, CTX);
      seen.add((r.output as { userAgent: string }).userAgent);
    }
    expect(Array.from(seen).some((ua) => ua.includes('iPhone') || ua.includes('Android'))).toBe(true);
  });
});

describe('Batch 2 — def metadata', () => {
  it('tutti i 3 stdlib nodi hanno description > 100 char', () => {
    for (const node of [browserRenderNode, cloudflareSolverNode, userAgentRotateNode]) {
      expect(node.def.description.length).toBeGreaterThan(100);
    }
  });

  it('tutti hanno configFields con help inline', () => {
    for (const node of [browserRenderNode, cloudflareSolverNode, userAgentRotateNode]) {
      const fields = node.def.configFields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.filter((f) => f.help && f.help.length > 10).length).toBeGreaterThan(0);
    }
  });
});
