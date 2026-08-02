/**
 * BinaryStore — blob-store CONTENT-ADDRESSED sul disco del tenant.
 *
 * GAP 2 (superare n8n sul binary): i file grandi NON viaggiano più come base64
 * dentro `outputsById` (memoria), ma come `BinaryData { encoding:'ref', ref }`
 * dove `ref` è l'indirizzo-contenuto (sha256). Vantaggi vs n8n:
 *   • DEDUP automatico — stesso contenuto → stesso sha256 → stesso blob (1 copia).
 *   • Streaming — write/read a stream, i byte non passano mai tutti in memoria.
 *   • QUOTA per-tenant — i blob vivono sul loop-ext4 del container (hard ENOSPC
 *     dal kernel) + `usage()` per enforcement soft a monte.
 *   • GDPR — i blob sono nel container del tenant → purgati al right-to-erasure.
 *
 * SICUREZZA (centro del bug-bounty): `ref` è usato per costruire un path su disco.
 * Un workflow malevolo potrebbe passare `ref="../../etc/passwd"`. Per questo OGNI
 * ingresso di `ref` è validato come sha256 esadecimale (64 hex) PRIMA di toccare
 * il filesystem: impossibile uscire da `baseDir`. Niente simlink-escape (i blob
 * sono file regolari scritti da noi). Scritture ATOMICHE (temp + rename).
 *
 * Layout: `<baseDir>/<sha256[0:2]>/<sha256>` (shard a 2 char → no dir gigante).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, readdir, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { loadConfig } from '@/config.js';

/** sha256 esadecimale: 64 char [0-9a-f]. UNICA forma di `ref` accettata. */
const REF_RE = /^[0-9a-f]{64}$/u;

/** Marcatori dei file temporanei in corso di scrittura (mai contati come blob). */
const TMP_SUFFIX = '.tmp-';
const STAGING_PREFIX = '.staging-';

export interface BinaryWriteResult {
  /** Content-address = sha256 hex. È il valore da mettere in BinaryData.ref. */
  ref: string;
  sha256: string;
  size: number;
  /** true se il contenuto esisteva già (dedup, nessuna riscrittura). */
  deduped: boolean;
}

/** Errore tipato: `ref` non è un content-address valido (anti-traversal). */
export class InvalidBinaryRefError extends Error {
  constructor(ref: string) {
    super(
      `BinaryStore: ref non valido (atteso sha256 64-hex): ${JSON.stringify(ref).slice(0, 80)}`,
    );
    this.name = 'InvalidBinaryRefError';
  }
}

/** Errore tipato: blob assente per il `ref` dato. */
export class BinaryNotFoundError extends Error {
  constructor(ref: string) {
    super(`BinaryStore: blob non trovato per ref=${ref}`);
    this.name = 'BinaryNotFoundError';
  }
}

export class BinaryStore {
  /** baseDir DEVE essere una directory dedicata ai blob (es. <dataDir>/blobs). */
  constructor(private readonly baseDir: string) {}

  /** Valida `ref` e ritorna il path su disco. Throw su ref non-sha256. */
  private pathFor(ref: string): string {
    if (!REF_RE.test(ref)) throw new InvalidBinaryRefError(ref);
    return join(this.baseDir, ref.slice(0, 2), ref);
  }

