/**
 * Binary GC — collettore dei ref "vivi" + garbage-collect dei blob orfani.
 * (GAP 2 binary, residuo A#1 — 2026-06-11)
 *
 * Il BinaryStore è content-addressed (ref = sha256): quando una run viene
 * archiviata/cancellata i suoi blob NON spariscono da soli — senza GC il disco
 * del tenant (loop ext4 con hard-quota ENOSPC) si riempie nel tempo.
 *
 * LIVE = il ref compare in una riga persistita che il runtime può ancora
 * leggere: `runs` (trace online, pre-archivio), `workflow_checkpoints`
 * (outputsById per crash-recovery), `paused_workflows` (frame wait_signal,
 * fino a 30gg), `workflows` (definizione — un ref può essere pinnato in un
 * config/node def). Le run ARCHIVIATE (.jsonl.gz) NON tengono vivi i blob:
 * è il TTL deliberato del binario (stessa retention della cronologia online).
 *
 * SAFETY (direzione dell'errore): l'estrazione è una OVER-approssimazione —
 * qualsiasi sha256 64-hex nei payload è considerato vivo. Falso-vivo = blob
 * trattenuto un ciclo in più (innocuo); falso-morto = run rotto
 * (inaccettabile). In più `runBinaryGcOnce` passa una grace `minAgeMs` al
 * BinaryStore: i blob giovani (run in corso, output non ancora persistito)
 * non vengono MAI toccati. Ordine: PRIMA si raccolgono i live-ref, POI si
 * GC-a — un blob scritto dopo la raccolta è per definizione giovane → grace.
 *
 * Le query sono STATICHE (gate db-schema-coverage le prepara contro lo schema
 * reale) e paginate keyset su `id` (portabili SQLite/Postgres, niente OFFSET).
 */
import type { StorageHandle } from '@/storage/handle.js';
import { getDatabase } from '@/storage/db.js';
import { getBinaryStore, type BinaryStore } from './binary-store.service.js';

/** sha256 esadecimale: stessa forma di BinaryStore.REF_RE, qui in scansione globale. */
const SHA256_SCAN_RE = /[0-9a-f]{64}/gu;

/** Righe per pagina della scansione keyset. */
const PAGE_SIZE = 200;

/** Grace di default: 24h — ben oltre la durata massima plausibile di una run. */
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Una query per tabella-sorgente, SOLO colonne che possono contenere payload
 * con BinaryData. Statiche per il gate schema-coverage; keyset su `id`
 * (TEXT per runs/paused/workflows, INTEGER AUTOINCREMENT per checkpoints —
 * `?` tipato dal chiamante, il confronto resta omogeneo per colonna).
 */
const LIVE_REF_QUERIES: readonly { sql: string; startCursor: string | number }[] = [
  {
    sql: 'SELECT id, trigger_payload_json, input, steps_json, paused_json FROM runs WHERE id > ? ORDER BY id LIMIT ?',
    startCursor: '',
  },
  {
    sql: 'SELECT id, outputs_by_id_json, pending_queue_json FROM workflow_checkpoints WHERE id > ? ORDER BY id LIMIT ?',
    startCursor: 0,
  },
  {
    sql: 'SELECT id, outputs_by_id_json, pending_queue_json, resume_payload_json FROM paused_workflows WHERE id > ? ORDER BY id LIMIT ?',
    startCursor: '',
  },
  {
    sql: 'SELECT id, nodes_json, node_defs_json FROM workflows WHERE id > ? ORDER BY id LIMIT ?',
    startCursor: '',
  },
];

/** Estrae ogni sha256 64-hex da un valore stringa nel set `into`. */
function extractRefs(value: unknown, into: Set<string>): void {
  if (typeof value !== 'string' || value.length < 64) return;
  for (const m of value.matchAll(SHA256_SCAN_RE)) into.add(m[0]);
}

/**
 * Scansiona TUTTE le sorgenti persistite e ritorna il set dei ref vivi.
 * `db` iniettabile per i test; default = storage handle del processo.
 */
export async function collectLiveBinaryRefs(db?: StorageHandle): Promise<Set<string>> {
  const store = db ?? getDatabase().store;
  const live = new Set<string>();
  for (const { sql, startCursor } of LIVE_REF_QUERIES) {
    const stmt = store.prepare<Record<string, unknown>>(sql);
    let cursor: string | number = startCursor;
    for (;;) {
      const rows = await stmt.all(cursor, PAGE_SIZE);
      for (const row of rows) {
        for (const value of Object.values(row)) extractRefs(value, live);
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows[rows.length - 1];
      const nextCursor: unknown = last?.id;
      if (typeof nextCursor !== 'string' && typeof nextCursor !== 'number') {
        // FAIL-CLOSED: un cursore non avanzabile = raccolta PARZIALE dei ref
        // vivi → la GC cancellerebbe blob vivi. Meglio saltare l'intero ciclo
        // (il cron logga warn e riprova all'ora dopo) che cancellare per errore.
        throw new Error(`binary-gc: cursore keyset non avanzabile (id=${String(nextCursor)}) — ciclo abortito`);
      }
      cursor = nextCursor;
    }
  }
  return live;
}

export interface BinaryGcResult {
  liveRefs: number;
  deleted: number;
  freedBytes: number;
  skippedYoung: number;
  tempDeleted: number;
  tempFreedBytes: number;
}

/** Grace configurabile: `MEDEA_BINARY_GC_GRACE_HOURS` (≥0, anche frazionario). */
export function readGraceMs(): number {
  const raw = process.env.MEDEA_BINARY_GC_GRACE_HOURS;
  if (!raw) return DEFAULT_GRACE_MS;
  const hours = Number.parseFloat(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours * 60 * 60 * 1000 : DEFAULT_GRACE_MS;
}

/**
 * Un ciclo completo di GC: collect live-refs → gc blob orfani (con grace) →
 * sweep dei temp/staging stantii. `deps` iniettabili per i test.
 */
export async function runBinaryGcOnce(
  deps: { blobStore?: BinaryStore; db?: StorageHandle } = {},
): Promise<BinaryGcResult> {
  const blobStore = deps.blobStore ?? getBinaryStore();
  const live = await collectLiveBinaryRefs(deps.db);
  const gc = await blobStore.gc(live, { minAgeMs: readGraceMs() });
  const sweep = await blobStore.sweepStaleTemp();
  return {
    liveRefs: live.size,
    deleted: gc.deleted,
    freedBytes: gc.freedBytes,
    skippedYoung: gc.skippedYoung,
    tempDeleted: sweep.deleted,
    tempFreedBytes: sweep.freedBytes,
  };
}
