/**
 * Test bug-bounty — web-format (action_html_extract + action_markdown).
 * Era SENZA test (gap gate). La description di action_markdown PROMETTE "anti-XSS"
 * (escape + whitelist + solo http/https): qui lo ASSERISCO (no aspirazionale).
 */
import { describe, it, expect } from 'vitest';
import { htmlExtractNode, markdownNode } from './web-format.js';

const ext = htmlExtractNode.executor!;
const md = markdownNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const eo = async (cfg: Record<string, unknown>, input?: unknown) =>
  (await ext(cfg, input, ctx)).output as Record<string, unknown>;
const mo = async (cfg: Record<string, unknown>, input?: unknown) =>
  (await md(cfg, input, ctx)).output as { html: string; length: number };

describe('action_html_extract', () => {
  const html =
    '<html><head><title>Mio &amp; Titolo</title><meta property="og:image" content="https://x/i.png"></head>' +
    '<body><script>alert(1)</script><h1>Capo</h1><p>Ciao <a href="https://x.it/a">link</a></p>' +
    '<img src="https://x/p.jpg"><h2>Sub</h2></body></html>';
  it('text: rimuove tag+script, decodifica entità', async () => {
    const r = await eo({ operation: 'text', html });
    expect(r.result).not.toContain('alert(1)');
    expect(r.result).not.toContain('<');
    expect(String(r.result)).toContain('Capo');
  });
  it('links: { href, text } + count', async () => {
    const r = await eo({ operation: 'links', html });
    expect(r.result).toEqual([{ href: 'https://x.it/a', text: 'link' }]);
    expect(r.count).toBe(1);
  });
  it('images, title (entità decodificata), meta og, headings con livello', async () => {
    expect((await eo({ operation: 'images', html })).result).toEqual(['https://x/p.jpg']);
    expect((await eo({ operation: 'title', html })).result).toBe('Mio & Titolo');
    expect((await eo({ operation: 'meta', html })).result).toMatchObject({
      'og:image': 'https://x/i.png',
    });
    expect((await eo({ operation: 'headings', html })).result).toEqual([
      { level: 1, text: 'Capo' },
      { level: 2, text: 'Sub' },
    ]);
  });
  it('🚨 operazione sconosciuta → throw', async () => {
    await expect(ext({ operation: 'nope', html }, undefined, ctx)).rejects.toThrow(/sconosciuta/);
  });
});

describe('action_markdown — anti-XSS', () => {
  it('titoli/grassetto/corsivo/codice/liste/link', async () => {
    const r = await mo({ markdown: '# T\n\n**b** *i* `c`\n\n- a\n- b\n\n[x](https://e.com)' });
    expect(r.html).toContain('<h1>T</h1>');
    expect(r.html).toContain('<strong>b</strong>');
    expect(r.html).toContain('<em>i</em>');
    expect(r.html).toContain('<code>c</code>');
    expect(r.html).toContain('<li>a</li>');
    expect(r.html).toContain('<a href="https://e.com" rel="noopener noreferrer">x</a>');
  });
  it("🚨 HTML grezzo dell'utente viene ESCAPATO (no injection)", async () => {
    const r = await mo({ markdown: 'ciao <img src=x onerror=alert(1)> <script>evil()</script>' });
    expect(r.html).not.toContain('<img');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;img');
    expect(r.html).toContain('&lt;script&gt;');
  });
  it('🚨 link javascript: NON viene reso come <a> (solo http/https)', async () => {
    const r = await mo({ markdown: '[click](javascript:alert(1))' });
    expect(r.html).not.toContain('href="javascript');
    expect(r.html).not.toContain('<a ');
    expect(r.html).toContain('javascript:alert(1)'); // resta testo (escapato), non link
  });
  it("🚨 URL con virgolette non rompe l'attributo href", async () => {
    const r = await mo({ markdown: '[x](https://e.com/a"b)' });
    expect(r.html).not.toMatch(/href="https:\/\/e\.com\/a"b"/); // " spezzante neutralizzato
  });
});
