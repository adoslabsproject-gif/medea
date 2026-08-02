/**
 * Test REALI di action_browser_automate — eseguono l'executor vero, isolando solo
 * le dipendenze esterne (safe-fetch: rete + SSRF guard). Verificano: endpoint/URL
 * obbligatori, validazione SSRF su startUrl E su ogni goto, validazione degli
 * step (array/azione/cap), il contratto con l'endpoint BYO e la gestione errori.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const assertUrlSafe = vi.fn();
const safeFetchWithRedirects = vi.fn();
vi.mock('@medea/engine-safe-fetch', () => ({
  assertUrlSafe: (...a: unknown[]) => assertUrlSafe(...a),
  safeFetchWithRedirects: (...a: unknown[]) => safeFetchWithRedirects(...a),
}));

import { browserAutomateNode } from './browser-automate.js';

const run = browserAutomateNode.executor!;
const ctx = {} as never;

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

beforeEach(() => {
  assertUrlSafe.mockReset();
  safeFetchWithRedirects.mockReset();
  // default: SSRF guard blocca IP privati/loopback/metadata
  assertUrlSafe.mockImplementation((url: string) => {
    if (/169\.254|localhost|127\.0\.0\.1|10\.|192\.168/.test(url)) throw new Error('SSRF blocked');
  });
  safeFetchWithRedirects.mockResolvedValue(
    okResponse({ extracted: { totale: '42' }, finalUrl: 'https://x.it/done', stepsRun: 2 }),
  );
  process.env.MEDEA_BROWSER_ENDPOINT = 'https://browser.zeli.it';
});

const STEPS = JSON.stringify([
  { action: 'waitFor', selector: '#u' },
  { action: 'extract', selector: '.t', name: 'totale' },
]);

describe('action_browser_automate — guard di configurazione', () => {
  it('endpoint mancante → throw', async () => {
    delete process.env.MEDEA_BROWSER_ENDPOINT;
    await expect(run({ startUrl: 'https://x.it', steps: STEPS }, undefined, ctx)).rejects.toThrow(
      /endpoint non configurato/,
    );
  });
  it('startUrl mancante → throw', async () => {
    await expect(run({ steps: STEPS }, undefined, ctx)).rejects.toThrow(/startUrl/);
  });
});

describe('action_browser_automate — difese SSRF', () => {
  it('startUrl verso IP privato → rifiutato (assertUrlSafe lancia)', async () => {
    await expect(
      run({ startUrl: 'http://169.254.169.254/latest/meta-data', steps: STEPS }, undefined, ctx),
    ).rejects.toThrow(/SSRF/);
    expect(safeFetchWithRedirects).not.toHaveBeenCalled(); // bloccato prima della rete
  });
  it('uno step goto verso localhost → rifiutato', async () => {
    const steps = JSON.stringify([{ action: 'goto', url: 'http://localhost:6379' }]);
    await expect(run({ startUrl: 'https://ok.it', steps }, undefined, ctx)).rejects.toThrow(/SSRF/);
  });
  it('startUrl + goto pubblici → assertUrlSafe chiamato per ciascuno', async () => {
    const steps = JSON.stringify([
      { action: 'goto', url: 'https://b.it/page2' },
      { action: 'extract', selector: '.x', name: 'v' },
    ]);
    await run({ startUrl: 'https://a.it', steps }, undefined, ctx);
    const urls = assertUrlSafe.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://a.it');
    expect(urls).toContain('https://b.it/page2');
  });
});

describe('action_browser_automate — validazione step', () => {
  it('steps non-JSON → throw', async () => {
    await expect(
      run({ startUrl: 'https://x.it', steps: '{rotto' }, undefined, ctx),
    ).rejects.toThrow(/JSON/);
  });
  it('steps non-array → throw', async () => {
    await expect(
      run({ startUrl: 'https://x.it', steps: '{"action":"click"}' }, undefined, ctx),
    ).rejects.toThrow(/array/);
  });
  it('steps vuoto → throw', async () => {
    await expect(run({ startUrl: 'https://x.it', steps: '[]' }, undefined, ctx)).rejects.toThrow(
      /almeno uno/,
    );
  });
  it('azione sconosciuta → throw', async () => {
    await expect(
      run({ startUrl: 'https://x.it', steps: '[{"action":"hack"}]' }, undefined, ctx),
    ).rejects.toThrow(/sconosciuta/);
  });
  it('troppi step (>50) → throw', async () => {
    const many = JSON.stringify(Array.from({ length: 51 }, () => ({ action: 'screenshot' })));
    await expect(run({ startUrl: 'https://x.it', steps: many }, undefined, ctx)).rejects.toThrow(
      /troppi step/,
    );
  });
});

describe('action_browser_automate — contratto endpoint + output', () => {
  it('POST endpoint/automate con startUrl+steps+timeout, ritorna extracted/finalUrl', async () => {
    const r = await run(
      { startUrl: 'https://x.it', steps: STEPS, timeoutMs: '40000' },
      undefined,
      ctx,
    );
    const [url, opts] = safeFetchWithRedirects.mock.calls[0]! as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://browser.zeli.it/automate');
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body) as { startUrl: string; steps: unknown[]; timeoutMs: number };
    expect(sent.startUrl).toBe('https://x.it');
    expect(sent.steps).toHaveLength(2);
    const out = r.output as {
      extracted: Record<string, unknown>;
      finalUrl: string;
      stepsRun: number;
    };
    expect(out.extracted.totale).toBe('42');
    expect(out.finalUrl).toBe('https://x.it/done');
    expect(out.stepsRun).toBe(2);
  });
  it('timeout clampato nel range 2-120s', async () => {
    await run({ startUrl: 'https://x.it', steps: STEPS, timeoutMs: '999999' }, undefined, ctx);
    const opts = safeFetchWithRedirects.mock.calls[0]![1] as { body: string; timeoutMs: number };
    expect(JSON.parse(opts.body).timeoutMs).toBe(120_000);
  });
  it('endpoint risponde non-ok → throw con status', async () => {
    safeFetchWithRedirects.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
      json: async () => ({}),
    });
    await expect(run({ startUrl: 'https://x.it', steps: STEPS }, undefined, ctx)).rejects.toThrow(
      /502/,
    );
  });
  it('endpoint ritorna { error } → throw', async () => {
    safeFetchWithRedirects.mockResolvedValue(okResponse({ error: 'selector not found: #u' }));
    await expect(run({ startUrl: 'https://x.it', steps: STEPS }, undefined, ctx)).rejects.toThrow(
      /selector not found/,
    );
  });
});
