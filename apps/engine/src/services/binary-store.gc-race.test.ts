/**
 * Test 2026-grade — race dedup ↔ GC sul BinaryStore.
 *
 * Scenario: un blob orfano e "vecchio" (fuori grace) viene RISCRITTO con lo
 * stesso contenuto esattamente mentre la GC lo sta cancellando. Il writer vede
 * `pathExists()=true` (dedup), ma il blob sparisce PRIMA del `touch()`. Pre-fix
 * il touch ingoiava l'errore e il writer ritornava `deduped:true` con un REF
 * DANGLING (il consumatore a valle → BinaryNotFoundError a metà run). Post-fix
 * il touch fallito è il segnale "blob sparito" → il writer riscrive i byte.
 *
 * File SEPARATO da binary-store.service.test.ts: qui `utimes` è interposto via
 * vi.mock parziale (la race fs reale non è riproducibile deterministicamente),
 * gli altri test del BinaryStore restano su fs puro.
 */
import type * as PromisesNS from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FsPromises = typeof PromisesNS;

/** Interposizione su utimes: null = passthrough all'fs reale. */
let utimesOverride: FsPromises['utimes'] | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<FsPromises>();
  return {
    ...actual,
    utimes: ((path, atime, mtime) =>
      (utimesOverride ?? actual.utimes)(path, atime, mtime)) satisfies FsPromises['utimes'],
  };
});

const realFs = await vi.importActual<FsPromises>('node:fs/promises');
const { BinaryStore } = await import('./binary-store.service.js');

const PAYLOAD = Buffer.from('blob-conteso-dalla-race-dedup-vs-gc');

let baseDir: string;
let store: InstanceType<typeof BinaryStore>;

beforeEach(async () => {
  baseDir = await realFs.mkdtemp(join(tmpdir(), 'ff-binary-gc-race-'));
  store = new BinaryStore(baseDir);
  utimesOverride = null;
});

afterEach(async () => {
  utimesOverride = null;
  await realFs.rm(baseDir, { recursive: true, force: true });
});

/** Arma la race: al touch del dedup, la GC "vince" cancellando il blob un istante prima. */
function armGcWinsRace(): void {
  utimesOverride = async (path, atime, mtime) => {
    await realFs.unlink(path as string); // la GC concorrente cancella il blob
    await realFs.utimes(path, atime, mtime); // → ENOENT, come nella race reale
  };
}

describe('🚨 race dedup ↔ GC: touch fallito = blob sparito → RISCRIVERE, mai ref dangling', () => {
  it('🚨 writeBuffer: blob GC-ato durante il dedup → riscritto e leggibile (no dangling)', async () => {
    const first = await store.writeBuffer(PAYLOAD);
    expect(first.deduped).toBe(false);

    armGcWinsRace();
    const second = await store.writeBuffer(PAYLOAD);
    utimesOverride = null;

    expect(second.ref).toBe(first.ref);
    expect(second.deduped).toBe(false); // NON è un dedup: il blob era sparito
    await expect(store.read(second.ref)).resolves.toEqual(PAYLOAD); // il ref è VIVO
  });

  it('🚨 writeStream: lo staging è promosso a final (era l\'UNICA copia dei byte)', async () => {
    const first = await store.writeBuffer(PAYLOAD);

    armGcWinsRace();
    const second = await store.writeStream(Readable.from([PAYLOAD]));
    utimesOverride = null;

    expect(second.ref).toBe(first.ref);
    expect(second.deduped).toBe(false);
    await expect(store.read(second.ref)).resolves.toEqual(PAYLOAD);
    // Lo staging promosso via rename non lascia residui .staging-* nel baseDir.
    const leftovers = (await realFs.readdir(baseDir)).filter((e) => e.startsWith('.staging-'));
    expect(leftovers).toEqual([]);
  });

  it('dedup normale (nessuna race): touch riesce → deduped:true e mtime rinfrescato', async () => {
    const first = await store.writeBuffer(PAYLOAD);
    const path = join(baseDir, first.ref.slice(0, 2), first.ref);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await realFs.utimes(path, old, old);

    const second = await store.writeBuffer(PAYLOAD);
    expect(second.deduped).toBe(true);
    const st = await realFs.stat(path);
    expect(Date.now() - st.mtimeMs).toBeLessThan(60_000); // fresco, dentro la grace
  });
});
