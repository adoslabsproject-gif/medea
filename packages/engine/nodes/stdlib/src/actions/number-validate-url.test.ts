/**
 * Test REALI di action_number, action_aggregate, action_validate, action_url —
 * eseguono gli executor veri. I test di validazione usano CHECKSUM realmente
 * validi (P.IVA/CF/IBAN noti) e casi che una regex ingenua accetterebbe ma il
 * checksum corretto rifiuta. Niente stub.
 */
import { describe, it, expect } from 'vitest';
import { numberNode, aggregateNode } from './number-utils.js';
import { validateNode } from './validate.js';
import { urlNode } from './url-utils.js';

const num = numberNode.executor!;
const agg = aggregateNode.executor!;
const val = validateNode.executor!;
const url = urlNode.executor!;
const ctx = {} as never;

describe('action_number', () => {
  it('round a 2 decimali (no float drift): 1.005→1.01, 8.575→8.58', async () => {
    expect(
      (
        (await num({ operation: 'round', value: '1.005', decimals: '2' }, undefined, ctx))
          .output as { result: number }
      ).result,
    ).toBe(1.01);
    expect(
      (
        (await num({ operation: 'round', value: '8.575', decimals: '2' }, undefined, ctx))
          .output as { result: number }
      ).result,
    ).toBe(8.58);
    expect(
      (
        (await num({ operation: 'round', value: '-1.005', decimals: '2' }, undefined, ctx))
          .output as { result: number }
      ).result,
    ).toBe(-1.01);
  });
  it('clamp vincola tra min e max', async () => {
    expect(
      (
        (await num({ operation: 'clamp', value: '150', min: '0', max: '100' }, undefined, ctx))
          .output as { result: number }
      ).result,
    ).toBe(100);
    expect(
      (
        (await num({ operation: 'clamp', value: '-5', min: '0', max: '100' }, undefined, ctx))
          .output as { result: number }
      ).result,
    ).toBe(0);
  });
  it('percent di un totale (IVA 22%)', async () => {
    const r = await num({ operation: 'percent', value: '22', total: '100' }, undefined, ctx);
    expect((r.output as { result: number }).result).toBe(22);
  });
  it('currency in formato italiano EUR', async () => {
    const r = await num(
      { operation: 'currency', value: '1234.5', currency: 'EUR', locale: 'it-IT' },
      undefined,
      ctx,
    );
    const out = (r.output as { result: string }).result;
    // separatore migliaia opzionale: dipende dall'ICU build (full vs small) della macchina
    expect(out).toMatch(/1\.?234,50/);
    expect(out).toContain('€');
  });
  it('parse formato italiano "1.234,56 €" → 1234.56', async () => {
    const r = await num({ operation: 'parse', value: '1.234,56 €' }, undefined, ctx);
    expect((r.output as { result: number }).result).toBe(1234.56);
  });
  it('parse formato US "1,234.56" → 1234.56', async () => {
    const r = await num({ operation: 'parse', value: '1,234.56' }, undefined, ctx);
    expect((r.output as { result: number }).result).toBe(1234.56);
  });
  it('valore non numerico → throw', async () => {
    await expect(num({ operation: 'round', value: 'abc' }, undefined, ctx)).rejects.toThrow(
      /non numerico/,
    );
  });
});

describe('action_aggregate', () => {
  it('all → statistiche complete', async () => {
    const r = await agg(
      { operation: 'all', items: JSON.stringify([10, 20, 30, 40]) },
      undefined,
      ctx,
    );
    const s = (
      r.output as {
        result: {
          sum: number;
          avg: number;
          min: number;
          max: number;
          median: number;
          count: number;
        };
      }
    ).result;
    expect(s.sum).toBe(100);
    expect(s.avg).toBe(25);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.median).toBe(25);
    expect(s.count).toBe(4);
  });
  it('mediana di numero dispari di elementi', async () => {
    const r = await agg({ operation: 'all', items: JSON.stringify([5, 1, 3]) }, undefined, ctx);
    expect((r.output as { result: { median: number } }).result.median).toBe(3);
  });
  it('aggrega un campo dot-path di oggetti', async () => {
    const orders = [{ totale: 100 }, { totale: 200 }, { totale: 50 }];
    const r = await agg(
      { operation: 'sum', key: 'totale', items: JSON.stringify(orders) },
      undefined,
      ctx,
    );
    expect((r.output as { sum: number }).sum).toBe(350);
  });
  it('ignora valori non numerici', async () => {
    const r = await agg(
      { operation: 'all', items: JSON.stringify([10, 'x', 20, null]) },
      undefined,
      ctx,
    );
    expect((r.output as { result: { count: number; sum: number } }).result.count).toBe(2);
    expect((r.output as { result: { sum: number } }).result.sum).toBe(30);
  });
  it('stddev coerente', async () => {
    const r = await agg(
      { operation: 'all', items: JSON.stringify([2, 4, 4, 4, 5, 5, 7, 9]) },
      undefined,
      ctx,
    );
    expect((r.output as { result: { stddev: number } }).result.stddev).toBeCloseTo(2, 5);
  });
});

