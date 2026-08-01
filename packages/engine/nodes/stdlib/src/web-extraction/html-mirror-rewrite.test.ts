/**
 * Tests for HTML mirror rewriter.
 *
 * Pure function — no I/O, no mocks. All cases driven by string fixtures.
 */

import { describe, it, expect } from 'vitest';
import { posix as nodePathPosix } from 'node:path';
import { rewriteHtml, htmlMirrorRewriteNode, relativePosix } from './html-mirror-rewrite.js';

describe('relativePosix — sostituto puro di path.relative (browser-safe)', () => {
  // Oracolo: deve combaciare con node:path.posix.relative su path assoluti.
  const cases: [string, string][] = [
    ['/a/b', '/a/c/d'],
    ['/a/b', '/a/b'],
    ['/opt/mirror/blog/post1', '/opt/mirror/assets/img/x.png'],
    ['/opt/mirror/example.com/blog/post-1', '/opt/mirror/example.com/assets/app.css'],
    ['/a/b/c', '/a'],
    ['/x', '/x/y/z'],
    ['/a//b/', '/a/b/c'],            // separatori ridondanti
    ['/a/./b', '/a/b/c'],            // segmenti "."
  ];
  for (const [from, to] of cases) {
    it(`relative(${from}, ${to}) === node:path.posix.relative`, () => {
      expect(relativePosix(from, to)).toBe(nodePathPosix.relative(from, to));
    });
  }
  it('same dir → stringa vuota (come path.relative)', () => {
    expect(relativePosix('/a/b/c', '/a/b/c')).toBe('');
  });
});

const PAGE = 'https://example.com/blog/post-1/';
const HTML_DIR = '/opt/mirror/example.com/blog/post-1';

function map(entries: readonly [string, string][]): Record<string, string> {
  return Object.fromEntries(entries);
}

describe('rewriteHtml — single-URL attributes', () => {
  it('rewrites <a href> absolute → relative local path', () => {
    const html = '<a href="https://example.com/about.html">About</a>';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/about.html', '/opt/mirror/example.com/about.html']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('href="../../about.html"');
    expect(r.stats.rewritten).toBe(1);
  });

  it('rewrites <img src> + preserves alt + other attrs', () => {
    const html = '<img src="https://example.com/img/logo.png" alt="logo" width="100">';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/img/logo.png', '/opt/mirror/example.com/img/logo.png']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('src="../../img/logo.png"');
    expect(r.html).toContain('alt="logo"');
    expect(r.html).toContain('width="100"');
  });

  it('rewrites multiple attrs across <script>, <link>, <iframe>', () => {
    const html = `
      <link rel="stylesheet" href="https://example.com/css/main.css">
      <script src="https://example.com/js/app.js"></script>
      <iframe src="https://example.com/embed.html"></iframe>
    `;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([
        ['https://example.com/css/main.css', '/opt/mirror/example.com/css/main.css'],
        ['https://example.com/js/app.js', '/opt/mirror/example.com/js/app.js'],
        ['https://example.com/embed.html', '/opt/mirror/example.com/embed.html'],
      ]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.stats.rewritten).toBe(3);
    expect(r.html).toContain('../../css/main.css');
    expect(r.html).toContain('../../js/app.js');
    expect(r.html).toContain('../../embed.html');
  });

  it('leaves URLs absent from assetMap as-is', () => {
    const html = '<a href="https://external.com/page">External</a>';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: {}, stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('href="https://external.com/page"');
    expect(r.stats.unchanged).toBe(1);
  });

  it('skips data:/mailto:/tel:/javascript: URIs', () => {
    const html = `
      <a href="mailto:x@y.com">mail</a>
      <a href="tel:+39123">phone</a>
      <a href="javascript:void(0)">js</a>
      <img src="data:image/gif;base64,R0lGOD">
    `;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: {}, stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('mailto:x@y.com');
    expect(r.html).toContain('tel:+39123');
    expect(r.html).toContain('javascript:void(0)');
    expect(r.html).toContain('data:image');
    expect(r.stats.skippedScheme).toBe(4);
  });

  it('preserves fragment-only anchors (#section)', () => {
    const html = '<a href="#top">Top</a>';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: {}, stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('href="#top"');
    expect(r.stats.unchanged).toBe(1);
  });

  it('resolves relative URLs against pageUrl before lookup', () => {
    const html = '<img src="../shared/logo.png">';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/blog/shared/logo.png', '/opt/mirror/example.com/blog/shared/logo.png']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('../shared/logo.png');
    expect(r.stats.rewritten).toBe(1);
  });
});

