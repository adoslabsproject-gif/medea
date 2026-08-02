/**
 * zip-bomb-guard — difesa anti zip-bomb per i formati ZIP-based (XLSX/DOCX/…).
 *
 * Un .xlsx è uno ZIP: il cap sui byte d'INPUT (compressi) NON protegge dalla
 * decompressione — un file di pochi MB può dichiarare GB di contenuto non compresso
 * (zip bomb) e mandare in OOM il parser (exceljs decomprime TUTTO in memoria prima
 * che un cap-righe possa intervenire).
 *
 * Strategia (zero dipendenze, NESSUNA decompressione): leggiamo la *central directory*
 * dello ZIP — che contiene la dimensione NON compressa dichiarata di ogni entry — e
 * rifiutiamo se la somma supera un tetto. Le dimensioni stanno nell'header senza
 * bisogno di inflare alcun byte. Un'entry ZIP64 (size = 0xFFFFFFFF, ≥4GB) è
 * trattata come oltre-soglia → rifiutata.
 *
 * @module lib/zip-bomb-guard
 */

import { createInflateRaw } from 'node:zlib';

/** Tetto di default sul totale NON compresso (250 MB): generoso per XLSX legittimi. */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

/** Sollevata quando lo ZIP dichiara un contenuto non compresso oltre il tetto. */
export class ZipBombError extends Error {
  constructor(
    readonly declaredBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `file ZIP/XLSX rifiutato: contenuto non compresso dichiarato ${(declaredBytes / 1048576).toFixed(1)} MB ` +
        `oltre il limite di ${(maxBytes / 1048576).toFixed(0)} MB (protezione anti zip-bomb).`,
    );
    this.name = 'ZipBombError';
  }
}

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDFH_SIG = 0x02014b50; // Central Directory File Header

/** Trova l'offset dell'EOCD scandendo dalla fine (il comment finale è ≤ 65535 byte). */
function findEocd(buf: Buffer): number {
  const minLen = 22; // EOCD minimo
  if (buf.length < minLen) return -1;
  const from = Math.max(0, buf.length - (minLen + 0xffff));
  for (let i = buf.length - minLen; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Somma la dimensione NON compressa dichiarata da TUTTE le entry della central
 * directory. Ritorna `null` se il buffer non è uno ZIP riconoscibile (lasciando
 * decidere al parser a valle: qui non vogliamo bloccare input non-ZIP).
 */
export function sumDeclaredUncompressedBytes(buf: Buffer): number | null {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16); // offset central directory
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDFH_SIG) break;
    const uncompressed = buf.readUInt32LE(offset + 24);
    // ZIP64 sentinel: la dimensione reale (≥4GB) sta nell'extra field → la trattiamo
    // come "enorme" sommando il sentinel stesso (≈4GB) → supera qualunque tetto sano.
    total += uncompressed;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

/**
 * Lancia {@link ZipBombError} se lo ZIP dichiara più di `maxBytes` non compressi.
 * No-op se il buffer non è uno ZIP (il parser a valle gestirà l'errore di formato).
 */
export function assertNotZipBomb(
  buf: Buffer,
  maxBytes: number = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): void {
  const declared = sumDeclaredUncompressedBytes(buf);
  if (declared !== null && declared > maxBytes) {
    throw new ZipBombError(declared, maxBytes);
  }
}

const LFH_SIG = 0x04034b50; // Local File Header

/** Posizione [start,end) dei dati COMPRESSI di un'entry nel local file header. `null` se
 *  l'header non è valido o i dati escono dal buffer. */
function localDataRange(
  buf: Buffer,
  lhOffset: number,
  compSize: number,
): { start: number; end: number } | null {
  if (lhOffset + 30 > buf.length || buf.readUInt32LE(lhOffset) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(lhOffset + 26);
  const extraLen = buf.readUInt16LE(lhOffset + 28);
  const start = lhOffset + 30 + nameLen + extraLen;
  const end = start + compSize;
  return end <= buf.length ? { start, end } : null;
}

/**
 * Inflaziona `compressed` (deflate RAW) in STREAMING contando i byte PRODOTTI; risolve
 * il totale, oppure RIGETTA con {@link ZipBombError} appena il prodotto supera `budget`
 * (abort EARLY: la destroy ferma l'inflater → non si materializza oltre il chunk corrente,
 * niente OOM). Errori di stream non-bomb → risolvono 0 (formato gestito dal parser a valle).
 */
function inflateCountWithinBudget(compressed: Buffer, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let produced = 0;
    let settled = false;
    inflate.on('data', (chunk: Buffer) => {
      produced += chunk.length;
      if (produced > budget && !settled) {
        settled = true;
        inflate.destroy();
        reject(new ZipBombError(produced, budget));
      }
    });
    inflate.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(produced);
      }
    });
    inflate.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (err instanceof ZipBombError) reject(err);
      else resolve(0); // stream corrotto/non-deflate → non è il nostro dominio
    });
    inflate.end(compressed);
  });
}

/**
 * Protezione anti zip-bomb COMPLETA: oltre al declared-check ({@link assertNotZipBomb}),
 * INFLAZIONA davvero ogni entry (streaming) con un BUDGET cumulativo su `maxBytes`.
 * Difende dalla bomba che dichiara una size piccola ma il cui deflate-stream espande a GB
 * (il declared-check da solo è aggirabile). Lancia {@link ZipBombError} appena il totale
 * decompresso reale supera il tetto, SENZA mai materializzarlo (abort early via destroy).
 * No-op se il buffer non è uno ZIP.
 */
export async function assertNoZipBombDeep(
  buf: Buffer,
  maxBytes: number = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): Promise<void> {
  assertNotZipBomb(buf, maxBytes); // 1) pass cheap: naive bombs + ZIP64 sentinel
  const eocd = findEocd(buf);
  if (eocd < 0) return;
  const entries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let produced = 0;
  for (let i = 0; i < entries; i++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== CDFH_SIG) break;
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const lhOffset = buf.readUInt32LE(cdOffset + 42);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const range = localDataRange(buf, lhOffset, compSize);
    if (range) {
      const slice = buf.subarray(range.start, range.end);
      if (method === 0) {
        produced += slice.length; // stored: output = input (nessuna inflazione)
      } else if (method === 8) {
        produced += await inflateCountWithinBudget(slice, maxBytes - produced);
      }
      // altri metodi (bzip2/lzma, rari in xlsx) → coperti dal declared-check sopra.
      if (produced > maxBytes) throw new ZipBombError(produced, maxBytes);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
}
