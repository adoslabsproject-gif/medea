/**
 * Test REALI di action_set_fields, action_coalesce, action_filter,
 * action_html_extract, action_markdown, action_diff, action_mock_data — eseguono
 * gli executor veri su dati reali, niente stub. Coprono immutabilità, dot-path,
 * combinatori AND/OR, anti-XSS, deep diff e riproducibilità via seed.
 */
import { describe, it, expect } from 'vitest';
import { setFieldsNode, coalesceNode } from './object-ops.js';
import { filterNode } from './filter.js';
import { htmlExtractNode, markdownNode } from './web-format.js';
import { diffNode } from './compare.js';
import { mockDataNode } from './mock.js';

const setFields = setFieldsNode.executor!;
const coalesce = coalesceNode.executor!;
const filter = filterNode.executor!;
const htmlExtract = htmlExtractNode.executor!;
const markdown = markdownNode.executor!;
const diff = diffNode.executor!;
const mock = mockDataNode.executor!;
const ctx = {} as never;

describe('action_set_fields', () => {
  it('imposta campi annidati con conversione di tipo', async () => {
    const r = await setFields(
      { source: '{}', assignments: '{"cliente.stato":"attivo","eta":"30","vip":"true"}' },
      undefined,
      ctx,
    );
    const res = (r.output as { result: Record<string, unknown> }).result;
    expect(res).toEqual({ cliente: { stato: 'attivo' }, eta: 30, vip: true });
  });
  it("non muta l'input (opera su copia)", async () => {
    const base = { a: 1 };
    await setFields({ source: base, assignments: '{"b":"2"}' }, undefined, ctx);
    expect(base).toEqual({ a: 1 });
  });
  it('rename sposta un campo', async () => {
    const r = await setFields(
      { source: '{"Email":"x@y.it"}', renameFields: '{"Email":"email"}' },
      undefined,
      ctx,
    );
    const res = (r.output as { result: Record<string, unknown> }).result;
    expect(res.email).toBe('x@y.it');
    expect(res).not.toHaveProperty('Email');
  });
  it('remove elimina i campi', async () => {
    const r = await setFields(
      { source: '{"a":1,"password":"x"}', removeFields: 'password' },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown> }).result).not.toHaveProperty('password');
  });
  it('keepOnly = whitelist totale', async () => {
    const r = await setFields(
      { source: '{"a":1,"b":2}', assignments: '{"c":"3"}', keepOnly: 'true' },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown> }).result).toEqual({ c: 3 });
  });
  it('input con riferimento circolare → NON crasha (deep-clone fallback)', async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular; // JSON.stringify lancerebbe
    const r = await setFields({ source: circular, assignments: '{"b":"2"}' }, undefined, ctx);
    const res = (r.output as { result: Record<string, unknown> }).result;
    expect(res.a).toBe(1);
    expect(res.b).toBe(2);
  });
});

describe('action_coalesce', () => {
  it('sceglie il primo valore presente', async () => {
    const r = await coalesce(
      { source: '{"a":"","b":"valore","c":"altro"}', paths: 'a,b,c' },
      undefined,
      ctx,
    );
    const o = r.output as { result: unknown; from: string; found: boolean };
    expect(o.result).toBe('valore');
    expect(o.from).toBe('b');
    expect(o.found).toBe(true);
  });
  it('usa il default se nessuna sorgente ha valore', async () => {
    const r = await coalesce(
      { source: '{"a":null,"b":""}', paths: 'a,b', default: 'Cliente' },
      undefined,
      ctx,
    );
    const o = r.output as { result: unknown; from: string; found: boolean };
    expect(o.result).toBe('Cliente');
    expect(o.from).toBe('(default)');
    expect(o.found).toBe(false);
  });
  it('stringa vuota saltata solo se treatEmptyAsMissing', async () => {
    const r = await coalesce(
      { source: '{"a":""}', paths: 'a', treatEmptyAsMissing: 'false', default: 'x' },
      undefined,
      ctx,
    );
    expect((r.output as { result: unknown }).result).toBe('');
  });
});