describe('rewriteHtml — srcset', () => {
  it('rewrites img[srcset] multi-URL with descriptors', () => {
    const html = `<img srcset="https://example.com/a-1x.png 1x, https://example.com/a-2x.png 2x">`;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([
        ['https://example.com/a-1x.png', '/opt/mirror/example.com/a-1x.png'],
        ['https://example.com/a-2x.png', '/opt/mirror/example.com/a-2x.png'],
      ]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('1x');
    expect(r.html).toContain('2x');
    expect(r.html).toContain('a-1x.png');
    expect(r.html).toContain('a-2x.png');
    expect(r.html).not.toMatch(/https:\/\/example\.com\/a-1x\.png/);
    expect(r.stats.rewritten).toBe(2);
  });

  it('partial srcset rewrite — keeps unmapped entries absolute', () => {
    const html = `<img srcset="https://example.com/a.png 1x, https://other.com/b.png 2x">`;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/a.png', '/opt/mirror/example.com/a.png']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.stats.rewritten).toBe(1);
    expect(r.html).toContain('https://other.com/b.png');
  });
});

describe('rewriteHtml — CSS url(...)', () => {
  it('rewrites <style> block url() rules', () => {
    const html = `<style>body { background: url(https://example.com/bg.png); }</style>`;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/bg.png', '/opt/mirror/example.com/bg.png']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('url(../../bg.png)');
    expect(r.stats.rewritten).toBe(1);
  });

  it('rewrites style="" attribute url() rules with quotes', () => {
    const html = `<div style='background-image: url("https://example.com/bg.png")'></div>`;
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/bg.png', '/opt/mirror/example.com/bg.png']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('../../bg.png');
    expect(r.stats.rewritten).toBe(1);
  });
});

describe('rewriteHtml — query + fragment policy', () => {
  it('strips query by default, preserves fragment by default', () => {
    const html = '<a href="https://example.com/page?ref=1#section">x</a>';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/page?ref=1', '/opt/mirror/example.com/page.html']]),
      stripQuery: true, stripFragment: false,
    });
    expect(r.html).toContain('page.html#section');
    expect(r.html).not.toContain('?ref=1');
  });

  it('preserves query when stripQuery=false', () => {
    const html = '<a href="https://example.com/page?ref=1">x</a>';
    const r = rewriteHtml(html, {
      pageUrl: PAGE, htmlSaveDir: HTML_DIR,
      assetMap: map([['https://example.com/page?ref=1', '/opt/mirror/example.com/page.html']]),
      stripQuery: false, stripFragment: false,
    });
    expect(r.html).toContain('page.html?ref=1');
  });
});

describe('htmlMirrorRewriteNode — NodeModule', () => {
  it('declares the expected NodeDef shape', () => {
    expect(htmlMirrorRewriteNode.def.id).toBe('action_html_mirror_rewrite');
    expect(typeof htmlMirrorRewriteNode.executor).toBe('function');
  });

  it('rejects missing pageUrl', async () => {
    await expect(htmlMirrorRewriteNode.executor!(
      { html: '<a></a>', pageUrl: '', htmlSaveDir: '/tmp' }, {},
      { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    )).rejects.toThrow(/pageUrl required/);
  });

  it('rejects relative htmlSaveDir', async () => {
    await expect(htmlMirrorRewriteNode.executor!(
      { html: '<a></a>', pageUrl: 'https://x.com', htmlSaveDir: 'rel/dir' }, {},
      { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    )).rejects.toThrow(/absolute path/);
  });

  it('accepts JSON string for assetMap (round-trips correctly)', async () => {
    const r = await htmlMirrorRewriteNode.executor!(
      {
        html: '<img src="https://example.com/x.png">',
        pageUrl: PAGE, htmlSaveDir: HTML_DIR,
        assetMap: JSON.stringify({ 'https://example.com/x.png': '/opt/mirror/example.com/x.png' }),
      }, {}, { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    );
    const out = r.output as { stats: { rewritten: number } };
    expect(out.stats.rewritten).toBe(1);
  });
});
