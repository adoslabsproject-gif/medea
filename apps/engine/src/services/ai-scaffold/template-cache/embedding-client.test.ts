/**
 * Embedding client — test reali (con fetch mock).
 *
 * Asserisce VALORE specifico embedding array + handling errori graceful.
 * Pattern: vi.stubGlobal('fetch', fn) per simulare BGE-M3 server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger.js');

const originalFetch = global.fetch;
const originalLicense = process.env.MEDEA_LICENSE_KEY;

beforeEach(() => {
  process.env.MEDEA_LICENSE_KEY = 'test-license-key';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalLicense === undefined) delete process.env.MEDEA_LICENSE_KEY;
  else process.env.MEDEA_LICENSE_KEY = originalLicense;
  vi.resetModules();
});

describe('generateEmbedding — success path', () => {
  it('fetch ok 200 → ritorna array 1024 numeri', async () => {
    const fake = new Array(1024).fill(0).map((_, i) => i / 1024);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ embedding: fake, dimensions: 1024 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    const result = await generateEmbedding('test prompt');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1024);
    expect(result![0]).toBe(0);
    expect(result![1023]).toBeCloseTo(1023 / 1024, 6);
  });

  it('text whitespace solo → null (no API call)', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    expect(await generateEmbedding('   ')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('text molto lungo → truncato a 8000 char', async () => {
    let capturedBody = '';
    global.fetch = vi.fn(async (_url, opts: RequestInit | undefined) => {
      capturedBody = (opts?.body ?? '') as string;
      return new Response(JSON.stringify({ embedding: new Array(1024).fill(0.5), dimensions: 1024 }), { status: 200 });
    }) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    await generateEmbedding('x'.repeat(20000));
    const parsedBody = JSON.parse(capturedBody) as { text: string };
    expect(parsedBody.text.length).toBe(8000);
  });
});

describe('generateEmbedding — error paths (graceful)', () => {
  it('LICENSE_KEY mancante → null (no fetch)', async () => {
    delete process.env.MEDEA_LICENSE_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    expect(await generateEmbedding('test')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetch ritorna 500 → null', async () => {
    global.fetch = vi.fn(async () => new Response('upstream error', { status: 500 })) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    expect(await generateEmbedding('test')).toBeNull();
  });

  it('fetch throw (network down) → null', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    expect(await generateEmbedding('test')).toBeNull();
  });

  it('embedding shape wrong (len 512 invece 1024) → null', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(512).fill(0.5), dimensions: 512 }), { status: 200 })) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    expect(await generateEmbedding('test')).toBeNull();
  });
});

describe('generateEmbedding — auth header', () => {
  it('invia Authorization Bearer con MEDEA_LICENSE_KEY', async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn(async (_url, opts: RequestInit | undefined) => {
      capturedHeaders = (opts?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ embedding: new Array(1024).fill(0), dimensions: 1024 }), { status: 200 });
    }) as unknown as typeof global.fetch;
    const { generateEmbedding } = await import('./embedding-client.js');
    await generateEmbedding('test');
    expect(capturedHeaders.authorization).toBe('Bearer test-license-key');
  });
});