  /** Scrive un Buffer. Content-addressed + dedup + atomico. */
  async writeBuffer(data: Buffer): Promise<BinaryWriteResult> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const finalPath = this.pathFor(sha256);
    if (await this.pathExists(finalPath)) {
      // dedup = riuso → il blob torna "giovane" per la grace GC. Se il touch
      // FALLISCE il blob è sparito tra il check e il touch (race con la GC):
      // ritornare `deduped` qui = ref dangling → si prosegue e si riscrive.
      if (await this.touch(finalPath)) {
        return { ref: sha256, sha256, size: data.byteLength, deduped: true };
      }
    }
    await mkdir(dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}${TMP_SUFFIX}${randomUUID()}`;
    try {
      await pipeline(Readable.from([data]), createWriteStream(tmp, { mode: 0o640 }));
      await this.commit(tmp, finalPath);
    } catch (err) {
      // Note #1 (review): nessun temp orfano su crash a metà scrittura.
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { ref: sha256, sha256, size: data.byteLength, deduped: false };
  }

  /** Scrive uno stream senza tenere i byte in memoria. Hash calcolato in transito. */
  async writeStream(src: Readable): Promise<BinaryWriteResult> {
    await mkdir(this.baseDir, { recursive: true });
    const tmp = join(this.baseDir, `${STAGING_PREFIX}${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    // Note #2 (review): hashing via Transform nella STESSA pipeline (un solo
    // consumatore del readable) invece di src.on('data') + pipe → robusto, niente
    // flowing-mode side-channel.
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, cb): void {
        hash.update(chunk);
        size += chunk.byteLength;
        cb(null, chunk);
      },
    });
    let sha256: string;
    try {
      await pipeline(src, hasher, createWriteStream(tmp, { mode: 0o640 }));
      sha256 = hash.digest('hex');
    } catch (err) {
      await unlink(tmp).catch(() => undefined); // Note #1: niente staging orfano
      throw err;
    }
    const finalPath = this.pathFor(sha256);
    if (await this.pathExists(finalPath)) {
      // Touch PRIMA di scartare lo staging: se il blob è sparito tra il check
      // e il touch (race con la GC) lo staging è l'UNICA copia dei byte → si
      // prosegue e lo si promuove a final invece di ritornare un ref dangling.
      if (await this.touch(finalPath)) {
        await unlink(tmp).catch(() => undefined); // dedup: scarta lo staging
        return { ref: sha256, sha256, size, deduped: true };
      }
    }
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await this.commit(tmp, finalPath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { ref: sha256, sha256, size, deduped: false };
  }

  /** Legge i byte di un blob. È il `BinaryRefReader` iniettato nel runtime. */
  async read(ref: string): Promise<Buffer> {
    const path = this.pathFor(ref);
    try {
      return await readFile(path);
    } catch {
      throw new BinaryNotFoundError(ref);
    }
  }

  /** Stream di lettura (per consumo a basso uso di memoria). */
  readStream(ref: string): Readable {
    return createReadStream(this.pathFor(ref));
  }

  async exists(ref: string): Promise<boolean> {
    return this.pathExists(this.pathFor(ref));
  }

  /** Dimensione in byte del blob. Throw se assente. */
  async size(ref: string): Promise<number> {
    // pathFor() FUORI dal try: la validazione anti-traversal (InvalidBinaryRefError)
    // NON deve essere mascherata da BinaryNotFoundError. Stesso pattern di read().
    const path = this.pathFor(ref);
    try {
      return (await stat(path)).size;
    } catch {
      throw new BinaryNotFoundError(ref);
    }
  }

  /** Byte totali occupati dai blob (per reporting/quota). */
  async usage(): Promise<number> {
    let total = 0;
    for (const ref of await this.list()) {
      total += (await stat(this.pathFor(ref))).size;
    }
    return total;
  }

  /** Tutti i ref presenti (filename = sha256). Ignora staging/temp. */
  async list(): Promise<string[]> {
    const out: string[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.baseDir);
    } catch {
      return out; // baseDir non ancora creata
    }
    for (const shard of shards) {
      if (shard.length !== 2) continue; // salta .staging-*, .tmp-*
      let files: string[];
      try {
        files = await readdir(join(this.baseDir, shard));
      } catch {
        continue;
      }
      for (const f of files) if (REF_RE.test(f)) out.push(f);
    }
    return out;
  }

  /**
   * Garbage-collect: elimina i blob NON in `liveRefs`. Ritorna conteggio + byte
   * liberati. È il cuore della GC legata al TTL delle run (i ref vivi vengono
   * dai run trace non scaduti).
   *
   * `minAgeMs` (grace, default 0 = off): un blob appena scritto da una run IN
   * CORSO non compare ancora in NESSUNA riga persistita (gli output stanno in
   * memoria fino a fine run / checkpoint) — senza grace la GC lo cancellerebbe
   * sotto i piedi del consumatore a valle. I blob più giovani di `minAgeMs`
   * vengono saltati (contati in `skippedYoung`). Il dedup fa `touch` del blob
   * riusato, quindi mtime = ultimo riuso, non prima scrittura.
   */
  async gc(
    liveRefs: ReadonlySet<string>,
    opts: { minAgeMs?: number } = {},
  ): Promise<{ deleted: number; freedBytes: number; skippedYoung: number }> {
    const minAgeMs = opts.minAgeMs ?? 0;
    const now = Date.now();
    let deleted = 0;
    let freedBytes = 0;
    let skippedYoung = 0;
    for (const ref of await this.list()) {
      if (liveRefs.has(ref)) continue;
      const path = this.pathFor(ref);
      try {
        const st = await stat(path);
        if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) {
          skippedYoung++;
          continue;
        }
        await unlink(path);
        freedBytes += st.size;
        deleted++;
      } catch {
        /* race con altra GC → ok */
      }
    }
    return { deleted, freedBytes, skippedYoung };
  }

  /**
   * Note #1 (review): rimuove i temp/staging ORFANI (sopravvissuti a un crash
   * a metà scrittura). `list()`/`usage()` già li ignorano (non-REF_RE), quindi
   * non corrompono l'accounting, ma sprecano spazio: questo sweep li recupera.
   * Idempotente; da chiamare allo startup e nel GC (step 4). `maxAgeMs` protegge
   * le scritture IN CORSO (default 1h) — non tocchiamo temp giovani.
   */
  async sweepStaleTemp(maxAgeMs = 3_600_000): Promise<{ deleted: number; freedBytes: number }> {
    const now = Date.now();
    let deleted = 0;
    let freedBytes = 0;
    const tryUnlink = async (p: string): Promise<void> => {
      try {
        const st = await stat(p);
        if (now - st.mtimeMs < maxAgeMs) return; // scrittura forse ancora in corso
        freedBytes += st.size;
        await unlink(p);
        deleted++;
      } catch {
        /* race con un'altra sweep / write → ok */
      }
    };
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return { deleted, freedBytes };
    }
    for (const e of entries) {
      if (e.startsWith(STAGING_PREFIX)) {
        await tryUnlink(join(this.baseDir, e));
        continue;
      }
      if (e.length === 2) {
        // shard dir → cerca .tmp-* dei writeBuffer
        let files: string[];
        try {
          files = await readdir(join(this.baseDir, e));
        } catch {
          continue;
        }
        for (const f of files)
          if (f.includes(TMP_SUFFIX)) await tryUnlink(join(this.baseDir, e, f));
      }
    }
    return { deleted, freedBytes };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aggiorna mtime (riuso dedup → blob "giovane" per la grace GC).
   * `false` = il blob è sparito/irraggiungibile tra il check e il touch (race
   * con la GC concorrente): il chiamante DEVE riscrivere, mai ritornare il ref.
   */
  private async touch(path: string): Promise<boolean> {
    const now = new Date();
    try {
      await utimes(path, now, now);
      return true;
    } catch {
      return false;
    }
  }

  /** Rename atomico temp→final. Se final è apparso nel frattempo (dedup race) ok. */
  private async commit(tmp: string, finalPath: string): Promise<void> {
    try {
      await rename(tmp, finalPath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      if (await this.pathExists(finalPath)) return; // un altro writer ha vinto: dedup
      throw err;
    }
  }
}

let _store: BinaryStore | null = null;

/**
 * Store singleton del container: baseDir = `<MEDEA_DATA_DIR>/blobs`. Il
 * runtime è per-tenant (un container = un tenant) → un solo store per processo
 * serve il disco del tenant. Iniettato come adapter del port IBinaryStore.
 */
export function getBinaryStore(): BinaryStore {
  _store ??= new BinaryStore(join(loadConfig().MEDEA_DATA_DIR, 'blobs'));
  return _store;
}

/** Reset del singleton per i test. */
export function resetBinaryStoreForTests(): void {
  _store = null;
}
