/**
 * Web Extraction nodes — test 2026-grade integration.
 *
 * Coverage REALE:
 *   - html_select: estrai text/html/attr/list da HTML
 *   - script_var_extract: trova window.X = {...} robusto a varianti quote
 *   - regex_multi: fallback chain — primo pattern wins
 *   - url_template: interpolation ${var}, conditional flags
 *
 * web_fetch_advanced ha test separato (richiede mock fetch).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved per estensione futura (interface compat)
import { describe, it, expect, vi } from 'vitest';
import { htmlSelectNode } from './html-select.js';
import { scriptVarExtractNode } from './script-var-extract.js';
import { regexMultiNode } from './regex-multi.js';
import { urlTemplateNode } from './url-template.js';

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;

describe('action_html_select', () => {
  const html = `
    <html><body>
      <h1>Hello World</h1>
      <span class="price">€42.50</span>
      <img class="hero" src="https://cdn.x/img.png" alt="hero" />
      <ul class="tags">
        <li class="tag">red</li>
        <li class="tag">blue</li>
        <li class="tag">green</li>
      </ul>
    </body></html>`;

  it('estrai text di h1', async () => {
    const r = await htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: html,
      selectorsJson: '{"title": "h1"}',
    }, null, CTX);
    expect((r.output as { fields: { title: string } }).fields.title).toBe('Hello World');
    expect((r.output as { matched: boolean }).matched).toBe(true);
  });

  it('estrai attr src da img', async () => {
    const r = await htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: html,
      selectorsJson: '{"img": {"selector": "img.hero", "extract": "attr", "attr": "src"}}',
    }, null, CTX);
    expect((r.output as { fields: { img: string } }).fields.img).toBe('https://cdn.x/img.png');
  });

  it('estrai list di .tag', async () => {
    const r = await htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: html,
      selectorsJson: '{"tags": {"selector": ".tag", "extract": "list"}}',
    }, null, CTX);
    expect((r.output as { fields: { tags: string[] } }).fields.tags).toEqual(['red', 'blue', 'green']);
  });

  it('selector inesistente → null', async () => {
    const r = await htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: html,
      selectorsJson: '{"missing": "#non-existent"}',
    }, null, CTX);
    expect((r.output as { fields: { missing: null } }).fields.missing).toBeNull();
  });

  it('HTML vuoto → matched=false', async () => {
    const r = await htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: '',
      selectorsJson: '{"x": "h1"}',
    }, null, CTX);
    expect((r.output as { matched: boolean }).matched).toBe(false);
  });

  it('errore se selectorsJson vuoto', async () => {
    await expect(htmlSelectNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: html,
      selectorsJson: '{}',
    }, null, CTX)).rejects.toThrow(/selectorsJson required/);
  });
});

describe('action_script_var_extract', () => {
  const htmlVix = `<html><body><script>
    window.video = { id: 1234, filename: 'movie.mp4' };
    window.masterPlaylist = { params: { token: "abc-123-xyz", expires: "1735000000" }, url: 'https://cdn.x/p' };
  </script></body></html>`;

  it('estrai window.video.id come number', async () => {
    const r = await scriptVarExtractNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: htmlVix,
      variables: '[{"name":"window.video","key":"id","expect":"number"}]',
    }, null, CTX);
    expect((r.output as { extracted: Record<string, unknown> }).extracted['window.video.id']).toBe(1234);
  });

  it('estrai token con quote doppie (extractKey cerca nel blocco intero)', async () => {
    // window.masterPlaylist contiene params.token al suo interno; il key
    // matcher cerca "token: " ovunque nel blocco object.
    const r = await scriptVarExtractNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: htmlVix,
      variables: '[{"name":"window.masterPlaylist","key":"token","expect":"string"}]',
    }, null, CTX);
    expect((r.output as { extracted: Record<string, unknown> }).extracted['window.masterPlaylist.token']).toBe('abc-123-xyz');
  });

  it('estrai filename con quote singole', async () => {
    const r = await scriptVarExtractNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: htmlVix,
      variables: '[{"name":"window.video","key":"filename","expect":"string"}]',
    }, null, CTX);
    expect((r.output as { extracted: Record<string, unknown> }).extracted['window.video.filename']).toBe('movie.mp4');
  });

  it('variabile inesistente → null', async () => {
    const r = await scriptVarExtractNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: htmlVix,
      variables: '[{"name":"window.ghost","key":"x"}]',
    }, null, CTX);
    expect((r.output as { extracted: Record<string, unknown> }).extracted['window.ghost']).toBeNull();
  });

  it('no script tag → matched false', async () => {
    const r = await scriptVarExtractNode.executor!({
      htmlSource: 'explicit',
      htmlExplicit: '<html><body><p>no script</p></body></html>',
      variables: '[{"name":"window.video","key":"id"}]',
    }, null, CTX);
    expect((r.output as { matched: boolean }).matched).toBe(false);
  });
});

describe('action_regex_multi', () => {
  it('fallback chain: primo pattern wins', async () => {
    const text = 'token: "abc123" some other text';
    const r = await regexMultiNode.executor!({
      textSource: 'explicit',
      textExplicit: text,
      fieldsJson: JSON.stringify({
        token: {
          patterns: [
            { pattern: 'NOMATCH_REGEX_FIRST_(\\w+)', group: 1 },
            { pattern: 'token:\\s*"([^"]+)"', group: 1, transform: 'trim' },
          ],
        },
      }),
    }, null, CTX);
    expect((r.output as { fields: { token: string } }).fields.token).toBe('abc123');
  });

  it('transform: number', async () => {
    const r = await regexMultiNode.executor!({
      textSource: 'explicit',
      textExplicit: 'price=€42.50 EUR',
      fieldsJson: JSON.stringify({
        price: {
          patterns: [{ pattern: 'price=€(\\d+\\.\\d+)', group: 1, transform: 'number' }],
        },
      }),
    }, null, CTX);
    expect((r.output as { fields: { price: number } }).fields.price).toBe(42.5);
  });

  it('defaultValue se nessun pattern matcha', async () => {
    const r = await regexMultiNode.executor!({
      textSource: 'explicit',
      textExplicit: 'hello',
      fieldsJson: JSON.stringify({
        x: {
          patterns: [{ pattern: 'GHOST_(\\w+)', group: 1 }],
          defaultValue: 'fallback',
        },
      }),
    }, null, CTX);
    expect((r.output as { fields: { x: string } }).fields.x).toBe('fallback');
  });

  it('regex invalida nel chain → skip + continua', async () => {
    const r = await regexMultiNode.executor!({
      textSource: 'explicit',
      textExplicit: 'hello world',
      fieldsJson: JSON.stringify({
        x: {
          patterns: [
            { pattern: '[invalid(((', group: 1 }, // invalid regex
            { pattern: '(world)', group: 1 },     // valid
          ],
        },
      }),
    }, null, CTX);
    expect((r.output as { fields: { x: string } }).fields.x).toBe('world');
  });
});

describe('action_url_template', () => {
  it('interpolation base + query params', async () => {
    const r = await urlTemplateNode.executor!({
      template: 'https://${host}/playlist/${videoId}',
      queryParams: JSON.stringify({ token: '${token}', language: 'it' }),
      vars: JSON.stringify({ host: 'vixcloud.co', videoId: '1234', token: 'abc123' }),
    }, null, CTX);
    expect((r.output as { url: string }).url).toContain('https://vixcloud.co/playlist/1234');
    expect((r.output as { url: string }).url).toContain('token=abc123');
    expect((r.output as { url: string }).url).toContain('language=it');
  });

  it('conditional flag aggiunto se condizione vera', async () => {
    const r = await urlTemplateNode.executor!({
      template: 'https://x.io/v',
      conditionalFlags: JSON.stringify([
        { if: '${flags.fhd}', add: { h: '1' } },
        { if: '${flags.boost}', add: { b: '1' } },
      ]),
      vars: JSON.stringify({ flags: { fhd: true, boost: false } }),
    }, null, CTX);
    const params = (r.output as { params: Record<string, string> }).params;
    expect(params.h).toBe('1');
    expect(params.b).toBeUndefined();
  });

  it('URL invalido dopo interpolation → throw', async () => {
    await expect(urlTemplateNode.executor!({
      template: 'not-a-url',
      queryParams: {},
    }, null, CTX)).rejects.toThrow(/Invalid URL/);
  });

  it('input come var disponibile (oltre a vars custom)', async () => {
    const r = await urlTemplateNode.executor!({
      template: 'https://api.io/${id}',
      queryParams: {},
    }, { id: 'xyz789' }, CTX);
    expect((r.output as { url: string }).url).toBe('https://api.io/xyz789');
  });
});

describe('nodes def metadata', () => {
  it('tutti i 4 nodi hanno description ricca (> 100 char)', () => {
    expect(htmlSelectNode.def.description.length).toBeGreaterThan(100);
    expect(scriptVarExtractNode.def.description.length).toBeGreaterThan(100);
    expect(regexMultiNode.def.description.length).toBeGreaterThan(100);
    expect(urlTemplateNode.def.description.length).toBeGreaterThan(100);
  });

  it('tutti hanno configFields con help inline', () => {
    for (const node of [htmlSelectNode, scriptVarExtractNode, regexMultiNode, urlTemplateNode]) {
      const fields = node.def.configFields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      const withHelp = fields.filter((f) => f.help && f.help.length > 10);
      expect(withHelp.length).toBeGreaterThan(0);
    }
  });

  it('tutti i nodi sono type=action', () => {
    expect(htmlSelectNode.def.type).toBe('action');
    expect(scriptVarExtractNode.def.type).toBe('action');
    expect(regexMultiNode.def.type).toBe('action');
    expect(urlTemplateNode.def.type).toBe('action');
  });
});