describe('action_validate', () => {
  it('email valida/invalida + normalize lowercase', async () => {
    const ok = await val({ type: 'email', value: 'Mario.Rossi@Esempio.IT' }, undefined, ctx);
    expect((ok.output as { valid: boolean; normalized: string }).valid).toBe(true);
    expect((ok.output as { normalized: string }).normalized).toBe('mario.rossi@esempio.it');
    expect(ok.branch).toBe('valid');
    const ko = await val({ type: 'email', value: 'non-una-email' }, undefined, ctx);
    expect((ko.output as { valid: boolean }).valid).toBe(false);
    expect(ko.branch).toBe('invalid');
  });
  it('Partita IVA: checksum valido vs cifra di controllo errata', async () => {
    // 00743110157 (Esselunga) — P.IVA reale con checksum corretto
    expect(
      (
        (await val({ type: 'piva', value: '00743110157' }, undefined, ctx)).output as {
          valid: boolean;
        }
      ).valid,
    ).toBe(true);
    // stessa con ultima cifra cambiata → regex passerebbe (11 cifre) ma checksum no
    expect(
      (
        (await val({ type: 'piva', value: '00743110158' }, undefined, ctx)).output as {
          valid: boolean;
        }
      ).valid,
    ).toBe(false);
    // 10 cifre → formato errato
    expect(
      (
        (await val({ type: 'piva', value: '1234567890' }, undefined, ctx)).output as {
          valid: boolean;
        }
      ).valid,
    ).toBe(false);
  });
  it('Codice Fiscale: carattere di controllo ufficiale', async () => {
    // CF di esempio con check char corretto
    expect(
      (
        (await val({ type: 'codice_fiscale', value: 'RSSMRA85T10A562S' }, undefined, ctx))
          .output as { valid: boolean }
      ).valid,
    ).toBe(true);
    // stesso CF con check char sbagliato (ultima lettera) → rifiutato
    expect(
      (
        (await val({ type: 'codice_fiscale', value: 'RSSMRA85T10A562X' }, undefined, ctx))
          .output as { valid: boolean }
      ).valid,
    ).toBe(false);
  });
  it('IBAN: mod-97 valido vs cifra alterata', async () => {
    // IBAN di esempio valido (mod-97 = 1)
    expect(
      (
        (await val({ type: 'iban', value: 'IT60X0542811101000000123456' }, undefined, ctx))
          .output as { valid: boolean }
      ).valid,
    ).toBe(true);
    // una cifra alterata → mod-97 fallisce
    expect(
      (
        (await val({ type: 'iban', value: 'IT60X0542811101000000123457' }, undefined, ctx))
          .output as { valid: boolean }
      ).valid,
    ).toBe(false);
  });
  it('telefono IT normalizzato in E.164', async () => {
    const r = await val({ type: 'phone_it', value: '345 123 4567' }, undefined, ctx);
    expect((r.output as { valid: boolean; normalized: string }).normalized).toBe('+393451234567');
  });
  it('json valido/invalido', async () => {
    expect(
      ((await val({ type: 'json', value: '{"a":1}' }, undefined, ctx)).output as { valid: boolean })
        .valid,
    ).toBe(true);
    expect(
      ((await val({ type: 'json', value: '{bad' }, undefined, ctx)).output as { valid: boolean })
        .valid,
    ).toBe(false);
  });
  it('url http/https', async () => {
    expect(
      (
        (await val({ type: 'url', value: 'https://zeli.it/x?a=1' }, undefined, ctx)).output as {
          valid: boolean;
        }
      ).valid,
    ).toBe(true);
    expect(
      ((await val({ type: 'url', value: 'ftp://x' }, undefined, ctx)).output as { valid: boolean })
        .valid,
    ).toBe(false);
  });
});

describe('action_url', () => {
  it('parse scompone in parti + query oggetto', async () => {
    const r = await url(
      { operation: 'parse', url: 'https://api.x.it:8080/v1/ord?page=2&q=ca%20fe#top' },
      undefined,
      ctx,
    );
    const o = r.output as {
      protocol: string;
      hostname: string;
      port: string;
      pathname: string;
      query: Record<string, string>;
      hash: string;
    };
    expect(o.protocol).toBe('https');
    expect(o.hostname).toBe('api.x.it');
    expect(o.port).toBe('8080');
    expect(o.pathname).toBe('/v1/ord');
    expect(o.query).toEqual({ page: '2', q: 'ca fe' });
    expect(o.hash).toBe('top');
  });
  it('build compone con encoding corretto', async () => {
    const r = await url(
      {
        operation: 'build',
        base: 'https://x.it',
        path: '/cerca',
        params: '{"q":"caffè e tè","page":1}',
      },
      undefined,
      ctx,
    );
    const href = (r.output as { href: string }).href;
    expect(href).toContain('q=caff%C3%A8+e+t%C3%A8');
    expect(href).toContain('page=1');
  });
  it('setQuery aggiunge/sovrascrive', async () => {
    const r = await url(
      { operation: 'setQuery', url: 'https://x.it?a=1', params: '{"a":"2","b":"3"}' },
      undefined,
      ctx,
    );
    expect((r.output as { query: Record<string, string> }).query).toEqual({ a: '2', b: '3' });
  });
  it('removeQuery toglie i parametri', async () => {
    const r = await url(
      {
        operation: 'removeQuery',
        url: 'https://x.it?a=1&utm_source=g',
        params: '{"utm_source":""}',
      },
      undefined,
      ctx,
    );
    expect((r.output as { query: Record<string, string> }).query).toEqual({ a: '1' });
  });
  it('encode/decode round-trip', async () => {
    const enc = (await url({ operation: 'encode', url: 'a b&c' }, undefined, ctx)).output as {
      result: string;
    };
    expect(enc.result).toBe('a%20b%26c');
    const dec = (await url({ operation: 'decode', url: enc.result }, undefined, ctx)).output as {
      result: string;
    };
    expect(dec.result).toBe('a b&c');
  });
  it('URL non valido → throw', async () => {
    await expect(url({ operation: 'parse', url: 'non-un-url' }, undefined, ctx)).rejects.toThrow(
      /non valido/,
    );
  });
});
