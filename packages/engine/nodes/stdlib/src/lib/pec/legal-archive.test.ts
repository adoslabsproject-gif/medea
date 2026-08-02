/**
 * Test legal-archive.
 *
 * Copre:
 *   • archivePec scrive eml + sidecar SHA + appended manifest JSONL
 *   • receiptId deterministico → idempotenza
 *   • verifyArchive ok / mismatch
 *   • TypeError su input mancante
 *   • conservation default 10 anni (3650gg)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivePec, verifyArchive } from './legal-archive.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pec-archive-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('archivePec', () => {
  it('writes eml + sidecar SHA-256 + manifest JSONL', async () => {
    const r = await archivePec(
      {
        raw: 'From: a\r\nSubject: x\r\n\r\nhello',
        messageId: '<m1@x>',
        receivedAt: '2026-06-04T10:00:00Z',
      },
      { archiveDir: dir, now: () => new Date('2026-06-04T10:00:00Z') },
    );

    expect(r.archiveId.length).toBe(16);
    expect(r.byteLength).toBeGreaterThan(0);
    expect(r.hashAlgorithm).toBe('sha256');
    expect(r.archivePath.endsWith(`.eml`)).toBe(true);

    // sidecar exists with matching hash
    const sidecar = await fs.readFile(r.sidecarPath!, 'utf8');
    expect(sidecar).toContain(r.hashHex);

    // manifest jsonl appended
    const manifest = await fs.readFile(join(dir, 'manifest.jsonl'), 'utf8');
    expect(manifest.split('\n').filter((l) => l.length > 0).length).toBe(1);
    const entry = JSON.parse(manifest.trim());
    expect(entry.archiveId).toBe(r.archiveId);
    expect(entry.op).toBe('archive');
  });

  it('default conservation = 3650 days (10 years)', async () => {
    const r = await archivePec(
      { raw: 'x', messageId: '<m1>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, now: () => new Date('2026-06-04T10:00:00Z') },
    );
    const archivedAt = new Date(r.archivedAt);
    const until = new Date(r.conservationUntil);
    const days = Math.round((until.getTime() - archivedAt.getTime()) / 86_400_000);
    expect(days).toBe(3650);
  });

  it('receiptId is deterministic for same messageId+receivedAt', async () => {
    const a = await archivePec(
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir },
    );
    const b = await archivePec(
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir },
    );
    expect(b.archiveId).toBe(a.archiveId);
  });

  it('rejects missing messageId / receivedAt / raw', async () => {
    await expect(
      archivePec(
        { raw: 'x', messageId: '', receivedAt: '2026-06-04T10:00:00Z' },
        { archiveDir: dir },
      ),
    ).rejects.toThrow();
    await expect(
      archivePec({ raw: 'x', messageId: '<m>', receivedAt: '' }, { archiveDir: dir }),
    ).rejects.toThrow();
  });

  it('clamps conservationDays to ≥365', async () => {
    const r = await archivePec(
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, conservationDays: 1, now: () => new Date('2026-06-04T10:00:00Z') },
    );
    const days = Math.round(
      (new Date(r.conservationUntil).getTime() - new Date(r.archivedAt).getTime()) / 86_400_000,
    );
    expect(days).toBe(365);
  });

  it('accepts Buffer input identically to string', async () => {
    const str = await archivePec(
      { raw: 'hello', messageId: '<m1>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, now: () => new Date('2026-06-04T10:00:00Z') },
    );
    const buf = await archivePec(
      { raw: Buffer.from('hello', 'utf8'), messageId: '<m2>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, now: () => new Date('2026-06-04T10:00:00Z') },
    );
    expect(str.hashHex).toBe(buf.hashHex);
  });

  it('writeSidecar=false skips the .sha256 file', async () => {
    const r = await archivePec(
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, writeSidecar: false },
    );
    expect(r.sidecarPath).toBeNull();
  });
});

describe('verifyArchive', () => {
  it('returns ok=true when file matches sidecar hash', async () => {
    const r = await archivePec(
      { raw: 'integrity content', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir },
    );
    const v = await verifyArchive(r.archivePath, 'sha256');
    expect(v.ok).toBe(true);
    expect(v.actualHash).toBe(r.hashHex);
  });

  it('returns ok=false when file tampered with', async () => {
    const r = await archivePec(
      { raw: 'original', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir },
    );
    await fs.writeFile(r.archivePath, 'tampered');
    const v = await verifyArchive(r.archivePath, 'sha256');
    expect(v.ok).toBe(false);
  });

  it('returns expectedHash=null when sidecar missing', async () => {
    const r = await archivePec(
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      { archiveDir: dir, writeSidecar: false },
    );
    const v = await verifyArchive(r.archivePath, 'sha256');
    expect(v.expectedHash).toBeNull();
    expect(v.ok).toBe(false);
  });
});