describe('action_filter', () => {
  const orders = [
    { id: 1, total: 150, region: 'Lazio' },
    { id: 2, total: 50, region: 'Lombardia' },
    { id: 3, total: 200, region: 'Lazio' },
  ];
  it('AND di più regole, branch kept', async () => {
    const r = await filter(
      {
        items: JSON.stringify(orders),
        conditions: JSON.stringify({
          combinator: 'AND',
          rules: [
            { field: 'total', op: 'gt', value: 100 },
            { field: 'region', op: 'equals', value: 'Lazio' },
          ],
        }),
      },
      undefined,
      ctx,
    );
    const o = r.output as { kept: unknown[]; removed: unknown[]; keptCount: number };
    expect(o.keptCount).toBe(2);
    expect(o.removed).toHaveLength(1);
    expect(r.branch).toBe('kept');
  });
  it('OR combina le regole', async () => {
    const r = await filter(
      {
        items: JSON.stringify(orders),
        conditions: JSON.stringify({
          combinator: 'OR',
          rules: [
            { field: 'total', op: 'lt', value: 60 },
            { field: 'region', op: 'equals', value: 'Lazio' },
          ],
        }),
      },
      undefined,
      ctx,
    );
    expect((r.output as { keptCount: number }).keptCount).toBe(3);
  });
  it('operatore regex su dot-path', async () => {
    const data = [{ user: { email: 'a@gmail.com' } }, { user: { email: 'b@azienda.it' } }];
    const r = await filter(
      {
        items: JSON.stringify(data),
        conditions: JSON.stringify({
          rules: [{ field: 'user.email', op: 'not_contains', value: 'gmail' }],
        }),
      },
      undefined,
      ctx,
    );
    expect((r.output as { keptCount: number }).keptCount).toBe(1);
  });
  it('operatore "in" lista', async () => {
    const r = await filter(
      {
        items: JSON.stringify(orders),
        conditions: JSON.stringify({
          rules: [{ field: 'region', op: 'in', value: 'Lazio,Veneto' }],
        }),
      },
      undefined,
      ctx,
    );
    expect((r.output as { keptCount: number }).keptCount).toBe(2);
  });
  it('nessuna regola → tiene tutto', async () => {
    const r = await filter(
      { items: JSON.stringify(orders), conditions: JSON.stringify({ rules: [] }) },
      undefined,
      ctx,
    );
    expect((r.output as { keptCount: number }).keptCount).toBe(3);
  });
});

describe('action_html_extract', () => {
  const html =
    '<html><head><title>Pagina &amp; Test</title><meta name="description" content="desc"><meta property="og:image" content="img.jpg"></head><body><h1>Titolo</h1><h2>Sub</h2><p>Ciao <a href="https://zeli.it">link</a></p><img src="/a.png"><script>var x=1</script></body></html>';
  it('text rimuove tag/script e decodifica entità', async () => {
    const r = await htmlExtract({ operation: 'text', html }, undefined, ctx);
    const t = (r.output as { result: string }).result;
    expect(t).toContain('Ciao link');
    expect(t).not.toContain('var x=1');
    expect(t).not.toContain('<');
  });
  it('links → href + text', async () => {
    const r = await htmlExtract({ operation: 'links', html }, undefined, ctx);
    expect((r.output as { result: { href: string; text: string }[] }).result[0]).toEqual({
      href: 'https://zeli.it',
      text: 'link',
    });
  });
  it('title decodificato', async () => {
    const r = await htmlExtract({ operation: 'title', html }, undefined, ctx);
    expect((r.output as { result: string }).result).toBe('Pagina & Test');
  });
  it('meta inclusi Open Graph', async () => {
    const r = await htmlExtract({ operation: 'meta', html }, undefined, ctx);
    const m = (r.output as { result: Record<string, string> }).result;
    expect(m.description).toBe('desc');
    expect(m['og:image']).toBe('img.jpg');
  });
  it('headings con livello', async () => {
    const r = await htmlExtract({ operation: 'headings', html }, undefined, ctx);
    expect((r.output as { result: { level: number; text: string }[] }).result).toEqual([
      { level: 1, text: 'Titolo' },
      { level: 2, text: 'Sub' },
    ]);
  });
  it('images src', async () => {
    const r = await htmlExtract({ operation: 'images', html }, undefined, ctx);
    expect((r.output as { result: string[] }).result).toEqual(['/a.png']);
  });
});

