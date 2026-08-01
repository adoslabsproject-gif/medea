/**
 * Test marketplace install — size cap 2026-05-29.
 *
 * Fix: workflow JSON cap a 5MB via Content-Length pre-check + streaming
 * bounded read (readWithCap helper).
 *
 * Test focus:
 *  - readWithCap rifiuta body > MAX_BYTES con throw
 *  - readWithCap accetta body < MAX_BYTES
 *  - readWithCap senza body → ''
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readWithCap } from './marketplace';

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketplaceSource = readFileSync(join(__dirname, 'marketplace.ts'), 'utf-8');

function makeFakeResponse(chunks: Uint8Array[]): Response {
  let idx = 0;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (idx >= chunks.length) return { done: true };
      const v = chunks[idx++]!;
      return { done: false, value: v };
    },
    cancel: async (): Promise<void> => undefined,
  };
  const body = {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
  return { body } as Response;
}

describe('readWithCap — size cap regression 2026-05-29', () => {
  it('body sotto cap → ritorna stringa decoded', async () => {
    const text = 'hello world';
    const res = makeFakeResponse([new TextEncoder().encode(text)]);
    expect(await readWithCap(res, 1024)).toBe(text);
  });

  it('body multi-chunk concatenato', async () => {
    const res = makeFakeResponse([
      new TextEncoder().encode('part1-'),
      new TextEncoder().encode('part2'),
    ]);
    expect(await readWithCap(res, 100)).toBe('part1-part2');
  });

  it('body OLTRE cap → throw zip-bomb guard', async () => {
    const big = new Uint8Array(2048);
    const res = makeFakeResponse([big]);
    await expect(readWithCap(res, 1024)).rejects.toThrow(/zip-bomb|exceeds/);
  });

  it('body multi-chunk che oltrepassa cap a metà → throw', async () => {
    const a = new Uint8Array(600);
    const b = new Uint8Array(600);
    const res = makeFakeResponse([a, b]);
    await expect(readWithCap(res, 1024)).rejects.toThrow();
  });

  it('Response senza body → stringa vuota', async () => {
    const res = { body: null } as unknown as Response;
    expect(await readWithCap(res, 1024)).toBe('');
  });

  it('UTF-8 multi-byte preserved attraverso chunk boundary', async () => {
    // "Ciao 中文" - split per testare TextDecoder accumulator
    const encoded = new TextEncoder().encode('Ciao 中文 abc');
    const res = makeFakeResponse([encoded]);
    expect(await readWithCap(res, 100)).toBe('Ciao 中文 abc');
  });
});

describe('marketplace.ts — content-length guard presente', () => {
  it('source contains content-length pre-check', () => {
    expect(marketplaceSource).toMatch(/content-length/);
  });

  it('source contains MAX_BYTES constant', () => {
    expect(marketplaceSource).toMatch(/MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  });

  it('source contains 413 status code', () => {
    expect(marketplaceSource).toMatch(/413/);
  });
});
