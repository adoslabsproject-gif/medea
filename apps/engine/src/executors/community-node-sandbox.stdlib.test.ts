/**
 * Test E2E: STDLIB INJECTION nella sandbox reale (isolated-vm inline mode).
 *
 * Verifica che un vendor source possa scrivere:
 *   const rows = ff.csv.parseCsv(input.csv);
 *   const hash = ff.crypto.sha256Hex(rows[0].name);
 *   return { rows, hash };
 *
 * E ottenere il risultato corretto. La sandbox usa lo stesso bundle deployato
 * in prod — questo test rileverà regression IMMEDIATE su:
 *   - bundle non incluso nel deploy
 *   - bundle eval crash dentro isolated-vm
 *   - API mismatch ff.* (es. ff.csv.parse → ff.csv.parseCsv)
 *
 * @module executors/community-node-sandbox.stdlib.test
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runInSandbox, SANDBOX_STDLIB_INFO, type SandboxInput } from './community-node-sandbox.js';

// Forza inline mode (no worker) per test rapido deterministico
beforeAll(() => {
  process.env.VITEST = 'true';
});

const baseInput: SandboxInput = {
  config: {},
  input: {},
  context: { tenantId: 't1', runId: 'r1', workflowId: 'w1', nodeId: 'n1', action: 'test' },
};

describe('🚨 SANDBOX STDLIB INJECTION — E2E inside isolated-vm', () => {
  it('SANDBOX_STDLIB_INFO esposto: helpers + bytes', () => {
    expect(SANDBOX_STDLIB_INFO.helpers).toEqual(
      ['csv', 'crypto', 'transform', 'text', 'url', 'jsonpath', 'time'],
    );
    expect(SANDBOX_STDLIB_INFO.bytes).toBeGreaterThan(1000);
    expect(SANDBOX_STDLIB_INFO.bytes).toBeLessThan(20_000);
    expect(SANDBOX_STDLIB_INFO.globalName).toBe('ff');
  });

  it('🚨 vendor: ff.csv.parseCsv → array oggetti', async () => {
    const source = `
      module.exports = async function() {
        return ff.csv.parseCsv('name,score\\nalice,85\\nbob,92');
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toEqual([
      { name: 'alice', score: '85' },
      { name: 'bob', score: '92' },
    ]);
  });

  it('🚨 vendor: ff.crypto.sha256Hex NIST vector', async () => {
    const source = `
      module.exports = async function() {
        return ff.crypto.sha256Hex('abc');
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('🚨 vendor: ff.transform.groupBy by predicate', async () => {
    const source = `
      module.exports = async function() {
        return ff.transform.groupBy([1,2,3,4,5], n => n % 2 === 0 ? 'even' : 'odd');
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toEqual({ odd: [1, 3, 5], even: [2, 4] });
  });

  it('🚨 vendor: ff.text.slugify accent strip', async () => {
    const source = `
      module.exports = async function() {
        return ff.text.slugify('Café à Paris');
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe('cafe-a-paris');
  });

  it('🚨 vendor: ff.url.buildQuery con array', async () => {
    const source = `
      module.exports = async function() {
        return ff.url.buildQuery({ tags: ['a', 'b', 'c'], q: 'hello world' });
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe('tags=a&tags=b&tags=c&q=hello+world');
  });

  it('🚨 vendor: ff.jsonpath.get deep path', async () => {
    const source = `
      module.exports = async function() {
        return ff.jsonpath.get({ items: [{ user: { id: 42 } }] }, 'items[0].user.id');
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe(42);
  });

  it('🚨 vendor: ff.time.addDays cross-month', async () => {
    const source = `
      module.exports = async function() {
        return ff.time.toIso(ff.time.addDays(new Date('2026-06-30T00:00:00Z'), 5));
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe('2026-07-05T00:00:00.000Z');
  });

  it('🚨 vendor multi-helper pipeline (Cappella Sistina demo)', async () => {
    const source = `
      module.exports = async function(config, input) {
        const data = ff.csv.parseCsv(input.csv);
        const byName = ff.transform.groupBy(data, 'name');
        const stats = Object.entries(byName).map(([name, rows]) => ({
          name,
          slug: ff.text.slugify(name),
          avgScore: ff.transform.avg(rows.map(r => parseInt(r.score, 10))),
        }));
        const sorted = ff.transform.sortBy(stats, s => -s.avgScore);
        return {
          best: sorted[0],
          worst: sorted[sorted.length - 1],
          allHashes: sorted.map(s => ff.crypto.sha256Hex(s.slug).slice(0, 8)),
        };
      };
    `;
    const inputWithCsv: SandboxInput = {
      ...baseInput,
      input: { csv: 'name,score\nalice,85\nbob,92\nalice,78\nbob,95' },
    };
    const r = await runInSandbox(source, inputWithCsv) as {
      best: { name: string; slug: string; avgScore: number };
      worst: { name: string; slug: string; avgScore: number };
      allHashes: string[];
    };
    expect(r.best.name).toBe('bob');
    expect(r.best.avgScore).toBe((92 + 95) / 2);
    expect(r.worst.name).toBe('alice');
    expect(r.worst.avgScore).toBe((85 + 78) / 2);
    expect(r.allHashes).toHaveLength(2);
    expect(r.allHashes[0]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('🚨 vendor: TUTTI gli ff.* moduli reachable', async () => {
    const source = `
      module.exports = async function() {
        return {
          csv: typeof ff.csv.parseCsv,
          crypto: typeof ff.crypto.sha256Hex,
          transform: typeof ff.transform.groupBy,
          text: typeof ff.text.slugify,
          url: typeof ff.url.buildQuery,
          jsonpath: typeof ff.jsonpath.get,
          time: typeof ff.time.nowIso,
        };
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toEqual({
      csv: 'function', crypto: 'function', transform: 'function',
      text: 'function', url: 'function', jsonpath: 'function', time: 'function',
    });
  });

  it('🔒 SECURITY: ff iniettato NON espone process/require/Buffer host', async () => {
    const source = `
      module.exports = async function() {
        return {
          process: typeof process,
          require: typeof require,
          // Buffer è shimmed (no real Node Buffer) — ff.crypto NON espone byte view raw
          bufferShimType: typeof Buffer,
        };
      };
    `;
    const r = await runInSandbox(source, baseInput) as Record<string, string>;
    expect(r.process).toBe('undefined');
    expect(r.require).toBe('undefined');
    // Buffer è un shim 2-method (Buffer.from + toString), non real Buffer
    expect(r.bufferShimType).toBe('object');
  });

  it('🚨 vendor source NON può overridere ff (frozen-ish — best effort)', async () => {
    // ff è settato come globalThis prop. Vendor può overrirla LOCALMENTE
    // ma il prossimo run ricrea isolate fresh → no contamination cross-run.
    const source = `
      module.exports = async function() {
        ff.csv = { malicious: true };  // local mutation only
        return ff.csv.malicious;
      };
    `;
    const r = await runInSandbox(source, baseInput);
    expect(r).toBe(true);  // mutation locale OK
    // Run successivo — fresh isolate, ff originale
    const cleanSource = `module.exports = async function() { return typeof ff.csv.parseCsv; };`;
    const r2 = await runInSandbox(cleanSource, baseInput);
    expect(r2).toBe('function');  // isolato dal precedente
  });
});
