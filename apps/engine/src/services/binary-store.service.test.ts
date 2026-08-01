/**
 * Test 2026-grade — BinaryStore (blob-store content-addressed per-tenant, GAP 2).
 *
 * NON green-smoke: ogni test verifica un comportamento reale su filesystem vero
 * (tmpdir isolato), e il blocco SICUREZZA prova che un `ref` malevolo NON può
 * uscire da baseDir (path-traversal). Mutation-checked: indebolire REF_RE o
 * l'hashing rende rossi i test corrispondenti.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, readFile, utimes, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BinaryStore,
  InvalidBinaryRefError,
  BinaryNotFoundError,
} from './binary-store.service.js';
import { makeBinaryRef, readBinaryBytes } from '@flowforge/core-schema';

let root = '';
let store: BinaryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ffbin-'));
  store = new BinaryStore(join(root, 'blobs'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('🚨 content-addressing + dedup', () => {
  it('🚨 ref === sha256 reale del contenuto', async () => {
    const data = Buffer.from('hello flowforge');
    const r = await store.writeBuffer(data);
    expect(r.ref).toBe(sha(data));
    expect(r.size).toBe(data.byteLength);
    expect(r.deduped).toBe(false);
  });

  it('🚨 stesso contenuto → STESSO ref, secondo write deduped (1 sola copia su disco)', async () => {
    const data = Buffer.from('dedup me');
    const a = await store.writeBuffer(data);
    const b = await store.writeBuffer(data);
    expect(b.ref).toBe(a.ref);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    // una sola copia fisica
    expect(await store.list()).toEqual([a.ref]);
  });

  it('🚨 contenuti diversi → ref diversi', async () => {
    const a = await store.writeBuffer(Buffer.from('A'));
    const b = await store.writeBuffer(Buffer.from('B'));
    expect(a.ref).not.toBe(b.ref);
    expect((await store.list()).sort()).toEqual([a.ref, b.ref].sort());
  });
});

describe('🚨 round-trip buffer + stream', () => {
  it('🚨 writeBuffer → read restituisce gli stessi byte', async () => {
    const data = Buffer.from([0, 1, 2, 250, 251, 255]); // binario, non-utf8
    const { ref } = await store.writeBuffer(data);
    const out = await store.read(ref);
    expect(out.equals(data)).toBe(true);
  });

  it('🚨 writeStream produce lo STESSO ref di writeBuffer (hash in transito)', async () => {
    const data = Buffer.from('streamed content 12345');
    const viaBuf = await store.writeBuffer(data);
    // nuovo store pulito per non deduplicare contro il precedente
    const store2 = new BinaryStore(join(root, 'blobs2'));
    const viaStream = await store2.writeStream(Readable.from([data]));
    expect(viaStream.ref).toBe(viaBuf.ref);
    expect(viaStream.size).toBe(data.byteLength);
  });

  it('🚨 readStream restituisce i byte', async () => {
    const data = Buffer.from('via stream read');
    const { ref } = await store.writeBuffer(data);
    const chunks: Buffer[] = [];
    for await (const c of store.readStream(ref)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });
});

describe('🚨🚨 SICUREZZA — anti path-traversal (centro bug-bounty)', () => {
  const EVIL: string[] = [
    '../../../../etc/passwd',
    '..',
    '/etc/passwd',
    'abc/../../x',
    'ZZZZ', // non-hex
    'a'.repeat(63), // troppo corto
    'a'.repeat(65), // troppo lungo
    'A'.repeat(64), // maiuscolo (REF_RE è lowercase)
    '../' + 'a'.repeat(61),
    '%2e%2e%2fetc',
    '',
  ];

  it('🚨 un secret fuori da baseDir NON è leggibile via ref malevolo', async () => {
    const secretPath = join(root, 'SECRET.txt');
    await writeFile(secretPath, 'TOP-SECRET');
    // ref che tenta di raggiungere il secret (qualunque forma) → throw, mai letto
    for (const ref of ['../SECRET.txt', '../../SECRET.txt', secretPath]) {
      await expect(store.read(ref)).rejects.toBeInstanceOf(InvalidBinaryRefError);
    }
    // sanity: il secret esiste davvero (il test sarebbe inutile se non esistesse)
    expect(await readFile(secretPath, 'utf8')).toBe('TOP-SECRET');
  });

  it('🚨 ogni ref non-sha256 → InvalidBinaryRefError su read/exists/size', async () => {
    for (const ref of EVIL) {
      await expect(store.read(ref)).rejects.toBeInstanceOf(InvalidBinaryRefError);
      await expect(store.exists(ref)).rejects.toBeInstanceOf(InvalidBinaryRefError);
      await expect(store.size(ref)).rejects.toBeInstanceOf(InvalidBinaryRefError);
    }
  });

  it('🚨 nessun file scritto FUORI da baseDir per qualunque input', async () => {
    // I write accettano solo Buffer/stream (non ref) → il path è SEMPRE derivato
    // dall'hash, mai dall'input. Verifichiamo che dopo write tutto stia in blobs/.
    await store.writeBuffer(Buffer.from('x'));
    const entries = await readFileSafe(join(root));
    // in root deve esserci solo la dir 'blobs' (+ eventuale SECRET dei test sopra: qui no)
    expect(entries).toContain('blobs');
    expect(entries.every((e) => e === 'blobs')).toBe(true);
  });
});

describe('🚨 exists / size / not-found', () => {
  it('🚨 exists true dopo write, size corretta', async () => {
    const data = Buffer.from('size me up');
    const { ref } = await store.writeBuffer(data);
    expect(await store.exists(ref)).toBe(true);
    expect(await store.size(ref)).toBe(data.byteLength);
  });

  it('🚨 ref valido ma assente → exists false / read+size BinaryNotFoundError', async () => {
    const absent = sha(Buffer.from('never written'));
    expect(await store.exists(absent)).toBe(false);
    await expect(store.read(absent)).rejects.toBeInstanceOf(BinaryNotFoundError);
    await expect(store.size(absent)).rejects.toBeInstanceOf(BinaryNotFoundError);
  });
});

describe('🚨 usage + gc', () => {
  it('🚨 usage somma le dimensioni, il dedup NON conta doppio', async () => {
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbbbb');
    await store.writeBuffer(a);
    await store.writeBuffer(b);
    await store.writeBuffer(a); // dedup
    expect(await store.usage()).toBe(a.byteLength + b.byteLength);
  });

  it('🚨 gc elimina i ref NON vivi, tiene i vivi, riporta byte liberati', async () => {
    const keep = await store.writeBuffer(Buffer.from('keep this'));
    const drop = await store.writeBuffer(Buffer.from('drop this'));
    const dropSize = await store.size(drop.ref);
    const res = await store.gc(new Set([keep.ref]));
    expect(res.deleted).toBe(1);
    expect(res.freedBytes).toBe(dropSize);
    expect(await store.exists(keep.ref)).toBe(true);
    expect(await store.exists(drop.ref)).toBe(false);
  });

  it('🚨 gc con set vuoto elimina tutto', async () => {
    await store.writeBuffer(Buffer.from('1'));
    await store.writeBuffer(Buffer.from('2'));
    const res = await store.gc(new Set());
    expect(res.deleted).toBe(2);
    expect(await store.list()).toEqual([]);
  });
});

describe('🚨 gc grace (minAgeMs) — i blob giovani di run in corso NON vengono toccati', () => {
  /** Invecchia il blob: mtime −`hours` ore. */
  async function ageBlob(ref: string, hours: number): Promise<void> {
    const past = new Date(Date.now() - hours * 60 * 60 * 1000);
    await utimes(join(root, 'blobs', ref.slice(0, 2), ref), past, past);
  }

  it('🚨 orfano GIOVANE saltato (skippedYoung), orfano VECCHIO cancellato', async () => {
    const young = await store.writeBuffer(Buffer.from('appena scritto da una run in corso'));
    const old = await store.writeBuffer(Buffer.from('de-referenziato da giorni'));
    await ageBlob(old.ref, 48);
    const res = await store.gc(new Set(), { minAgeMs: 24 * 60 * 60 * 1000 });
    expect(res.deleted).toBe(1);
    expect(res.skippedYoung).toBe(1);
    expect(await store.exists(young.ref)).toBe(true);
    expect(await store.exists(old.ref)).toBe(false);
  });

  it('🚨 senza opts (default minAgeMs=0) il comportamento resta quello storico: età ignorata', async () => {
    const young = await store.writeBuffer(Buffer.from('giovanissimo'));
    const res = await store.gc(new Set());
    expect(res.deleted).toBe(1);
    expect(res.skippedYoung).toBe(0);
    expect(await store.exists(young.ref)).toBe(false);
  });

  it('🚨 dedup writeBuffer fa touch: il blob riusato torna GIOVANE (protetto dalla grace)', async () => {
    const data = Buffer.from('contenuto riusato da una run attiva');
    const first = await store.writeBuffer(data);
    await ageBlob(first.ref, 48); // scritto "giorni fa"
    const again = await store.writeBuffer(data); // riuso ORA da una run in corso
    expect(again.deduped).toBe(true);
    const res = await store.gc(new Set(), { minAgeMs: 24 * 60 * 60 * 1000 });
    expect(res.skippedYoung).toBe(1);
    expect(await store.exists(first.ref)).toBe(true);
  });

  it('🚨 dedup writeStream fa touch: stessa protezione del path buffer', async () => {
    const data = Buffer.from('contenuto riusato via stream');
    const first = await store.writeBuffer(data);
    await ageBlob(first.ref, 48);
    const again = await store.writeStream(Readable.from([data]));
    expect(again.deduped).toBe(true);
    const res = await store.gc(new Set(), { minAgeMs: 24 * 60 * 60 * 1000 });
    expect(res.skippedYoung).toBe(1);
    expect(await store.exists(first.ref)).toBe(true);
  });
});

