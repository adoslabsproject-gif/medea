/**
 * Caratterizzazione + bug-bounty — trigger-watchers/imap-attachment.
 *
 * Spostato e RAFFORZATO dal parsers test durante lo split (2026-06-12), ora
 * co-locato col modulo e con import DIRETTO (non più via re-export). Pinna i due
 * percorsi del builder + le invarianti di sicurezza (path-traversal-safe ref,
 * cap anti-OOM, dedup content-addressed) e i confini esatti del troncamento.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isBinaryData } from '@medea/engine-core-schema';
import { buildImapAttachment, MAX_ATTACHMENT_BYTES } from './imap-attachment.js';
import { BinaryStore } from '../binary-store.service.js';

const att = (content: Buffer, over: Record<string, unknown> = {}) =>
  ({ filename: 'doc.pdf', contentType: 'application/pdf', content, ...over });

async function withStore<T>(fn: (store: BinaryStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'imap-att-'));
  try {
    return await fn(new BinaryStore(join(root, 'blobs')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('buildImapAttachment — ref-primario CON store', () => {
  it('🚨 handle ref, contenuto INTERO (no troncamento anche oltre cap), byte fedeli, MAI base64', async () => {
    await withStore(async (store) => {
      const content = Buffer.alloc(100, 0x42); // > maxBytes ma il ref NON tronca
      const r = await buildImapAttachment(att(content), store, 10);
      expect(isBinaryData(r.binary)).toBe(true);
      expect(r.binary.encoding).toBe('ref');
      expect((r.binary as { data?: unknown }).data).toBeUndefined(); // niente base64 inline
      expect(r.truncated).toBe(false);
      expect(r.binary.ref).toBe(createHash('sha256').update(content).digest('hex'));
      expect((await store.read(r.binary.ref!)).equals(content)).toBe(true);
    });
  });

  it('🚨 SECURITY: filename email malevolo → ref = sha256 del CONTENUTO (no path-traversal)', async () => {
    await withStore(async (store) => {
      const content = Buffer.from([0x00, 0x01]);
      const r = await buildImapAttachment(att(content, { filename: '../../../etc/passwd' }), store);
      expect(r.binary.ref).toBe(createHash('sha256').update(content).digest('hex'));
      expect(r.binary.fileName).toBe('../../../etc/passwd'); // resta puro metadata innocuo
      expect((await store.read(r.binary.ref!)).equals(content)).toBe(true);
    });
  });

  it('🚨 dedup content-addressed: due allegati identici (filename diverso) → 1 solo blob', async () => {
    await withStore(async (store) => {
      const content = Buffer.from('same-attachment-bytes');
      await buildImapAttachment(att(content), store);
      await buildImapAttachment(att(content, { filename: 'other.pdf' }), store);
      expect(await store.list()).toHaveLength(1);
    });
  });

  it('contentType e size preservati; filename mancante → "attachment"', async () => {
    await withStore(async (store) => {
      const content = Buffer.from('xyz');
      const r = await buildImapAttachment({ contentType: 'image/png', content }, store);
      expect(r.contentType).toBe('image/png');
      expect(r.size).toBe(3);
      expect(r.filename).toBe('attachment'); // default
      expect(r.binary.fileName).toBe('attachment');
    });
  });
});

describe('buildImapAttachment — fail-soft SENZA store', () => {
  it('🚨 inline base64, cap anti-OOM applicato, size = originale', async () => {
    const content = Buffer.alloc(100, 0x41);
    const r = await buildImapAttachment(att(content), undefined, 10);
    expect(r.binary.encoding).toBe('base64');
    expect(Buffer.from(r.binary.data!, 'base64').length).toBe(10); // troncato a maxBytes
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(100);
  });

  it('🚨 boundary del cap: size === maxBytes → NON troncato; size === maxBytes+1 → troncato', async () => {
    const exact = await buildImapAttachment(att(Buffer.alloc(10, 1)), undefined, 10);
    expect(exact.truncated).toBe(false);
    expect(Buffer.from(exact.binary.data!, 'base64').length).toBe(10);

    const over = await buildImapAttachment(att(Buffer.alloc(11, 1)), undefined, 10);
    expect(over.truncated).toBe(true);
    expect(Buffer.from(over.binary.data!, 'base64').length).toBe(10);
  });

  it('buffer vuoto → base64 vuoto, size 0, non troncato', async () => {
    const r = await buildImapAttachment(att(Buffer.alloc(0)), undefined, 10);
    expect(r.size).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.binary.data).toBe('');
  });

  it('default maxBytes = MAX_ATTACHMENT_BYTES (25MB) → allegati normali NON troncati', async () => {
    const r = await buildImapAttachment(att(Buffer.alloc(1024, 7)), undefined);
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThanOrEqual(1024);
    expect(r.truncated).toBe(false);
  });
});
