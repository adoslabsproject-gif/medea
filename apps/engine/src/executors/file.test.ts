/**
 * Test file executor — path resolve + realpath guard 2026-05-29.
 *
 * Fix: assertPathAllowed validava path.resolve() ma path.resolve NON segue
 * symlinks → /tmp/foo→/etc/passwd potrebbe bypassare. assertRealpathInsideTenant
 * usa fs.realpath() per risolvere symlinks PRIMA del check.
 *
 * Test focus:
 *  - assertPathAllowed accept paths sotto tenant root
 *  - assertPathAllowed reject paths fuori namespace
 *  - assertPathAllowed sanitizes tenantId (no path traversal via tenant)
 *  - global allowlist FLOWFORGE_FILE_ALLOWLIST funziona
 */
import type { BinaryStore } from '../services/binary-store.service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BinaryData } from '@flowforge/core-schema';

const origAllow = process.env.FLOWFORGE_FILE_ALLOWLIST;
const origDataDir = process.env.FLOWFORGE_DATA_DIR;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ff-file-test-'));
  process.env.FLOWFORGE_DATA_DIR = tmpRoot;
  delete process.env.FLOWFORGE_FILE_ALLOWLIST;
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
  if (origAllow === undefined) delete process.env.FLOWFORGE_FILE_ALLOWLIST;
  else process.env.FLOWFORGE_FILE_ALLOWLIST = origAllow;
  if (origDataDir === undefined) delete process.env.FLOWFORGE_DATA_DIR;
  else process.env.FLOWFORGE_DATA_DIR = origDataDir;
});

describe('fileWriteExecutor + fileReadExecutor — namespace isolation', () => {
  it('write su path relativo → file in tenant root', async () => {
    const { fileWriteExecutor, fileReadExecutor } = await import('./file');
    const ctx = { tenantId: 'tenant-a' } as { tenantId: string };
    const wrote = await fileWriteExecutor(
      { path: 'note.txt', content: 'hello' },
      undefined,
      ctx as never,
    );
    const wroteOutput = (wrote as { output: { path: string } }).output;
    expect(wroteOutput.path).toContain('tenant-a');
    expect(wroteOutput.path).toContain('note.txt');

    const read = await fileReadExecutor({ path: 'note.txt' }, undefined, ctx as never);
    const readOutput = (read as { output: { content: string } }).output;
    expect(readOutput.content).toBe('hello');
  });

  it('write fuori namespace (absolute path estranea) → throw', async () => {
    const { fileWriteExecutor } = await import('./file');
    const ctx = { tenantId: 'tenant-a' } as { tenantId: string };
    await expect(
      fileWriteExecutor({ path: '/etc/passwd-zeli-test', content: 'bad' }, undefined, ctx as never),
    ).rejects.toThrow(/outside tenant namespace/);
  });

  it('write con tenantId malevolo (path traversal) → sanitize', async () => {
    const { fileWriteExecutor } = await import('./file');
    // tenant malformato viene sanitizzato a `_`
    const ctx = { tenantId: '../escape' } as { tenantId: string };
    const wrote = await fileWriteExecutor(
      { path: 'inner.txt', content: 'x' },
      undefined,
      ctx as never,
    );
    const out = (wrote as { output: { path: string } }).output;
    // Il path finale NON deve contenere '..'
    expect(out.path).not.toContain('..');
    // Deve essere sotto tenants/
    expect(out.path).toContain('tenants');
  });

  it('global allowlist permette path globalmente shared', async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), 'ff-shared-'));
    process.env.FLOWFORGE_FILE_ALLOWLIST = sharedDir;
    const { fileWriteExecutor } = await import('./file');
    const ctx = { tenantId: 'tenant-a' } as { tenantId: string };
    const target = join(sharedDir, 'shared.txt');
    const wrote = await fileWriteExecutor(
      { path: target, content: 'shared' },
      undefined,
      ctx as never,
    );
    // L'executor canonicalizza i path via realpath (security). Su macOS
    // i temp dir /var/folders/* sono symlink → /private/var/folders/*,
    // quindi confrontiamo contro la versione canonicalizzata.
    expect((wrote as { output: { path: string } }).output.path).toBe(realpathSync(target));
    rmSync(sharedDir, { recursive: true, force: true });
  });

  it('symlink che esce dal namespace → realpath blocca', async () => {
    // Setup: dentro tenant root, crea un symlink che punta a /etc/passwd
    const { fileWriteExecutor } = await import('./file');
    const tenantA = join(tmpRoot, 'tenants', 'tenant-a', 'files');
    mkdirSync(tenantA, { recursive: true });
    // Punta a file esterno (creiamo un finto /etc-like in tmpdir per test)
    const externalRoot = mkdtempSync(join(tmpdir(), 'ff-external-'));
    const externalFile = join(externalRoot, 'sensitive');
    writeFileSync(externalFile, 'EXTERNAL SECRET');
    const link = join(tenantA, 'escape-link');
    symlinkSync(externalFile, link);
    const ctx = { tenantId: 'tenant-a' } as { tenantId: string };
    // Tentativo di scrivere overwrite del symlink → realpath risolve a
    // externalFile → fuori namespace → throw.
    await expect(
      fileWriteExecutor({ path: 'escape-link', content: 'hacked' }, undefined, ctx as never),
    ).rejects.toThrow(/symlinks|OUTSIDE/);
    rmSync(externalRoot, { recursive: true, force: true });
  });
});

