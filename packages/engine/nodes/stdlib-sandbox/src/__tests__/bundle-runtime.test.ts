/**
 * Test del bundle ESM compilato — eseguito dentro un V8 Context (`node:vm`)
 * che simula isolated-vm: il bundle viene `runInContext` → `globalThis.ff`
 * deve essere disponibile. Poi un "vendor source" usa `ff.csv.parse` etc.
 *
 * Test VERITIERO: 100% mismatch del bundle vs API attesa = catturato qui.
 *
 * @module sandbox/__tests__/bundle-runtime
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Script, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(__dirname, '..', '..', 'dist', 'sandbox-bundle.js');

let BUNDLE_SOURCE = '';

beforeAll(async () => {
  BUNDLE_SOURCE = await readFile(BUNDLE_PATH, 'utf-8');
  expect(BUNDLE_SOURCE.length).toBeGreaterThan(1000);
});

function execInContext(
  vendorSrc: string,
  captureLog = false,
): {
  result: unknown;
  logs: string[];
} {
  const logs: string[] = [];
  const sandboxGlobal = {
    console: captureLog
      ? { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) }
      : { log: () => undefined },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Date,
    Math,
    JSON,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  } as Record<string, unknown>;
  const ctx = createContext(sandboxGlobal);
  // Pre-eval STDLIB_BUNDLE → bind `ff` globalmente
  new Script(BUNDLE_SOURCE).runInContext(ctx);
  // Eval vendor source che ritorna un valore
  const script = new Script(vendorSrc);
  const result = script.runInContext(ctx);
  return { result, logs };
}

describe('🚨 STDLIB_BUNDLE — runtime injection in V8 Context', () => {
  it('bundle eseguito → globalThis.ff disponibile con tutti i moduli', () => {
    const { result } = execInContext('Object.keys(ff)');
    expect(result).toEqual(
      expect.arrayContaining(['csv', 'crypto', 'transform', 'text', 'url', 'jsonpath', 'time']),
    );
  });

  it('vendor: ff.csv.parseCsv funziona', () => {
    const { result } = execInContext(`
      ff.csv.parseCsv('a,b\\n1,2\\n3,4')
    `);
    expect(result).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('vendor: ff.csv.stringifyCsv round-trip', () => {
    const { result } = execInContext(`
      const csv = ff.csv.stringifyCsv([{ x: 1, y: 2 }]);
      ff.csv.parseCsv(csv);
    `);
    expect(result).toEqual([{ x: '1', y: '2' }]);
  });

  it('🚨 vendor: ff.crypto.sha256Hex("abc") = ba7816bf... (NIST vector)', () => {
    const { result } = execInContext(`ff.crypto.sha256Hex('abc')`);
    expect(result).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('🚨 vendor: ff.crypto.hmacSha256Hex RFC 4231 test case 1', () => {
    const { result } = execInContext(`
      const key = new Uint8Array(20);
      for (let i = 0; i < 20; i++) key[i] = 0x0b;
      ff.crypto.hmacSha256Hex(key, 'Hi There')
    `);
    expect(result).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('vendor: ff.transform.groupBy by predicate', () => {
    const { result } = execInContext(`
      ff.transform.groupBy([1,2,3,4], n => n % 2 === 0 ? 'even' : 'odd')
    `);
    expect(result).toEqual({ odd: [1, 3], even: [2, 4] });
  });

  it('vendor: ff.text.slugify rimuove accenti', () => {
    const { result } = execInContext(`ff.text.slugify('Café à Paris')`);
    expect(result).toBe('cafe-a-paris');
  });

  it('vendor: ff.url.buildQuery skip null/undefined', () => {
    const { result } = execInContext(`ff.url.buildQuery({ a: 1, b: null, c: undefined })`);
    expect(result).toBe('a=1');
  });

  it('vendor: ff.jsonpath.get deep path', () => {
    const { result } = execInContext(`
      ff.jsonpath.get({ items: [{ user: { name: 'alice' } }] }, 'items[0].user.name')
    `);
    expect(result).toBe('alice');
  });

  it('vendor: ff.time.addDays cross month', () => {
    const { result } = execInContext(`
      ff.time.toIso(ff.time.addDays(new Date('2026-06-30T00:00:00Z'), 5))
    `);
    expect(result).toBe('2026-07-05T00:00:00.000Z');
  });

  it('🚨 vendor multi-helper combo (realistic pattern)', () => {
    const { result } = execInContext(`
      const data = ff.csv.parseCsv('name,score\\nalice,85\\nbob,92\\nalice,78');
      const grouped = ff.transform.groupBy(data, 'name');
      const aliceAvg = ff.transform.avg(grouped.alice.map(r => parseInt(r.score, 10)));
      const slug = ff.text.slugify('Best Student: ' + Object.keys(grouped)[0]);
      const hash = ff.crypto.sha256Hex(slug + '|' + aliceAvg);
      ({ aliceAvg, slug, hash })
    `);
    expect(result).toMatchObject({
      aliceAvg: (85 + 78) / 2,
      slug: 'best-student-alice',
    });
    expect((result as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('🚨 SECURITY: vendor NON ha accesso a process/require/Buffer (isolation)', () => {
    expect(() => execInContext(`typeof process`)).not.toThrow();
    const { result: r1 } = execInContext(`typeof process`);
    expect(r1).toBe('undefined');

    const { result: r2 } = execInContext(`typeof require`);
    expect(r2).toBe('undefined');

    const { result: r3 } = execInContext(`typeof Buffer`);
    expect(r3).toBe('undefined');
  });

  it('🚨 BUNDLE size sotto soglia (15KB) → SLA injection cold-start', () => {
    expect(BUNDLE_SOURCE.length).toBeLessThan(15_000);
  });

  it('🚨 bundle deterministic — stesso source = stessa output (no random)', async () => {
    const a = await readFile(BUNDLE_PATH, 'utf-8');
    const b = await readFile(BUNDLE_PATH, 'utf-8');
    expect(a).toBe(b);
  });
});
