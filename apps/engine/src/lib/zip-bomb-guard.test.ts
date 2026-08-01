/**
 * Test bug-bounty — zip-bomb-guard (parsing central directory, no decompressione).
 * Costruiamo ZIP REALI con dimensioni non compresse dichiarate a piacere.
 */
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { assertNotZipBomb, assertNoZipBombDeep, sumDeclaredUncompressedBytes, ZipBombError } from './zip-bomb-guard.js';

/**
 * ZIP con 1 entry DEFLATE (method 8): `payload` è il contenuto reale; `declaredUncompressed`
 * è la dimensione DICHIARATA nell'header (può MENTIRE, < payload.length → bomba
 * declared-small/stream-large). Il deep-guard inflaziona il vero stream e conta i byte.
 */
function makeDeflateZip(name: string, payload: Buffer, declaredUncompressed: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = deflateRawSync(payload);
  const local = Buffer.alloc(30 + nameBuf.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // DEFLATE
  local.writeUInt32LE(data.length, 18);          // compressed
  local.writeUInt32LE(declaredUncompressed, 22); // uncompressed DICHIARATO (può mentire)
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  data.copy(local, 30 + nameBuf.length);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // DEFLATE
  central.writeUInt32LE(data.length, 20);          // compressed
  central.writeUInt32LE(declaredUncompressed, 24); // uncompressed DICHIARATO
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // offset local header
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

/**
 * Costruisce uno ZIP minimale (1 entry, STORED) ma con la dimensione NON compressa
 * DICHIARATA = `declaredUncompressed` (mentendo, come fa una zip-bomb). I dati reali
 * sono 1 byte: il guard deve fidarsi dell'header, non decomprimere.
 */
function makeZip(name: string, declaredUncompressed: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from([0x41]); // 1 byte reale
  const crc = 0; // irrilevante per il guard

  const local = Buffer.alloc(30 + nameBuf.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // STORED
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);          // compressed
  local.writeUInt32LE(declaredUncompressed, 22); // uncompressed DICHIARATO
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  data.copy(local, 30 + nameBuf.length);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10); // STORED
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);          // compressed
  central.writeUInt32LE(declaredUncompressed, 24); // uncompressed DICHIARATO
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // offset local header
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);  // entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // size central dir
  eocd.writeUInt32LE(local.length, 16);   // offset central dir

  return Buffer.concat([local, central, eocd]);
}

describe('zip-bomb-guard', () => {
  it('somma le dimensioni non compresse dichiarate dalla central directory', () => {
    expect(sumDeclaredUncompressedBytes(makeZip('sheet.xml', 12_345))).toBe(12_345);
  });

  it('✅ ZIP onesto (sotto soglia) → passa', () => {
    expect(() => assertNotZipBomb(makeZip('a.xml', 10 * 1024 * 1024), 250 * 1024 * 1024)).not.toThrow();
  });

  it('🚨🚨 zip-bomb: dichiara 1GB non compresso ma è 1 byte → ZipBombError (no decompressione)', () => {
    const bomb = makeZip('payload.bin', 1024 * 1024 * 1024); // 1 GB dichiarato
    expect(bomb.length).toBeLessThan(200); // il file è minuscolo
    expect(() => assertNotZipBomb(bomb, 250 * 1024 * 1024)).toThrow(ZipBombError);
  });

  it('🚨 buffer non-ZIP → null/no-op (lascia decidere al parser a valle)', () => {
    const notZip = Buffer.from('questo non e\' uno zip', 'utf8');
    expect(sumDeclaredUncompressedBytes(notZip)).toBeNull();
    expect(() => assertNotZipBomb(notZip)).not.toThrow();
  });

  it('🚨 buffer vuoto/troppo corto → no-op', () => {
    expect(() => assertNotZipBomb(Buffer.alloc(0))).not.toThrow();
    expect(() => assertNotZipBomb(Buffer.from([1, 2, 3]))).not.toThrow();
  });
});

describe('🚨🚨 assertNoZipBombDeep — inflate-streaming-con-budget (bomba declared-small/stream-large)', () => {
  it('✅ ZIP deflate ONESTO (payload sotto soglia) → passa', async () => {
    const honest = makeDeflateZip('sheet.xml', Buffer.alloc(64 * 1024, 0x41), 64 * 1024);
    await expect(assertNoZipBombDeep(honest, 1024 * 1024)).resolves.toBeUndefined();
  });

  it('🚨🚨 BYPASS del declared-check: dichiara 10 byte ma il deflate espande a 4MB → ZipBombError', async () => {
    // Questa è ESATTAMENTE la bomba che il solo declared-check NON becca: la central
    // directory mente (10 byte) ma lo stream deflate produce 4MB. Il deep-guard inflaziona
    // davvero e aborta oltre il budget (1MB) SENZA materializzare i 4MB.
    const payload = Buffer.alloc(4 * 1024 * 1024, 0); // 4MB di zeri → deflate ~4KB
    const bomb = makeDeflateZip('payload.bin', payload, 10); // DICHIARA 10 byte
    expect(bomb.length).toBeLessThan(20 * 1024); // il file è piccolo
    // Il declared-check (cheap) NON lo becca (10 < 1MB): è il deep a salvarci.
    expect(() => assertNotZipBomb(bomb, 1024 * 1024)).not.toThrow();
    await expect(assertNoZipBombDeep(bomb, 1024 * 1024)).rejects.toBeInstanceOf(ZipBombError);
  });

  it('🚨 entry STORED (method 0) che DICHIARA 10 ma ha 2MB reali → bloccato dal deep budget', async () => {
    // STORED: output = input. Dichiara 10 (cheap-check passa) ma i dati reali sono 2MB.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x42);
    const z = makeZipStored('big.bin', big, 10);
    expect(() => assertNotZipBomb(z, 1024 * 1024)).not.toThrow(); // cheap NON lo becca
    await expect(assertNoZipBombDeep(z, 1024 * 1024)).rejects.toBeInstanceOf(ZipBombError);
  });

  it('🚨 non-ZIP → no-op (deep)', async () => {
    await expect(assertNoZipBombDeep(Buffer.from('nope', 'utf8'))).resolves.toBeUndefined();
  });
});

/** ZIP con 1 entry STORED (method 0) coi DATI REALI (per testare il path stored del deep). */
function makeZipStored(name: string, data: Buffer, declaredUncompressed: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30 + nameBuf.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // STORED
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredUncompressed, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  data.copy(local, 30 + nameBuf.length);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredUncompressed, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}