describe('🚨 integrazione con il contratto BinaryData (readBinaryBytes)', () => {
  it('🚨 makeBinaryRef + store.read come refReader → readBinaryBytes risolve i byte', async () => {
    const data = Buffer.from('binary contract bytes');
    const { ref, size } = await store.writeBuffer(data);
    const bin = makeBinaryRef({ mimeType: 'application/octet-stream', ref, size });
    // il runtime inietta store.read come BinaryRefReader
    const bytes = await readBinaryBytes(bin, (r) => store.read(r));
    expect(bytes.equals(data)).toBe(true);
  });
});

describe('🚨 review fix #1 — niente temp/staging orfani', () => {
  it('🚨 writeStream che fallisce a metà → rifiuta E nessuno staging orfano', async () => {
    const boom = new Readable({ read() { this.destroy(new Error('boom mid-stream')); } });
    await expect(store.writeStream(boom)).rejects.toThrow(/boom/u);
    const entries = await readFileSafe(join(root, 'blobs'));
    expect(entries.filter((e) => e.startsWith('.staging-'))).toEqual([]);
  });

  it('🚨 sweepStaleTemp elimina i temp VECCHI orfani, tiene blob + temp GIOVANI', async () => {
    const blob = await store.writeBuffer(Buffer.from('real blob'));
    const base = join(root, 'blobs');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

    const oldStaging = join(base, '.staging-orphan');
    await writeFile(oldStaging, 'orphan-staging');
    await utimes(oldStaging, twoHoursAgo, twoHoursAgo);

    const oldTmp = join(base, blob.ref.slice(0, 2), `${blob.ref}.tmp-orphan`);
    await writeFile(oldTmp, 'orphan-tmp');
    await utimes(oldTmp, twoHoursAgo, twoHoursAgo);

    const youngStaging = join(base, '.staging-inflight');
    await writeFile(youngStaging, 'in-flight'); // mtime = ora → protetto

    const res = await store.sweepStaleTemp(3_600_000);
    expect(res.deleted).toBe(2);
    expect(res.freedBytes).toBeGreaterThan(0);
    // il blob reale NON viene toccato
    expect(await store.exists(blob.ref)).toBe(true);
    // staging giovane (scrittura in corso) protetto
    expect(await fileExists(youngStaging)).toBe(true);
    // orfani vecchi rimossi
    expect(await fileExists(oldStaging)).toBe(false);
    expect(await fileExists(oldTmp)).toBe(false);
  });

  it('🚨 list()/usage() IGNORANO i file temp (accounting non corrotto)', async () => {
    const blob = await store.writeBuffer(Buffer.from('x'));
    await writeFile(join(root, 'blobs', '.staging-noise'), 'temp-noise');
    expect(await store.list()).toEqual([blob.ref]);
    expect(await store.usage()).toBe(1); // solo 'x', non il temp
  });
});

/** Lista i nomi in una dir, [] se assente. */
async function readFileSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try { return await readdir(dir); } catch { return []; }
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
