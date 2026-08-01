import { describe, it, expect, vi } from 'vitest';
import { BinaryDataSchema, isBinaryData, makeBinaryInline, makeBinaryRef, getBinaryData, readBinaryBytes, resolveBinaryValue } from './binary.js';

describe('readBinaryBytes (runtime resolver del ref)', () => {
  it('encoding=base64 → decodifica inline senza reader', async () => {
    const b = makeBinaryInline({ mimeType: 'text/plain', data: Buffer.from('ciao').toString('base64') });
    const bytes = await readBinaryBytes(b);
    expect(bytes.toString('utf8')).toBe('ciao');
  });

  it('encoding=ref → delega al refReader', async () => {
    const reader = vi.fn(async (ref: string) => Buffer.from(`bytes-of:${ref}`));
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'blob://abc', size: 9 });
    const bytes = await readBinaryBytes(b, reader);
    expect(reader).toHaveBeenCalledWith('blob://abc');
    expect(bytes.toString('utf8')).toBe('bytes-of:blob://abc');
  });

  it('encoding=ref senza reader → errore esplicito', async () => {
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'blob://abc', size: 1 });
    await expect(readBinaryBytes(b)).rejects.toThrow(/refReader richiesto/u);
  });
});

describe('BinaryData', () => {
  it('makeBinaryInline: deriva size dai byte base64 + brand', () => {
    const b = makeBinaryInline({ mimeType: 'text/plain', data: Buffer.from('hello').toString('base64'), fileName: 'h.txt' });
    expect(b.__ffBinary).toBe(true);
    expect(b.encoding).toBe('base64');
    expect(b.size).toBe(5);
    expect(b.fileName).toBe('h.txt');
    expect(BinaryDataSchema.safeParse(b).success).toBe(true);
  });

  it('makeBinaryRef: handle a storage + size esplicito', () => {
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'blob://abc', size: 1048576 });
    expect(b.encoding).toBe('ref');
    expect(b.ref).toBe('blob://abc');
    expect(b.size).toBe(1048576);
    expect(BinaryDataSchema.safeParse(b).success).toBe(true);
  });

  it('isBinaryData: discrimina binari da oggetti normali', () => {
    expect(isBinaryData(makeBinaryInline({ mimeType: 'image/png', data: '' }))).toBe(true);
    expect(isBinaryData({ foo: 'bar' })).toBe(false);
    expect(isBinaryData({ __ffBinary: true })).toBe(false); // manca mimeType/size
    expect(isBinaryData(null)).toBe(false);
    expect(isBinaryData('x')).toBe(false);
  });

  it('getBinaryData: output binario diretto', () => {
    const b = makeBinaryInline({ mimeType: 'image/png', data: '' });
    expect(getBinaryData(b)).toBe(b);
  });

  it('getBinaryData: campo specifico per key', () => {
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'r', size: 1 });
    expect(getBinaryData({ file: b, other: 1 }, 'file')).toBe(b);
    expect(getBinaryData({ file: b }, 'missing')).toBeNull();
  });

  it('getBinaryData: trova il primo campo binario senza key', () => {
    const b = makeBinaryInline({ mimeType: 'text/csv', data: '' });
    expect(getBinaryData({ a: 1, doc: b })).toBe(b);
    expect(getBinaryData({ a: 1, b: 2 })).toBeNull();
  });
});

describe('🚨 resolveBinaryValue (resolver universale consumatore — capstone ref-primario)', () => {
  it('🚨 BinaryData ref → byte risolti via reader (trasparente: il consumatore non sa che era un ref)', async () => {
    const reader = vi.fn(async (ref: string) => Buffer.from(`DISK:${ref}`));
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'sha', size: 4 });
    const bytes = await resolveBinaryValue(b, reader);
    expect(bytes?.toString('utf8')).toBe('DISK:sha');
    expect(reader).toHaveBeenCalledWith('sha');
  });

  it('🚨 BinaryData inline → byte senza reader (fallback)', async () => {
    const b = makeBinaryInline({ mimeType: 'text/plain', data: Buffer.from('inline-bytes').toString('base64') });
    const bytes = await resolveBinaryValue(b, undefined);
    expect(bytes?.toString('utf8')).toBe('inline-bytes');
  });

  it('🚨 oggetto che CONTIENE un BinaryData (es. { binary }) → risolto', async () => {
    const reader = vi.fn(async () => Buffer.from('from-field'));
    const wrapped = { filename: 'x.pdf', binary: makeBinaryRef({ mimeType: 'application/pdf', ref: 'r', size: 1 }) };
    const bytes = await resolveBinaryValue(wrapped, reader);
    expect(bytes?.toString('utf8')).toBe('from-field');
  });

  it('🚨 NON binario (stringa / oggetto semplice / null) → null (il chiamante usa la sua forma legacy)', async () => {
    expect(await resolveBinaryValue('just a base64 string')).toBeNull();
    expect(await resolveBinaryValue({ a: 1, b: 2 })).toBeNull();
    expect(await resolveBinaryValue(null)).toBeNull();
    expect(await resolveBinaryValue(42)).toBeNull();
  });

  it('🚨 BinaryData ref SENZA reader → propaga l\'errore esplicito (no byte silenziosamente vuoti)', async () => {
    const b = makeBinaryRef({ mimeType: 'application/pdf', ref: 'r', size: 1 });
    await expect(resolveBinaryValue(b, undefined)).rejects.toThrow(/refReader richiesto/u);
  });
});
