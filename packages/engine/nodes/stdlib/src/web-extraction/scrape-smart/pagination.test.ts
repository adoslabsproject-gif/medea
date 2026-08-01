/**
 * Test reali pagination detect. NO smoke fake.
 * Asseriscono detection accurata di "next page" pattern multi-lingua.
 */
import { describe, it, expect } from 'vitest';
import { detectNextPage, incrementUrlPageParam, resolveUrl } from './pagination.js';

const BASE = 'https://example.com/blog/page-1';

describe('detectNextPage', () => {
  it('HTML vuoto → not found', () => {
    expect(detectNextPage('', BASE).found).toBe(false);
  });

  it('rel="next" link tag → trovato + method rel-next', () => {
    const html = '<link rel="next" href="/blog/page-2">';
    const r = detectNextPage(html, BASE);
    expect(r.found).toBe(true);
    expect(r.url).toBe('https://example.com/blog/page-2');
    expect(r.method).toBe('rel-next');
  });

  it('<a rel="next" href> → trovato', () => {
    const r = detectNextPage('<a rel="next" href="/p/2">More</a>', BASE);
    expect(r.found).toBe(true);
    expect(r.method).toBe('rel-next');
    expect(r.url).toBe('https://example.com/p/2');
  });

  it('aria-label="Next page" → method aria-label', () => {
    const r = detectNextPage('<a href="/p/2" aria-label="Next page">→</a>', BASE);
    expect(r.found).toBe(true);
    expect(r.method).toBe('aria-label');
  });

  it('aria-label italiano "Pagina successiva" → trovato', () => {
    const r = detectNextPage('<a href="/p/2" aria-label="Pagina successiva">›</a>', BASE);
    expect(r.found).toBe(true);
    expect(r.method).toBe('aria-label');
  });

  it('text "Next" dentro <a> → method text-match', () => {
    const r = detectNextPage('<a href="/p/2">Next</a>', BASE);
    expect(r.found).toBe(true);
    expect(r.method).toBe('text-match');
    expect(r.evidence).toContain('Next');
  });

  it('text italiano "Successivo"', () => {
    const r = detectNextPage('<a href="/p/2">Successivo</a>', BASE);
    expect(r.found).toBe(true);
    expect(r.method).toBe('text-match');
  });

  it('text "Avanti" italiano', () => {
    const r = detectNextPage('<a href="/p/2">Avanti</a>', BASE);
    expect(r.found).toBe(true);
  });

  it('text "Suivant" francese', () => {
    const r = detectNextPage('<a href="/p/2">Suivant</a>', BASE);
    expect(r.found).toBe(true);
  });

  it('text "Siguiente" spagnolo', () => {
    const r = detectNextPage('<a href="/p/2">Siguiente</a>', BASE);
    expect(r.found).toBe(true);
  });

  it('text "›" simbolo', () => {
    const r = detectNextPage('<a href="/p/2">›</a>', BASE);
    expect(r.found).toBe(true);
  });

  it('text "→" simbolo', () => {
    const r = detectNextPage('<a href="/p/2">→</a>', BASE);
    expect(r.found).toBe(true);
  });

  it('URL pattern ?page=N → fallback ultimo, page=N+1', () => {
    const r = detectNextPage('<html></html>', 'https://x.com/list?page=3');
    expect(r.found).toBe(true);
    expect(r.method).toBe('url-pattern');
    expect(r.url).toBe('https://x.com/list?page=4');
  });

  it('URL pattern ?p=5 → p=6', () => {
    const r = detectNextPage('<html></html>', 'https://x.com?p=5');
    expect(r.url).toBe('https://x.com/?p=6');
  });

  it('URL pattern ?offset=20 → offset=40 (double)', () => {
    const r = detectNextPage('<html></html>', 'https://x.com?offset=20');
    expect(r.url).toBe('https://x.com/?offset=40');
  });

  it('HTML clean + URL senza pattern → NOT found', () => {
    const r = detectNextPage('<p>just text</p>', 'https://x.com/home');
    expect(r.found).toBe(false);
  });

  it('Priorita\\` rel-next sopra text-match', () => {
    const html = '<a rel="next" href="/rel-target">Next</a><a href="/text-target">Successivo</a>';
    const r = detectNextPage(html, BASE);
    expect(r.method).toBe('rel-next');
    expect(r.url).toBe('https://example.com/rel-target');
  });
});

describe('incrementUrlPageParam', () => {
  it('page=N → page=N+1', () => {
    const r = incrementUrlPageParam('https://x.com?page=7');
    expect(r?.url).toBe('https://x.com/?page=8');
    expect(r?.evidence).toContain('7 → 8');
  });

  it('no page param → null', () => {
    expect(incrementUrlPageParam('https://x.com/home')).toBeNull();
  });

  it('page=abc (non numerico) → null', () => {
    expect(incrementUrlPageParam('https://x.com?page=abc')).toBeNull();
  });

  it('URL invalida → null', () => {
    expect(incrementUrlPageParam('not-a-url')).toBeNull();
  });

  it('pagina= italiano supportato', () => {
    const r = incrementUrlPageParam('https://x.com?pagina=2');
    expect(r?.url).toBe('https://x.com/?pagina=3');
  });
});

describe('resolveUrl', () => {
  it('relativo → assoluto', () => {
    expect(resolveUrl('/p/2', 'https://x.com/list')).toBe('https://x.com/p/2');
  });

  it('assoluto → invariato', () => {
    expect(resolveUrl('https://other.com/x', 'https://x.com')).toBe('https://other.com/x');
  });

  it('href invalido → ritornato as-is', () => {
    expect(resolveUrl('mailto:x', 'https://x.com')).toBe('mailto:x');
  });
});
