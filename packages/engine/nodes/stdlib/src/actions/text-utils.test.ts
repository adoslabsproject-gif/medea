/**
 * Test REALI di action_text e action_template — eseguono gli executor veri su
 * input reali, niente stub. Coprono slugify con accenti, extract regex con gruppi,
 * interpolazione con default || e l'escape HTML anti-XSS.
 */
import { describe, it, expect } from 'vitest';
import { textNode, templateNode } from './text-utils.js';

const text = textNode.executor!;
const template = templateNode.executor!;
const ctx = {} as never;

describe('action_text', () => {
  it('uppercase / lowercase / capitalize / title', async () => {
    expect(
      (
        (await text({ operation: 'uppercase', value: 'ciao' }, undefined, ctx)).output as {
          result: string;
        }
      ).result,
    ).toBe('CIAO');
    expect(
      (
        (await text({ operation: 'capitalize', value: 'ciAO mondo' }, undefined, ctx)).output as {
          result: string;
        }
      ).result,
    ).toBe('Ciao mondo');
    expect(
      (
        (await text({ operation: 'title', value: 'il bel paese' }, undefined, ctx)).output as {
          result: string;
        }
      ).result,
    ).toBe('Il Bel Paese');
  });
  it('slugify rimuove accenti e caratteri speciali', async () => {
    const r = await text({ operation: 'slugify', value: 'Caffè à gogò! 2026' }, undefined, ctx);
    expect((r.output as { result: string }).result).toBe('caffe-a-gogo-2026');
  });
  it('truncate aggiunge il suffisso e rispetta la lunghezza', async () => {
    const r = await text(
      { operation: 'truncate', value: 'una frase abbastanza lunga da tagliare', length: '15' },
      undefined,
      ctx,
    );
    const out = (r.output as { result: string }).result;
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out.endsWith('…')).toBe(true);
  });
  it('truncate non tocca testi già corti', async () => {
    const r = await text({ operation: 'truncate', value: 'corto', length: '50' }, undefined, ctx);
    expect((r.output as { result: string }).result).toBe('corto');
  });
  it('replace letterale tutte le occorrenze', async () => {
    const r = await text(
      { operation: 'replace', value: 'a-b-c', search: '-', replacement: '_' },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('a_b_c');
  });
  it('replace con regex e gruppi ($1)', async () => {
    const r = await text(
      {
        operation: 'replace',
        value: '2026-06-06',
        search: '(\\d+)-(\\d+)-(\\d+)',
        replacement: '$3/$2/$1',
        useRegex: 'true',
      },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('06/06/2026');
  });
  it('extract email con conteggio e first', async () => {
    const r = await text(
      { operation: 'extract', value: 'scrivi a a@b.it o c@d.com', search: '[\\w.]+@[\\w.]+' },
      undefined,
      ctx,
    );
    const o = r.output as { matches: string[]; count: number; first: string };
    expect(o.matches).toEqual(['a@b.it', 'c@d.com']);
    expect(o.count).toBe(2);
    expect(o.first).toBe('a@b.it');
  });
  it('extract con gruppi di cattura', async () => {
    const r = await text(
      { operation: 'extract', value: 'prezzo: 12€, 34€', search: '(\\d+)€' },
      undefined,
      ctx,
    );
    expect((r.output as { groups: string[][] }).groups).toEqual([['12'], ['34']]);
  });
  it('split con trim delle parti', async () => {
    const r = await text(
      { operation: 'split', value: 'a, b ,c', search: ',', trimParts: 'true' },
      undefined,
      ctx,
    );
    expect((r.output as { result: string[] }).result).toEqual(['a', 'b', 'c']);
  });
  it('pad start con zeri', async () => {
    const r = await text(
      { operation: 'pad', value: '42', length: '5', suffix: '0', padSide: 'start' },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('00042');
  });
  it("usa l'input se value è vuoto", async () => {
    const r = await text({ operation: 'uppercase' }, 'fromInput', ctx);
    expect((r.output as { result: string }).result).toBe('FROMINPUT');
  });
  it('operazione sconosciuta → throw', async () => {
    await expect(text({ operation: 'nope', value: 'x' }, undefined, ctx)).rejects.toThrow(
      /sconosciuta/,
    );
  });
});

describe('action_template', () => {
  it('interpola dot-path annidato', async () => {
    const r = await template(
      {
        template: 'Ciao {{ user.name }}, ordine {{ order.id }}',
        context: JSON.stringify({ user: { name: 'Anna' }, order: { id: 'A-1' } }),
      },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('Ciao Anna, ordine A-1');
  });
  it('default con || quando il campo manca', async () => {
    const r = await template(
      { template: 'Ciao {{ nome || "Cliente" }}', context: '{}' },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('Ciao Cliente');
  });
  it('segnala i segnaposto mancanti (missing/hasMissing)', async () => {
    const r = await template(
      { template: '{{ a }} {{ b }}', context: JSON.stringify({ a: 'ok' }) },
      undefined,
      ctx,
    );
    const o = r.output as { result: string; missing: string[]; hasMissing: boolean };
    expect(o.result).toBe('ok ');
    expect(o.missing).toEqual(['b']);
    expect(o.hasMissing).toBe(true);
  });
  it('escape HTML anti-XSS quando attivo', async () => {
    const r = await template(
      {
        template: 'Nome: {{ name }}',
        context: JSON.stringify({ name: '<script>alert(1)</script>' }),
        escapeHtml: 'true',
      },
      undefined,
      ctx,
    );
    const out = (r.output as { result: string }).result;
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });
  it('senza escape lascia il valore grezzo', async () => {
    const r = await template(
      { template: '{{ html }}', context: JSON.stringify({ html: '<b>x</b>' }) },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('<b>x</b>');
  });
  it('oggetti vengono serializzati in JSON', async () => {
    const r = await template(
      { template: '{{ obj }}', context: JSON.stringify({ obj: { a: 1 } }) },
      undefined,
      ctx,
    );
    expect((r.output as { result: string }).result).toBe('{"a":1}');
  });
});