describe('action_markdown', () => {
  it('heading + bold + italic + link', async () => {
    const r = await markdown(
      { markdown: '# Titolo\n\nTesto **forte** e *enfasi* e [link](https://zeli.it)' },
      undefined,
      ctx,
    );
    const h = (r.output as { html: string }).html;
    expect(h).toContain('<h1>Titolo</h1>');
    expect(h).toContain('<strong>forte</strong>');
    expect(h).toContain('<em>enfasi</em>');
    expect(h).toContain('<a href="https://zeli.it"');
  });
  it('lista puntata', async () => {
    const r = await markdown({ markdown: '- uno\n- due' }, undefined, ctx);
    const h = (r.output as { html: string }).html;
    expect(h).toContain('<ul>');
    expect(h).toContain('<li>uno</li>');
  });
  it('anti-XSS: HTML grezzo escapato', async () => {
    const r = await markdown({ markdown: 'testo <script>alert(1)</script>' }, undefined, ctx);
    const h = (r.output as { html: string }).html;
    expect(h).toContain('&lt;script&gt;');
    expect(h).not.toContain('<script>');
  });
  it('link javascript: NON convertito (solo http/https)', async () => {
    const r = await markdown({ markdown: '[x](javascript:alert(1))' }, undefined, ctx);
    expect((r.output as { html: string }).html).not.toContain('<a href="javascript:');
  });
});

describe('action_diff', () => {
  it('deep diff oggetti: added/removed/changed', async () => {
    const r = await diff(
      {
        mode: 'object',
        a: '{"nome":"Anna","eta":30,"citta":"Roma"}',
        b: '{"nome":"Anna","eta":31,"tel":"123"}',
      },
      undefined,
      ctx,
    );
    const o = r.output as {
      added: Record<string, unknown>;
      removed: Record<string, unknown>;
      changed: Record<string, { from: unknown; to: unknown }>;
      equal: boolean;
    };
    expect(o.changed.eta).toEqual({ from: 30, to: 31 });
    expect(o.removed.citta).toBe('Roma');
    expect(o.added.tel).toBe('123');
    expect(o.equal).toBe(false);
    expect(r.branch).toBe('different');
  });
  it('oggetti identici → equal + branch equal', async () => {
    const r = await diff({ mode: 'object', a: '{"a":1}', b: '{"a":1}' }, undefined, ctx);
    expect((r.output as { equal: boolean }).equal).toBe(true);
    expect(r.branch).toBe('equal');
  });
  it('diff annidato dot-path', async () => {
    const r = await diff(
      { mode: 'object', a: '{"u":{"nome":"A"}}', b: '{"u":{"nome":"B"}}' },
      undefined,
      ctx,
    );
    expect(
      (r.output as { changed: Record<string, { from: unknown; to: unknown }> }).changed['u.nome'],
    ).toEqual({ from: 'A', to: 'B' });
  });
  it('text diff per righe', async () => {
    const r = await diff({ mode: 'text', a: 'riga1\nriga2', b: 'riga1\nriga3' }, undefined, ctx);
    const o = r.output as { added: number; removed: number; equal: boolean };
    expect(o.added).toBe(1);
    expect(o.removed).toBe(1);
    expect(o.equal).toBe(false);
  });
});

describe('action_mock_data', () => {
  it('genera N record secondo lo schema', async () => {
    const r = await mock(
      { schema: '{"nome":"fullName","mail":"email"}', count: '5' },
      undefined,
      ctx,
    );
    const items = (r.output as { items: Record<string, string>[] }).items;
    expect(items).toHaveLength(5);
    expect(typeof items[0]!.nome).toBe('string');
    expect(items[0]!.mail).toContain('@esempio.it');
  });
  it('seed → output riproducibile (deterministico)', async () => {
    const a = (
      await mock({ schema: '{"n":"fullName"}', count: '3', seed: 'fisso' }, undefined, ctx)
    ).output as { items: unknown[] };
    const b = (
      await mock({ schema: '{"n":"fullName"}', count: '3', seed: 'fisso' }, undefined, ctx)
    ).output as { items: unknown[] };
    expect(a.items).toEqual(b.items);
  });
  it('seed diversi → output diversi', async () => {
    const a = (await mock({ schema: '{"n":"fullName"}', count: '5', seed: 'A' }, undefined, ctx))
      .output as { items: unknown[] };
    const b = (await mock({ schema: '{"n":"fullName"}', count: '5', seed: 'B' }, undefined, ctx))
      .output as { items: unknown[] };
    expect(a.items).not.toEqual(b.items);
  });
  it('uuid valido + phone italiano', async () => {
    const r = await mock(
      { schema: '{"id":"uuid","tel":"phone"}', count: '1', seed: 's' },
      undefined,
      ctx,
    );
    const it = (r.output as { items: { id: string; tel: string }[] }).items[0]!;
    expect(it.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(it.tel).toMatch(/^\+39 3/);
  });
  it('schema vuoto → default (id, nome, email, citta)', async () => {
    const r = await mock({ count: '1' }, undefined, ctx);
    expect(Object.keys((r.output as { items: Record<string, unknown>[] }).items[0]!)).toEqual([
      'id',
      'nome',
      'email',
      'citta',
    ]);
  });
});
