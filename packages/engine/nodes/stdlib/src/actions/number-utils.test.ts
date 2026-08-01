/**
 * Test bug-bounty — number-utils (action_number + action_aggregate).
 * Il nodo era SENZA test (gap gate). Copre: round epsilon, valuta IT/US, percent,
 * clamp, parse multi-formato, NaN-throw + aggregate (all/singola/vuoto/non-numerici/
 * dot-path) e l'ANTI-DRIFT: i flat field sono SEMPRE al top level (fix 2026-06-20).
 */
import { describe, it, expect } from 'vitest';
import { numberNode, aggregateNode } from './number-utils.js';

const num = numberNode.executor!;
const agg = aggregateNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const out = async (exec: typeof num, cfg: Record<string, unknown>, input?: unknown) =>
  (await exec(cfg, input, ctx)).output as Record<string, unknown>;

describe('action_number', () => {
  it('round half-away + epsilon: 1.005→1.01, 8.575→8.58', async () => {
    expect((await out(num, { operation: 'round', value: '1.005', decimals: '2' })).result).toBe(1.01);
    expect((await out(num, { operation: 'round', value: '8.575', decimals: '2' })).result).toBe(8.58);
  });
  it('round negativo half-away-from-zero', async () => {
    expect((await out(num, { operation: 'round', value: '-2.5', decimals: '0' })).result).toBe(-3);
  });
  it('🚨 round con decimals abnorme (500) → niente NaN (clamp a 100)', async () => {
    // MUTATION: senza clampDecimals, 10**500 = Infinity → result NaN.
    const r = (await out(num, { operation: 'round', value: '3.14159', decimals: '500' })).result as number;
    expect(Number.isNaN(r)).toBe(false);
  });
  it.each([['non numerico', 'abc'], ['negativo', '-3'], ['oltre il max Intl', '200']])(
    '🚨 format con decimals %s ("%s") → niente RangeError (Intl Invalid digits)',
    async (_label, dec) => {
      // MUTATION: senza clampDecimals, Intl.NumberFormat lancia RangeError.
      const r = await out(num, { operation: 'format', value: '1234.5', decimals: dec });
      expect(typeof (r as { result: string }).result).toBe('string');
    },
  );
  it('currency it-IT → "1.234,50 €"', async () => {
    const r = await out(num, { operation: 'currency', value: '1234.5' });
    // virgola decimale (it-IT) + € sono stabili cross-ICU; il punto delle migliaia
    // (full-icu) NON è garantito su Node small-icu → non lo asserisco.
    expect(String(r.result)).toContain(',50');
    expect(String(r.result)).toContain('€');
    expect((r as { raw: number }).raw).toBe(1234.5);
  });
  it('percent: 22% di 1000 = 220 (con total); frazione → ×100', async () => {
    expect((await out(num, { operation: 'percent', value: '22', total: '1000' })).result).toBe(220);
    expect((await out(num, { operation: 'percent', value: '0.5' })).result).toBe(50);
  });
  it('clamp vincola tra min e max', async () => {
    expect((await out(num, { operation: 'clamp', value: '150', min: '0', max: '100' })).result).toBe(100);
    expect((await out(num, { operation: 'clamp', value: '-5', min: '0', max: '100' })).result).toBe(0);
  });
  it('parse multi-formato IT "1.234,56 €" e US "1,234.56"', async () => {
    expect((await out(num, { operation: 'parse', value: '1.234,56 €' })).result).toBe(1234.56);
    expect((await out(num, { operation: 'parse', value: '1,234.56' })).result).toBe(1234.56);
  });
  it('🚨 input non numerico → throw esplicito', async () => {
    await expect(num({ operation: 'round', value: 'pippo' }, undefined, ctx)).rejects.toThrow(/non numerico/);
  });
  it('🚨 operazione sconosciuta → throw', async () => {
    await expect(num({ operation: 'nope', value: '1' }, undefined, ctx)).rejects.toThrow(/sconosciuta/);
  });
  it('usa input quando value è vuoto', async () => {
    expect((await out(num, { operation: 'abs', value: '' }, -7)).result).toBe(7);
  });
});

describe('action_aggregate', () => {
  const items = [{ t: 10 }, { t: 20 }, { t: 30 }];
  it('🚨 ANTI-DRIFT: op=all → result PIÙ flat field al top level (count/sum/avg/…)', async () => {
    const r = await out(agg, { operation: 'all', key: 't' }, items);
    // flat sempre presenti (era il bug: per "all" erano annidati solo in result)
    expect(r.count).toBe(3);
    expect(r.sum).toBe(60);
    expect(r.avg).toBe(20);
    expect(r.median).toBe(20);
    expect((r.result as { sum: number }).sum).toBe(60);
  });
  it('op singola: result = la stat scelta + flat presenti', async () => {
    const r = await out(agg, { operation: 'sum', key: 't' }, items);
    expect(r.result).toBe(60);
    expect(r.avg).toBe(20);
  });
  it('min/max/median/stddev corretti', async () => {
    const r = await out(agg, { operation: 'all' }, [2, 4, 4, 4, 5, 5, 7, 9]);
    expect(r.min).toBe(2); expect(r.max).toBe(9);
    expect(r.median).toBe(4.5);
    expect(r.stddev).toBeCloseTo(2, 5);
  });
  it('🚨 ignora i non-numerici, non si rompe (CSV con celle vuote/testo)', async () => {
    const r = await out(agg, { operation: 'all' }, [10, 'x', '', 20, null]);
    expect(r.count).toBe(2);
    expect(r.sum).toBe(30);
  });
  it('🚨 array vuoto → tutto 0, nessun crash', async () => {
    const r = await out(agg, { operation: 'all' }, []);
    expect(r).toMatchObject({ count: 0, sum: 0, avg: 0, min: 0, max: 0, median: 0, stddev: 0 });
  });
  it('JSON string array in input', async () => {
    const r = await out(agg, { operation: 'sum' }, JSON.stringify([1, 2, 3]));
    expect(r.result).toBe(6);
  });
});
