/**
 * Test 2026-grade — AISignalsService (Track A, segnale non-personale always-on).
 *
 * Bug-bounty: idempotenza sull'id, fail-soft (DB rotto NON rompe la richiesta AI),
 * isolamento tenant su outcome/quality, aggregazioni stats. Harness SQLite
 * :memory' reale (la superficie dove vivono i dati), logger dal manual mock.
 *
 * @module services/ai-signals.service.test
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.sqlite }) }));
vi.mock('@/lib/logger.js');

import { AISignalsService } from './ai-signals.service.js';

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ai_signals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      interaction_type TEXT NOT NULL,
      node_def_id TEXT,
      response_model TEXT NOT NULL,
      response_latency_ms INTEGER NOT NULL,
      response_tokens_in INTEGER,
      response_tokens_out INTEGER,
      outcome TEXT NOT NULL DEFAULT 'pending',
      outcome_at TEXT,
      quality_score INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

let svc: AISignalsService;
beforeEach(() => {
  m.sqlite = new Database(':memory:');
  setupSchema(m.sqlite);
  svc = new AISignalsService();
});

const base = { tenantId: 't1', interactionType: 'node_generate' as const, model: 'liara/nha-v1', latencyMs: 123 };

describe('AISignalsService.record', () => {
  it('inserisce i campi strutturali + ritorna id (uuid generato)', () => {
    const id = svc.record({ ...base, nodeDefId: 'action_http', tokensIn: 10, tokensOut: 20 });
    expect(id.length).toBeGreaterThan(10);
    const row = m.sqlite!.prepare('SELECT * FROM ai_signals WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.tenant_id).toBe('t1');
    expect(row.interaction_type).toBe('node_generate');
    expect(row.node_def_id).toBe('action_http');
    expect(row.response_model).toBe('liara/nha-v1');
    expect(row.response_latency_ms).toBe(123);
    expect(row.response_tokens_in).toBe(10);
    expect(row.outcome).toBe('pending');
  });

  it('usa l\'id esplicito quando passato (condivisione con ai_interactions)', () => {
    const id = svc.record({ ...base, id: 'shared-id-42' });
    expect(id).toBe('shared-id-42');
    expect(m.sqlite!.prepare('SELECT COUNT(*) AS c FROM ai_signals WHERE id = ?').get('shared-id-42')).toEqual({ c: 1 });
  });

  it('🚨 idempotente sull\'id: secondo record stesso id → nessun duplicato, nessun throw', () => {
    svc.record({ ...base, id: 'dup' });
    expect(() => svc.record({ ...base, id: 'dup', model: 'altro' })).not.toThrow();
    const cnt = m.sqlite!.prepare('SELECT COUNT(*) AS c FROM ai_signals WHERE id = ?').get('dup') as { c: number };
    expect(cnt.c).toBe(1);
    // ON CONFLICT DO NOTHING: il primo vince (nessun overwrite).
    const row = m.sqlite!.prepare('SELECT response_model FROM ai_signals WHERE id = ?').get('dup') as { response_model: string };
    expect(row.response_model).toBe('liara/nha-v1');
  });

  it('🚨 FAIL-SOFT: DB rotto → ritorna comunque l\'id, NESSUN throw (non rompe la richiesta AI)', () => {
    m.sqlite!.close(); // simula DB non disponibile
    let id = '';
    expect(() => { id = svc.record({ ...base, id: 'x' }); }).not.toThrow();
    expect(id).toBe('x');
  });
});

describe('🚨 AISignalsService.updateOutcome / updateQuality — tenant scope', () => {
  it('updateOutcome aggiorna outcome + outcome_at', () => {
    const id = svc.record(base);
    expect(svc.updateOutcome(id, 't1', 'accepted')).toBe(true);
    const row = m.sqlite!.prepare('SELECT outcome, outcome_at FROM ai_signals WHERE id = ?').get(id) as { outcome: string; outcome_at: string };
    expect(row.outcome).toBe('accepted');
    expect(row.outcome_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('🚨 updateOutcome di un ALTRO tenant → no-op (no cross-tenant)', () => {
    const id = svc.record(base);
    expect(svc.updateOutcome(id, 't2', 'rejected')).toBe(false);
    const row = m.sqlite!.prepare('SELECT outcome FROM ai_signals WHERE id = ?').get(id) as { outcome: string };
    expect(row.outcome).toBe('pending');
  });

  it('updateQuality aggiorna quality_score, tenant-scoped', () => {
    const id = svc.record(base);
    expect(svc.updateQuality(id, 't1', 5)).toBe(true);
    expect(svc.updateQuality(id, 't2', 0)).toBe(false);
    const row = m.sqlite!.prepare('SELECT quality_score FROM ai_signals WHERE id = ?').get(id) as { quality_score: number };
    expect(row.quality_score).toBe(5);
  });

  it('FAIL-SOFT su update: DB rotto → false, nessun throw', () => {
    const id = svc.record(base);
    m.sqlite!.close();
    expect(() => { expect(svc.updateOutcome(id, 't1', 'accepted')).toBe(false); }).not.toThrow();
  });
});

describe('AISignalsService.stats', () => {
  it('🚨 aggrega total/byOutcome/byInteractionType per-tenant (no bleed cross-tenant)', () => {
    const a = svc.record({ ...base, interactionType: 'editor_chat' });
    svc.record({ ...base, interactionType: 'run_explain' });
    svc.record({ tenantId: 't2', interactionType: 'node_generate', model: 'x', latencyMs: 1 });
    svc.updateOutcome(a, 't1', 'accepted');

    const s = svc.stats('t1');
    expect(s.total).toBe(2); // SOLO t1
    expect(s.byOutcome.accepted).toBe(1);
    expect(s.byOutcome.pending).toBe(1);
    expect(s.byInteractionType.editor_chat).toBe(1);
    expect(s.byInteractionType.run_explain).toBe(1);
  });
});