describe('🚨 GAP2 FLIP — fileReadExecutor: encoding binario → handle BinaryData (ref-primario)', () => {
  async function ctxWithStore(): Promise<{ ctx: { tenantId: string; writeBinary: unknown }; store: BinaryStore }> {
    const { BinaryStore } = await import('../services/binary-store.service');
    const { makeBinaryRef } = await import('@flowforge/core-schema');
    const store = new BinaryStore(join(tmpRoot, 'blobs'));
    // stessa logica della NodeExecutorStrategy (writeBuffer + makeBinaryRef)
    const writeBinary = async (data: Buffer, meta: { mimeType: string; fileName?: string }): Promise<BinaryData> => {
      const r = await store.writeBuffer(data);
      return makeBinaryRef({ mimeType: meta.mimeType, ref: r.ref, size: r.size, sha256: r.sha256, ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}) });
    };
    return { ctx: { tenantId: 'tenant-a', writeBinary }, store };
  }

  it('🚨 encoding=binary CON store → handle ref, mimeType da estensione, niente content', async () => {
    const { fileWriteExecutor, fileReadExecutor } = await import('./file');
    const { isBinaryData } = await import('@flowforge/core-schema');
    const { ctx, store } = await ctxWithStore();
    await fileWriteExecutor({ path: 'doc.pdf', content: '%PDF-1.4 fake bytes' }, undefined, ctx as never);

    const read = await fileReadExecutor({ path: 'doc.pdf', encoding: 'binary' }, undefined, ctx as never);
    const out = (read as { output: Record<string, unknown> }).output;
    expect(isBinaryData(out.binary)).toBe(true);
    const bin = out.binary as BinaryData;
    expect(bin.encoding).toBe('ref');
    expect(bin.ref).toMatch(/^[0-9a-f]{64}$/u);
    expect(bin.mimeType).toBe('application/pdf');   // dedotto da .pdf
    expect(bin.fileName).toBe('doc.pdf');
    expect(out.content).toBeUndefined();            // ← niente byte nel JSON
    // il blob è davvero sul disco e ha i byte giusti
    expect((await store.read(bin.ref!)).toString()).toBe('%PDF-1.4 fake bytes');
  });

  it('🚨 encoding=base64 → ANCHE handle (non più stringa base64 — il flip)', async () => {
    const { fileWriteExecutor, fileReadExecutor } = await import('./file');
    const { isBinaryData } = await import('@flowforge/core-schema');
    const { ctx } = await ctxWithStore();
    await fileWriteExecutor({ path: 'photo.jpg', content: 'JPEGDATA' }, undefined, ctx as never);

    const read = await fileReadExecutor({ path: 'photo.jpg', encoding: 'base64' }, undefined, ctx as never);
    const out = (read as { output: Record<string, unknown> }).output;
    expect(isBinaryData(out.binary)).toBe(true);     // base64 NON è più una stringa di content
    expect(out.content).toBeUndefined();
    expect((out.binary as BinaryData).mimeType).toBe('image/jpeg');
  });

  it('🚨 encoding=binary SENZA store → fallback BinaryData inline base64 (fail-soft, non legacy)', async () => {
    const { fileWriteExecutor, fileReadExecutor } = await import('./file');
    const { isBinaryData } = await import('@flowforge/core-schema');
    const ctx = { tenantId: 'tenant-a' }; // niente writeBinary
    await fileWriteExecutor({ path: 'img.png', content: 'PNGDATA' }, undefined, ctx as never);

    const read = await fileReadExecutor({ path: 'img.png', encoding: 'binary' }, undefined, ctx as never);
    const out = (read as { output: { binary: BinaryData } }).output;
    expect(isBinaryData(out.binary)).toBe(true);
    expect(out.binary.encoding).toBe('base64');
    expect(out.binary.mimeType).toBe('image/png');
    expect(Buffer.from(out.binary.data!, 'base64').toString()).toBe('PNGDATA');
  });

  it('🚨 encoding TESTUALE (utf8 default) → content string, MAI handle', async () => {
    const { fileWriteExecutor, fileReadExecutor } = await import('./file');
    const ctx = { tenantId: 'tenant-a' };
    await fileWriteExecutor({ path: 'note.txt', content: 'plain text' }, undefined, ctx as never);

    const read = await fileReadExecutor({ path: 'note.txt' }, undefined, ctx as never);
    const out = (read as { output: Record<string, unknown> }).output;
    expect(out.content).toBe('plain text');
    expect(out.binary).toBeUndefined();
    expect(out.encoding).toBe('utf8');
  });
});

