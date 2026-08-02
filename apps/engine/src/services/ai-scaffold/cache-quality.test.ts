import { describe, it, expect } from 'vitest';
import {
  hasStructuralFix,
  isWorkflowCacheWorthy,
  shouldEvictCachedEntry,
} from './cache-quality.js';

describe('cache-quality — solo workflow di alta qualità diventano template', () => {
  it('hasStructuralFix: true sui fix che indicano grafo LLM incompleto', () => {
    expect(hasStructuralFix(['orphan_edge_healed'])).toBe(true);
    expect(hasStructuralFix(['fan_in_merge_inserted'])).toBe(true);
    expect(hasStructuralFix(['merge_duplicate_nodes'])).toBe(true);
    expect(hasStructuralFix(['placeholder_to_secret', 'id_to_picker_marker'])).toBe(false); // triviali
    expect(hasStructuralFix([])).toBe(false);
  });

  it('isWorkflowCacheWorthy: NO se heal strutturale o warning', () => {
    expect(isWorkflowCacheWorthy([], 0)).toBe(true); // pulito → cachabile
    expect(isWorkflowCacheWorthy(['placeholder_to_secret'], 0)).toBe(true); // solo triviale → cachabile
    expect(isWorkflowCacheWorthy(['orphan_edge_healed'], 0)).toBe(false); // heal strutturale → NO
    expect(isWorkflowCacheWorthy([], 2)).toBe(false); // quality-warning → NO
    expect(isWorkflowCacheWorthy(['placeholder_to_secret'], 1)).toBe(false); // warning → NO
  });

  it('shouldEvictCachedEntry: evict se la entry richiede heal strutturale su retrieval', () => {
    expect(shouldEvictCachedEntry(['orphan_edge_healed'])).toBe(true); // bug Sitemap Crawler → evict
    expect(shouldEvictCachedEntry(['placeholder_to_secret'])).toBe(false); // triviale → tieni
    expect(shouldEvictCachedEntry([])).toBe(false); // niente da sanare → tieni
  });
});
