/**
 * Bug-bounty sul canale-posizione: round-trip queued/admitted, TTL passato,
 * 'gone' su chiave assente, robustezza su JSON malformato / forma parziale
 * (NON deve restituire una posizione finta), chiavi corrette, clear idempotente.
 *
 * @module admission/position-channel.test
 */
import { describe, it, expect } from 'vitest';
import {
  publishQueued, publishAdmitted, readPosition, clearPosition, type PositionRedis,
} from './position-channel';

function makeRedis(): PositionRedis & { store: Map<string, string>; setCalls: [string, string, string, number][]; delCalls: string[] } {
  const store = new Map<string, string>();
  const setCalls: [string, string, string, number][] = [];
  const delCalls: string[] = [];
  return {
    store, setCalls, delCalls,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value, mode, ttl) { setCalls.push([key, value, mode, ttl]); store.set(key, value); return 'OK'; },
    async del(key) { delCalls.push(key); store.delete(key); return 1; },
  };
}

describe('publishQueued → readPosition round-trip', () => {
  it('scrive {s:q,p,a} con chiave liara:adm:pos:<rid> e TTL; read lo ricostruisce', async () => {
    const r = makeRedis();
    await publishQueued(r, 'rid-1', { position: 3, ahead: 2 });
    expect(r.setCalls[0]![0]).toBe('liara:adm:pos:rid-1');
    expect(r.setCalls[0]![2]).toBe('EX');
    expect(r.setCalls[0]![3]).toBe(30); // TTL default
    expect(await readPosition(r, 'rid-1')).toEqual({ state: 'queued', position: 3, ahead: 2 });
  });
  it('TTL override rispettato', async () => {
    const r = makeRedis();
    await publishQueued(r, 'rid-1', { position: 1, ahead: 0 }, 5);
    expect(r.setCalls[0]![3]).toBe(5);
  });
});

describe('publishAdmitted', () => {
  it('read → admitted', async () => {
    const r = makeRedis();
    await publishAdmitted(r, 'rid-1');
    expect(await readPosition(r, 'rid-1')).toEqual({ state: 'admitted' });
  });
});

describe('readPosition — fail-safe (mai posizione finta)', () => {
  it('chiave assente → gone', async () => {
    expect(await readPosition(makeRedis(), 'nope')).toEqual({ state: 'gone' });
  });
  it('JSON malformato → gone', async () => {
    const r = makeRedis();
    r.store.set('liara:adm:pos:x', '{not json');
    expect(await readPosition(r, 'x')).toEqual({ state: 'gone' });
  });
  it('forma parziale (s:q senza p/a numerici) → gone, NON una posizione inventata', async () => {
    const r = makeRedis();
    r.store.set('liara:adm:pos:x', JSON.stringify({ s: 'q' }));
    expect(await readPosition(r, 'x')).toEqual({ state: 'gone' });
    r.store.set('liara:adm:pos:y', JSON.stringify({ s: 'q', p: '3', a: '2' })); // stringhe, non number
    expect(await readPosition(r, 'y')).toEqual({ state: 'gone' });
  });
  it('stringa vuota → gone', async () => {
    const r = makeRedis();
    r.store.set('liara:adm:pos:z', '');
    expect(await readPosition(r, 'z')).toEqual({ state: 'gone' });
  });
  it('posizione 0/0 VALIDA (ammesso-imminente) → queued {0,0}, non gone', async () => {
    const r = makeRedis();
    r.store.set('liara:adm:pos:k', JSON.stringify({ s: 'q', p: 0, a: 0 }));
    expect(await readPosition(r, 'k')).toEqual({ state: 'queued', position: 0, ahead: 0 });
  });
});

describe('clearPosition', () => {
  it('del sulla chiave corretta; read successivo → gone', async () => {
    const r = makeRedis();
    await publishQueued(r, 'rid-1', { position: 1, ahead: 0 });
    await clearPosition(r, 'rid-1');
    expect(r.delCalls).toEqual(['liara:adm:pos:rid-1']);
    expect(await readPosition(r, 'rid-1')).toEqual({ state: 'gone' });
  });
  it('clear di chiave inesistente non esplode (idempotente)', async () => {
    await expect(clearPosition(makeRedis(), 'ghost')).resolves.toBeUndefined();
  });
});
