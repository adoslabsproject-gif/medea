/**
 * Test 2026-grade — binary-gc.service (GAP 2 residuo A#1).
 *
 * NON green-smoke: DB SQLite REALE in-memory (SqliteHandle vero) + filesystem
 * REALE (tmpdir). Il centro del bug-bounty è la DIREZIONE dell'errore: un blob
 * VIVO cancellato rompe una run (inaccettabile), un orfano trattenuto un ciclo
 * in più è innocuo. Quindi: un test per OGNI sorgente di liveness (runs,
 * checkpoints, paused, workflows) che prova che il blob sopravvive, + grace
 * sui blob giovani, + paginazione oltre PAGE_SIZE, + sweep dei temp stantii.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, utimes, mkdir } from 'node:fs/promises';
import { SqliteHandle } from '@/storage/handle.js';
import { BinaryStore } from './binary-store.service.js';
import { collectLiveBinaryRefs, runBinaryGcOnce, readGraceMs } from './binary-gc.service.js';

let root = '';
let blobStore: BinaryStore;
let blobDir = '';
let db: SqliteHandle;
let savedGrace: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ffgc-'));
  blobDir = join(root, 'blobs');
  blobStore = new BinaryStore(blobDir);
  const conn = new Database(':memory:');
  // Colonne = quelle selezionate dalle LIVE_REF_QUERIES (lo schema REALE è
  // validato a parte dal gate db-schema-coverage che prepara le query statiche).
  conn.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      trigger_payload_json TEXT,
      input TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      paused_json TEXT
    );
    CREATE TABLE workflow_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outputs_by_id_json TEXT NOT NULL DEFAULT '{}',
      pending_queue_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE paused_workflows (
      id TEXT PRIMARY KEY,
      outputs_by_id_json TEXT NOT NULL DEFAULT '{}',
      pending_queue_json TEXT NOT NULL DEFAULT '[]',
      resume_payload_json TEXT
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      nodes_json TEXT NOT NULL DEFAULT '[]',
      node_defs_json TEXT NOT NULL DEFAULT '[]'
    );
  `);
  db = new SqliteHandle(conn);
  savedGrace = process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS;
  delete process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedGrace === undefined) delete process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS;
  else process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = savedGrace;
});

/** Scrive un blob e lo INVECCHIA oltre la grace (mtime −48h). Ritorna il ref. */
async function writeAgedBlob(content: string): Promise<string> {
  const { ref } = await blobStore.writeBuffer(Buffer.from(content));
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(join(blobDir, ref.slice(0, 2), ref), past, past);
  return ref;
}

const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);

describe('🚨 liveness — un blob referenziato NON viene MAI cancellato', () => {
  it('🚨 orfano vecchio cancellato, ref in runs.steps_json preservato (anche se vecchio)', async () => {
    const liveRef = await writeAgedBlob('vivo-in-runs');
    const orphanRef = await writeAgedBlob('orfano');
    await run(
      'INSERT INTO runs (id, steps_json) VALUES (?, ?)',
      'r1', JSON.stringify([{ output: { binary: { __ffBinary: true, encoding: 'ref', ref: liveRef } } }]),
    );
    const res = await runBinaryGcOnce({ blobStore, db });
    expect(res.deleted).toBe(1);
    expect(res.freedBytes).toBeGreaterThan(0);
    expect(await blobStore.exists(liveRef)).toBe(true);
    expect(await blobStore.exists(orphanRef)).toBe(false);
  });

  it('🚨 ref in workflow_checkpoints.outputs_by_id_json preservato', async () => {
    const liveRef = await writeAgedBlob('vivo-in-checkpoint');
    await run(
      'INSERT INTO workflow_checkpoints (outputs_by_id_json) VALUES (?)',
      JSON.stringify({ nodeA: { binary: { __ffBinary: true, encoding: 'ref', ref: liveRef } } }),
    );
    await runBinaryGcOnce({ blobStore, db });
    expect(await blobStore.exists(liveRef)).toBe(true);
  });

  it('🚨 ref in paused_workflows.resume_payload_json preservato', async () => {
    const liveRef = await writeAgedBlob('vivo-in-paused');
    await run(
      'INSERT INTO paused_workflows (id, resume_payload_json) VALUES (?, ?)',
      'p1', JSON.stringify({ attachment: { __ffBinary: true, encoding: 'ref', ref: liveRef } }),
    );
    await runBinaryGcOnce({ blobStore, db });
    expect(await blobStore.exists(liveRef)).toBe(true);
  });

  it('🚨 ref pinnato in workflows.nodes_json preservato', async () => {
    const liveRef = await writeAgedBlob('vivo-in-workflow-def');
    await run(
      'INSERT INTO workflows (id, nodes_json) VALUES (?, ?)',
      'wf1', JSON.stringify([{ id: 'n1', config: { template: liveRef } }]),
    );
    await runBinaryGcOnce({ blobStore, db });
    expect(await blobStore.exists(liveRef)).toBe(true);
  });

  it('over-approssimazione: 64-hex ANNIDATO in testo arbitrario è considerato vivo', async () => {
    const liveRef = await writeAgedBlob('annidato');
    await run(
      'INSERT INTO runs (id, input) VALUES (?, ?)',
      'r2', `testo libero che cita il blob ${liveRef} in mezzo a una frase`,
    );
    const live = await collectLiveBinaryRefs(db);
    expect(live.has(liveRef)).toBe(true);
  });
});

