/**
 * Test — inlineBinaryRefs: il bridge REF-PRIMARIO dei community node.
 *
 * Un handle BinaryData encoding='ref' è un riferimento al disco HOST: l'isolate
 * non può risolverlo. Prima di iniettare l'input nella VM, ogni ref va convertito
 * in INLINE base64 (leggendo i byte host-side) così il community node li riceve.
 */
import { describe, it, expect, vi } from 'vitest';
import { inlineBinaryRefs } from './community-node.js';

const refBin = (ref: string, mime = 'application/pdf', fileName?: string): unknown =>
  ({ __ffBinary: true, encoding: 'ref', mimeType: mime, size: 4, ref, ...(fileName !== undefined ? { fileName } : {}) });
const inlineBin = (data: string): unknown =>
  ({ __ffBinary: true, encoding: 'base64', mimeType: 'image/png', size: Buffer.from(data, 'base64').length, data });

describe('🚨 GAP2 FLIP — inlineBinaryRefs (community node ricevono handle risolti)', () => {
  it('🚨 ref top-level → inline base64 via readBinary (byte fedeli, niente ref nella VM)', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const readBinary = vi.fn(async (_r: string) => bytes);
    const out = await inlineBinaryRefs(refBin('a'.repeat(64), 'application/pdf', 'doc.pdf'), readBinary) as {
      __ffBinary: boolean; encoding: string; data: string; mimeType: string; fileName?: string;
    };
    expect(readBinary).toHaveBeenCalledWith('a'.repeat(64));
    expect(out.encoding).toBe('base64');                                  // niente più ref
    expect(Buffer.from(out.data, 'base64').equals(bytes)).toBe(true);     // byte fedeli
    expect(out.mimeType).toBe('application/pdf');
    expect(out.fileName).toBe('doc.pdf');                                 // metadata preservato
  });

  it('🚨 ref ANNIDATO (in oggetto + array) → risolto ricorsivamente', async () => {
    const bytes = Buffer.from('nested-bytes');
    const readBinary = vi.fn(async (_r: string) => bytes);
    const input = { meta: { x: 1 }, attachments: [{ file: refBin('b'.repeat(64)) }] };
    const out = await inlineBinaryRefs(input, readBinary) as { attachments: { file: { encoding: string; data: string } }[] };
    expect(out.attachments[0]!.file.encoding).toBe('base64');
    expect(Buffer.from(out.attachments[0]!.file.data, 'base64').equals(bytes)).toBe(true);
  });

  it('🚨 handle GIÀ inline → invariato (nessun readBinary, è già trasportabile)', async () => {
    const readBinary = vi.fn();
    const bin = inlineBin(Buffer.from('PNG').toString('base64'));
    const out = await inlineBinaryRefs(bin, readBinary);
    expect(out).toBe(bin);                 // stesso riferimento, intatto
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('🚨 valori non-binari (stringhe/numeri/null) → invariati', async () => {
    expect(await inlineBinaryRefs('hello')).toBe('hello');
    expect(await inlineBinaryRefs(42)).toBe(42);
    expect(await inlineBinaryRefs(null)).toBe(null);
    expect(await inlineBinaryRefs({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
  });

  it('🚨 ref SENZA readBinary → errore esplicito (no byte vuoti silenziosi nella VM)', async () => {
    await expect(inlineBinaryRefs(refBin('c'.repeat(64)))).rejects.toThrow(/refReader richiesto/u);
  });
});
