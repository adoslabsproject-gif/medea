import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmbeddedVectorAdapter } from './embedded.js';

describe('EmbeddedVectorAdapter', () => {
  let adapter: EmbeddedVectorAdapter;

  beforeEach(() => {
    adapter = new EmbeddedVectorAdapter(':memory:');
    adapter.connect();
  });

  afterEach(() => {
    adapter.close();
  });

  it('ensures collection then upserts + searches by cosine', async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await adapter.upsert('docs', [
      { id: 'a', vector: [1, 0, 0], payload: { tag: 'first' } },
      { id: 'b', vector: [0.9, 0.1, 0], payload: { tag: 'similar' } },
      { id: 'c', vector: [0, 1, 0], payload: { tag: 'far' } },
    ]);
    const results = await adapter.search('docs', { vector: [1, 0, 0], topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('a');
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[1]?.id).toBe('b');
  });

  it('filters by payload', async () => {
    await adapter.ensureCollection('docs', 2, 'cosine');
    await adapter.upsert('docs', [
      { id: '1', vector: [1, 0], payload: { lang: 'it' } },
      { id: '2', vector: [1, 0], payload: { lang: 'en' } },
    ]);
    const results = await adapter.search('docs', {
      vector: [1, 0],
      filter: { lang: 'it' },
      topK: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('1');
  });

  it('rejects vectors with wrong dimensions', async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await expect(adapter.upsert('docs', [{ id: 'x', vector: [1, 0] }])).rejects.toThrow(
      /dimensions/,
    );
  });

  it('deleteByIds removes rows', async () => {
    await adapter.ensureCollection('docs', 2, 'cosine');
    await adapter.upsert('docs', [
      { id: '1', vector: [1, 0] },
      { id: '2', vector: [0, 1] },
    ]);
    expect(await adapter.countCollection('docs')).toBe(2);
    await adapter.deleteByIds('docs', ['1']);
    expect(await adapter.countCollection('docs')).toBe(1);
  });

  it('euclidean distance: closer = higher score', async () => {
    await adapter.ensureCollection('docs', 2, 'euclidean');
    await adapter.upsert('docs', [
      { id: 'near', vector: [0.95, 0.05] },
      { id: 'far', vector: [10, 10] },
    ]);
    const results = await adapter.search('docs', { vector: [1, 0], topK: 2 });
    expect(results[0]?.id).toBe('near');
  });
});