describe('🚨 grace — i blob giovani (run in corso) NON vengono toccati', () => {
  it('🚨 orfano GIOVANE preservato con grace default 24h (skippedYoung)', async () => {
    const { ref } = await blobStore.writeBuffer(Buffer.from('giovane-run-in-corso'));
    const res = await runBinaryGcOnce({ blobStore, db });
    expect(res.deleted).toBe(0);
    expect(res.skippedYoung).toBe(1);
    expect(await blobStore.exists(ref)).toBe(true);
  });

  it('🚨 grace 0 via env → anche il giovane orfano viene cancellato', async () => {
    process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = '0';
    const { ref } = await blobStore.writeBuffer(Buffer.from('giovane-ma-grace-zero'));
    const res = await runBinaryGcOnce({ blobStore, db });
    expect(res.deleted).toBe(1);
    expect(await blobStore.exists(ref)).toBe(false);
  });

  it('readGraceMs: default 24h, frazionario, 0 esplicito, garbage/negativo → default', () => {
    expect(readGraceMs()).toBe(24 * 60 * 60 * 1000);
    process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = '2.5';
    expect(readGraceMs()).toBe(2.5 * 60 * 60 * 1000);
    process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = '0';
    expect(readGraceMs()).toBe(0);
    process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = 'garbage';
    expect(readGraceMs()).toBe(24 * 60 * 60 * 1000);
    process.env.FLOWFORGE_BINARY_GC_GRACE_HOURS = '-1';
    expect(readGraceMs()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('🚨 paginazione keyset — niente ref persi oltre PAGE_SIZE', () => {
  it('🚨 250 runs (oltre la pagina da 200) → TUTTI i ref raccolti', async () => {
    const refs: string[] = [];
    for (let i = 0; i < 250; i++) {
      // ref sintetici distinti (64-hex deterministici) — non servono blob reali
      const ref = String(i).padStart(4, '0').repeat(16);
      refs.push(ref);
      await run(
        'INSERT INTO runs (id, steps_json) VALUES (?, ?)',
        `r${String(i).padStart(4, '0')}`, JSON.stringify([{ ref }]),
      );
    }
    const live = await collectLiveBinaryRefs(db);
    for (const ref of refs) expect(live.has(ref)).toBe(true);
  });
});

describe('🚨 fail-closed — raccolta parziale = NESSUNA cancellazione', () => {
  it('🚨 cursore keyset non avanzabile → throw, e runBinaryGcOnce NON cancella nulla', async () => {
    const orphan = await writeAgedBlob('sopravvive-al-ciclo-abortito');
    // Stub StorageHandle: pagina PIENA (PAGE_SIZE righe) ma id null → il
    // collettore non può avanzare. Direzione dell'errore: abortire, mai GC-are.
    const badDb = {
      kind: 'sqlite' as const,
      exec: async () => undefined,
      close: async () => undefined,
      prepare: <TRow = unknown>() => ({
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        get: async () => undefined,
        all: async (..._params: unknown[]) =>
          Array.from({ length: Number(_params[1] ?? 200) }, () => ({ id: null })) as TRow[],
      }),
    };
    await expect(runBinaryGcOnce({ blobStore, db: badDb })).rejects.toThrow(/cursore keyset non avanzabile/u);
    expect(await blobStore.exists(orphan)).toBe(true); // il blob NON è stato toccato
  });
});

describe('🚨 sweep temp — gli staging da crash vengono recuperati', () => {
  it('🚨 staging stantio (>1h) spazzato, staging giovane preservato', async () => {
    await mkdir(blobDir, { recursive: true });
    const stale = join(blobDir, '.staging-stale-crash');
    const young = join(blobDir, '.staging-young-writing');
    await writeFile(stale, 'mezzo-scritto');
    await writeFile(young, 'in-corso');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, past, past);
    const res = await runBinaryGcOnce({ blobStore, db });
    expect(res.tempDeleted).toBe(1);
    expect(res.tempFreedBytes).toBeGreaterThan(0);
  });
});

describe('contatori risultato', () => {
  it('liveRefs riflette il numero di ref distinti raccolti', async () => {
    const a = await writeAgedBlob('a');
    const b = await writeAgedBlob('b');
    await run('INSERT INTO runs (id, steps_json) VALUES (?, ?)', 'r1', JSON.stringify([a, b, a]));
    const res = await runBinaryGcOnce({ blobStore, db });
    expect(res.liveRefs).toBe(2);
    expect(res.deleted).toBe(0);
  });
});
