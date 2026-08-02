/**
 * AIInteractionsService — integration tests against an in-memory SQLite DB.
 *
 * Strategy:
 *   • beforeEach: point MEDEA_DB_PATH at a fresh temp file (':memory:'
 *     doesn't quite work with WAL mode that the production handle uses),
 *     reset the cached config + closed any prior DB connection, then run
 *     migrations to create the schema from scratch.
 *   • afterEach: close DB, unlink temp file.
 *
 * What we test (the "would Federico approve this" suite):
 *   • Capture honors per-tenant opt-out (insert returns null when disabled)
 *   • Insert applies PII redaction to all string/json fields
 *   • Outcome update transitions pending → accepted
 *   • Review update sets quality + split
 *   • list() filters work
 *   • export.jsonl filters only accepted+reviewed rows
 *   • sweep() deletes rows past retention
 *   • stats() returns correct aggregations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIInteractionsService } from './ai-interactions.service.js';
import { closeDatabase, getDatabase } from '@/storage/db.js';
import { runMigrations } from '@/storage/migrate.js';
import { resetConfigForTests } from '@/config.js';

let tmpDir: string;
let originalDbPath: string | undefined;

beforeEach(async () => {
  // Each test gets a fresh sqlite file in a temp dir so they're fully isolated.
  tmpDir = mkdtempSync(join(tmpdir(), 'ff-aiint-'));
  originalDbPath = process.env.MEDEA_DB_PATH;
  process.env.MEDEA_DB_PATH = join(tmpDir, 'test.sqlite');
  process.env.MEDEA_DATA_DIR = tmpDir;
  resetConfigForTests();
  await closeDatabase();
  runMigrations();
  // Track B è opt-in (default OFF): i test di MECCANICA abilitano la cattura per
  // i tenant usati. I test del gate/default usano tenant freschi o sovrascrivono.
  const settingsSvc = new AIInteractionsService();
  settingsSvc.setCapturePreference('acme', true);
  settingsSvc.setCapturePreference('contoso', true);
});

afterEach(async () => {
  await closeDatabase();
  if (originalDbPath !== undefined) process.env.MEDEA_DB_PATH = originalDbPath;
  else delete process.env.MEDEA_DB_PATH;
  resetConfigForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseInsert(svc: AIInteractionsService, overrides: Partial<{ tenantId: string; type: string; prompt: string; response: string }> = {}): string | null {
  return svc.insert({
    context: { tenantId: overrides.tenantId ?? 'acme', userId: 'u1', workflowId: 'wf1' },
    interactionType: (overrides.type as 'editor_chat') ?? 'editor_chat',
    request: { prompt: overrides.prompt ?? 'aggiungi nodo Slack' },
    response: {
      message: overrides.response ?? 'Aggiunto un nodo community_slack',
      model: 'anthropic/claude-sonnet-4-5',
      latencyMs: 123,
    },
  });
}

describe('AIInteractionsService', () => {
  describe('capture opt-in', () => {
    it('🚨 default OFF: tenant fresco NON cattura (opt-in GDPR, niente row → null)', () => {
      const svc = new AIInteractionsService();
      expect(baseInsert(svc, { tenantId: 'fresh-never-enabled' })).toBeNull();
    });

    it('cattura dopo opt-in esplicito del tenant', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc); // 'acme' abilitato nel beforeEach
      expect(id).not.toBeNull();
      const row = svc.get(id!, 'acme');
      expect(row).not.toBeNull();
      expect(row!.interactionType).toBe('editor_chat');
    });

    it('returns null when tenant has opted out', () => {
      const svc = new AIInteractionsService();
      svc.setCapturePreference('acme', false);
      const id = baseInsert(svc);
      expect(id).toBeNull();
    });

    it('respects per-tenant settings independently', () => {
      const svc = new AIInteractionsService();
      svc.setCapturePreference('acme', false);
      svc.setCapturePreference('contoso', true);
      expect(baseInsert(svc, { tenantId: 'acme' })).toBeNull();
      expect(baseInsert(svc, { tenantId: 'contoso' })).not.toBeNull();
    });

    it('🚨 getCaptureSettings default per tenant sconosciuto: OFF (opt-in)', () => {
      const svc = new AIInteractionsService();
      const s = svc.getCaptureSettings('never-set');
      expect(s.captureEnabled).toBe(false);
      expect(s.retentionDays).toBe(90);
      expect(s.consentAt).toBeNull();
    });
  });

  describe('PII redaction at insert time', () => {
    it('redacts email and phone before storing in DB', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc, {
        prompt: 'Manda email a mario@example.com e chiama +39 333 1234567',
      });
      const row = svc.get(id!, 'acme');
      expect(row!.prompt).not.toContain('mario@example.com');
      expect(row!.prompt).toContain('<EMAIL>');
      expect(row!.prompt).toContain('<PHONE>');
      expect(row!.piiClasses).toEqual(expect.arrayContaining(['email', 'phone']));
    });

    it('marks pii_redacted=true even when no PII detected (defensive)', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc, { prompt: 'workflow normale senza dati sensibili' });
      const row = svc.get(id!, 'acme');
      expect(row!.piiRedacted).toBe(true);
      expect(row!.piiClasses).toEqual([]);
    });
  });

  describe('outcome update', () => {
    it('transitions pending → accepted', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc)!;
      const before = svc.get(id, 'acme')!;
      expect(before.outcome).toBe('pending');

      const updated = svc.updateOutcome({ interactionId: id, tenantId: 'acme', outcome: 'accepted' });
      expect(updated).toBe(true);

      const after = svc.get(id, 'acme')!;
      expect(after.outcome).toBe('accepted');
      expect(after.outcomeAt).not.toBeNull();
    });

    it('records edited patch when outcome=edited', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc)!;
      svc.updateOutcome({
        interactionId: id,
        tenantId: 'acme',
        outcome: 'edited',
        patchApplied: { updateNodes: [{ id: 'n1', patch: { config: { x: 'y' } } }] },
      });
      const after = svc.get(id, 'acme')!;
      expect(after.outcome).toBe('edited');
      expect(after.outcomePatchApplied).toBeDefined();
    });

    it('returns false for unknown interactionId', () => {
      const svc = new AIInteractionsService();
      const ok = svc.updateOutcome({ interactionId: 'nope', tenantId: 'acme', outcome: 'accepted' });
      expect(ok).toBe(false);
    });
  });

  describe('review update', () => {
    it('sets quality_score and training_split', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc)!;
      svc.updateReview({ interactionId: id, tenantId: 'acme', reviewerUserId: 'admin', qualityScore: 4, trainingSplit: 'train' });
      const row = svc.get(id, 'acme')!;
      expect(row.qualityScore).toBe(4);
      expect(row.trainingSplit).toBe('train');
      expect(row.reviewerUserId).toBe('admin');
    });

    it('rejects quality scores outside 0-5', () => {
      const svc = new AIInteractionsService();
      const id = baseInsert(svc)!;
      expect(() => svc.updateReview({ interactionId: id, tenantId: 'acme', reviewerUserId: 'admin', qualityScore: 6 })).toThrow();
      expect(() => svc.updateReview({ interactionId: id, tenantId: 'acme', reviewerUserId: 'admin', qualityScore: -1 })).toThrow();
    });
  });

  describe('list with filters', () => {
    it('filters by interaction type', () => {
      const svc = new AIInteractionsService();
      baseInsert(svc, { type: 'editor_chat' });
      baseInsert(svc, { type: 'run_explain' });
      baseInsert(svc, { type: 'editor_chat' });
      const r = svc.list({ tenantId: 'acme', interactionType: 'editor_chat' });
      expect(r.total).toBe(2);
    });

    it('filters by outcome', () => {
      const svc = new AIInteractionsService();
      const a = baseInsert(svc)!;
      baseInsert(svc); // stays pending
      svc.updateOutcome({ interactionId: a, tenantId: 'acme', outcome: 'accepted' });
      const r = svc.list({ tenantId: 'acme', outcome: 'accepted' });
      expect(r.total).toBe(1);
    });

    it('does not bleed across tenants', () => {
      const svc = new AIInteractionsService();
      baseInsert(svc, { tenantId: 'acme' });
      baseInsert(svc, { tenantId: 'contoso' });
      expect(svc.list({ tenantId: 'acme' }).total).toBe(1);
      expect(svc.list({ tenantId: 'contoso' }).total).toBe(1);
    });
  });

  describe('exportJsonl', () => {
    it('exports only rows with outcome accepted/edited AND quality >= 3 AND a split assigned', () => {
      const svc = new AIInteractionsService();
      const ids = [baseInsert(svc), baseInsert(svc), baseInsert(svc)].filter(Boolean) as string[];

      // First row: accepted + quality 4 + train → SHOULD export
      svc.updateOutcome({ interactionId: ids[0]!, tenantId: 'acme', outcome: 'accepted' });
      svc.updateReview({ interactionId: ids[0]!, tenantId: 'acme', reviewerUserId: 'r', qualityScore: 4, trainingSplit: 'train' });
      // Second row: accepted but quality 2 → should NOT export
      svc.updateOutcome({ interactionId: ids[1]!, tenantId: 'acme', outcome: 'accepted' });
      svc.updateReview({ interactionId: ids[1]!, tenantId: 'acme', reviewerUserId: 'r', qualityScore: 2, trainingSplit: 'train' });
      // Third row: rejected → should NOT export
      svc.updateOutcome({ interactionId: ids[2]!, tenantId: 'acme', outcome: 'rejected' });
      svc.updateReview({ interactionId: ids[2]!, tenantId: 'acme', reviewerUserId: 'r', qualityScore: 5, trainingSplit: 'train' });

      const jsonl = svc.exportJsonl({ tenantId: 'acme' });
      const lines = jsonl.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]!) as { messages: { role: string; content: string }[]; metadata: { id: string } };
      expect(parsed.messages.length).toBeGreaterThanOrEqual(2);
      expect(parsed.metadata.id).toBe(ids[0]);
    });

    it('returns empty string when no rows match', () => {
      const svc = new AIInteractionsService();
      const out = svc.exportJsonl({ tenantId: 'acme' });
      expect(out).toBe('');
    });
  });

  describe('sweep retention', () => {
    it('deletes only rows whose retention_until is in the past', () => {
      const svc = new AIInteractionsService();
      svc.setCapturePreference('acme', true, 90);
      const recent = baseInsert(svc)!;

      // Manually backdate one row's retention_until to simulate expiry
      // (the service doesn't expose a setter for retention_until on purpose).
      getDatabase().sqlite
        .prepare('UPDATE ai_interactions SET retention_until = ? WHERE id = ?')
        .run('1970-01-01T00:00:00.000Z', recent);

      const otherFresh = baseInsert(svc)!;
      expect(otherFresh).not.toBeNull();

      const swept = svc.sweep();
      expect(swept.deleted).toBe(1);
      expect(svc.get(recent, 'acme')).toBeNull();
      expect(svc.get(otherFresh, 'acme')).not.toBeNull();
    });
  });

  describe('stats', () => {
    it('aggregates totals, outcomes, types, splits, and PII counts correctly', () => {
      const svc = new AIInteractionsService();
      // 3 editor_chat, 1 run_explain. One has PII (email). All start pending.
      baseInsert(svc, { type: 'editor_chat' });
      baseInsert(svc, { type: 'editor_chat', prompt: 'manda a a@b.it' });
      baseInsert(svc, { type: 'editor_chat' });
      baseInsert(svc, { type: 'run_explain' });

      const stats = svc.stats('acme');
      expect(stats.total).toBe(4);
      expect(stats.byInteractionType.editor_chat).toBe(3);
      expect(stats.byInteractionType.run_explain).toBe(1);
      expect(stats.byOutcome.pending).toBe(4);
      expect(stats.piiDetections).toBe(1);
    });
  });
});
