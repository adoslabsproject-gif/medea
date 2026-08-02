/**
 * Test del nodo `action_pec_legal_archive` executor.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NodeExecutionContext } from '../../types.js';
import { pecLegalArchiveActionNode } from './index.js';
import { ValidationError } from '../../core/node-error.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pec-node-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ctx(): NodeExecutionContext {
  return {
    workflowId: 'wf',
    runId: 'r',
    nodeId: 'n',
    tenantId: 't',
    userId: 'u',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

describe('pecLegalArchiveExecutor', () => {
  it('archives an eml with default fields + writes manifest', async () => {
    const r = await pecLegalArchiveActionNode.executor(
      { archiveDir: dir },
      {
        raw: 'From: a\r\n\r\nhello',
        messageId: '<m1@x>',
        receivedAt: '2026-06-04T10:00:00Z',
        subject: 'X',
      },
      ctx(),
    );
    const o = r.output as Record<string, unknown>;
    const receipt = o.archiveReceipt as Record<string, unknown>;
    expect(receipt.archiveId).toBeTruthy();
    expect(receipt.hashAlgorithm).toBe('sha256');
    expect(receipt.byteLength).toBeGreaterThan(0);
    expect(o.subject).toBe('X'); // pass-through preserved
    // manifest exists
    const manifest = await fs.readFile(join(dir, 'manifest.jsonl'), 'utf8');
    expect(manifest.split('\n').filter(Boolean).length).toBe(1);
  });

  it('throws ValidationError when raw missing', async () => {
    await expect(
      pecLegalArchiveActionNode.executor(
        { archiveDir: dir },
        { messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
        ctx(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('honours custom field names', async () => {
    const r = await pecLegalArchiveActionNode.executor(
      { archiveDir: dir, rawField: 'eml', messageIdField: 'id', receivedAtField: 'ts' },
      { eml: 'X', id: '<m>', ts: '2026-06-04T10:00:00Z' },
      ctx(),
    );
    expect((r.output as Record<string, unknown>).archiveReceipt).toBeDefined();
  });

  it('persists pecType in the manifest when supplied', async () => {
    await pecLegalArchiveActionNode.executor(
      { archiveDir: dir },
      { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z', pecType: 'acceptance' },
      ctx(),
    );
    const manifest = await fs.readFile(join(dir, 'manifest.jsonl'), 'utf8');
    expect(manifest).toContain('"pecType":"acceptance"');
  });

  it('clamps conservationDays to ≥365 via schema', async () => {
    const r = await pecLegalArchiveActionNode
      .executor(
        { archiveDir: dir, conservationDays: 100 }, // schema min=365 → rejected
        { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
        ctx(),
      )
      .catch((e: unknown) => e);
    expect(r).toBeInstanceOf(ValidationError);
  });

  it('idempotent: same messageId+receivedAt yields same archiveId', async () => {
    const a = await pecLegalArchiveActionNode.executor(
      { archiveDir: dir },
      { raw: 'a', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      ctx(),
    );
    const b = await pecLegalArchiveActionNode.executor(
      { archiveDir: dir },
      { raw: 'b', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
      ctx(),
    );
    const ra = (a.output as Record<string, unknown>).archiveReceipt as Record<string, unknown>;
    const rb = (b.output as Record<string, unknown>).archiveReceipt as Record<string, unknown>;
    expect(rb.archiveId).toBe(ra.archiveId);
  });

  it('rejects bad archiveDir (relative path)', async () => {
    const r = await pecLegalArchiveActionNode
      .executor(
        { archiveDir: 'relative/path' },
        { raw: 'x', messageId: '<m>', receivedAt: '2026-06-04T10:00:00Z' },
        ctx(),
      )
      .catch((e: unknown) => e);
    expect(r).toBeInstanceOf(ValidationError);
  });
});