describe('🚨 GAP2 step3b — fileWriteExecutor consumer di BinaryData (byte fedeli, zero-regressione)', () => {
  async function ctxStore(): Promise<{ ctx: { tenantId: string; readBinary: (r: string) => Promise<Buffer> }; store: BinaryStore }> {
    const { BinaryStore } = await import('../services/binary-store.service');
    const store = new BinaryStore(join(tmpRoot, 'blobs'));
    return { ctx: { tenantId: 'tenant-a', readBinary: (r: string): Promise<Buffer> => store.read(r) }, store };
  }

  it('🚨 input BinaryData ref → scrive i BYTE reali risolti via readBinary (incl. NUL/high)', async () => {
    const { fileWriteExecutor } = await import('./file');
    const { makeBinaryRef } = await import('@flowforge/core-schema');
    const { ctx, store } = await ctxStore();
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42, 0x00]);
    const r = await store.writeBuffer(bytes);
    const bin = makeBinaryRef({ mimeType: 'application/octet-stream', ref: r.ref, size: r.size, sha256: r.sha256 });

    const res = await fileWriteExecutor({ path: 'out.bin' }, bin, ctx as never);
    const out = (res as { output: { path: string; binary?: boolean; bytesWritten: number } }).output;
    expect(out.binary).toBe(true);
    expect(out.bytesWritten).toBe(bytes.byteLength);
    expect(readFileSync(out.path).equals(bytes)).toBe(true); // byte fedeli su disco
  });

  it('🚨 input BinaryData inline base64 → scrive i byte (nessuno store necessario)', async () => {
    const { fileWriteExecutor } = await import('./file');
    const { makeBinaryInline } = await import('@flowforge/core-schema');
    const bytes = Buffer.from([0x10, 0x20, 0x00, 0xaa]);
    const bin = makeBinaryInline({ mimeType: 'application/octet-stream', data: bytes.toString('base64') });
    const ctx = { tenantId: 'tenant-a' }; // niente readBinary: inline non ne ha bisogno

    const res = await fileWriteExecutor({ path: 'inline.bin' }, bin, ctx as never);
    const out = (res as { output: { path: string; binary?: boolean } }).output;
    expect(out.binary).toBe(true);
    expect(readFileSync(out.path).equals(bytes)).toBe(true);
  });

  it('🚨 PRECEDENZA: content esplicito vince sul binary input (back-compat totale)', async () => {
    const { fileWriteExecutor } = await import('./file');
    const { makeBinaryInline } = await import('@flowforge/core-schema');
    const bin = makeBinaryInline({ mimeType: 'text/plain', data: Buffer.from('BINARY').toString('base64') });
    const ctx = { tenantId: 'tenant-a' };
    // content esplicito presente E binary input presente → content vince
    const res = await fileWriteExecutor({ path: 'prio.txt', content: 'EXPLICIT' }, bin, ctx as never);
    const out = (res as { output: { path: string; binary?: boolean } }).output;
    expect(out.binary).toBeUndefined();
    expect(readFileSync(out.path, 'utf8')).toBe('EXPLICIT');
  });

  it('🚨 REGRESSIONE: input NON binario (oggetto/stringa) → comportamento attuale invariato', async () => {
    const { fileWriteExecutor } = await import('./file');
    const ctx = { tenantId: 'tenant-a' };
    // input è un oggetto qualsiasi (no __ffBinary) → ignorato, scrive content
    const res = await fileWriteExecutor({ path: 'reg.txt', content: 'hello' }, { foo: 'bar' }, ctx as never);
    const out = (res as { output: { path: string; binary?: boolean } }).output;
    expect(out.binary).toBeUndefined();
    expect(readFileSync(out.path, 'utf8')).toBe('hello');
  });

  it('🚨 ROUND-TRIP read(encoding=binary)→write(consumer): file byte-identico, mai base64 via stringa', async () => {
    const { fileReadExecutor, fileWriteExecutor } = await import('./file');
    const { makeBinaryInline, makeBinaryRef } = await import('@flowforge/core-schema');
    const { BinaryStore } = await import('../services/binary-store.service');
    const store = new BinaryStore(join(tmpRoot, 'blobs'));
    const ctx = {
      tenantId: 'tenant-a',
      readBinary: (r: string): Promise<Buffer> => store.read(r),
      writeBinary: async (data: Buffer, meta: { mimeType: string; fileName?: string }) => {
        const w = await store.writeBuffer(data);
        return makeBinaryRef({ mimeType: meta.mimeType, ref: w.ref, size: w.size, sha256: w.sha256, ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}) });
      },
    };
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]); // PNG header + NUL + CRLF

    // 1) seed: scrivo i byte raw via consumer (input inline)
    const seed = makeBinaryInline({ mimeType: 'image/png', data: original.toString('base64'), fileName: 'orig.png' });
    await fileWriteExecutor({ path: 'orig.png' }, seed, ctx as never);
    // 2) read encoding=binary → handle ref (NON base64 in output)
    const read = await fileReadExecutor({ path: 'orig.png', encoding: 'binary' }, undefined, ctx as never);
    const readBin = (read as { output: { binary: BinaryData } }).output.binary;
    expect(readBin.encoding).toBe('ref');
    // 3) write il ref → copia
    const wrote = await fileWriteExecutor({ path: 'copy.png' }, readBin, ctx as never);
    const copyPath = (wrote as { output: { path: string } }).output.path;
    // 4) la copia è BYTE-IDENTICA all'originale (mai degradato attraverso una stringa)
    expect(readFileSync(copyPath).equals(original)).toBe(true);
  });
});
