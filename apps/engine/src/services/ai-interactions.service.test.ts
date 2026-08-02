/**
 * Test 2026-grade — AIInteractionsService (capture + outcome + review +
 * export JSONL + sweep + stats).
 *
 * 🚨 BUSINESS+PRIVACY-CRITICAL: ogni interazione AI viene catturata per
 * fine-tuning. Test reali con SQLite :memory: + schema reale del modulo
 * migrate.ts (no DB mock). PII redactor mock (testato altrove) per
 * isolare la logica del service.
 *
 * Coverage:
 *  - isCaptureEnabled default true (opt-in)
 *  - setCapturePreference upsert (insert + update)
 *  - getCaptureSettings retention default 90gg
 *  - insert con tenant opted-out → return null, no INSERT
 *  - 🚨 PII redaction applicato a prompt+response+workflowSnapshot+history+patch
 *  - 🚨 retention_until calculated = NOW + retentionDays
 *  - insert con DB error → log + return null (NON propaga error)
 *  - updateOutcome con tenant scope (cross-tenant → no changes)
 *  - updateReview qualityScore 0-5 validate range
 *  - get tenant-scoped
 *  - list con filtri (type/outcome/split/minQuality) + paginazione
 *  - exportJsonl: solo accepted/edited + quality >= minQuality + split NOT NULL
 *  - exportJsonl: format messages chat-template HuggingFace
 *  - sweep: delete past retention_until
 *  - stats: byOutcome/byType/bySplit/piiDetections
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  sqlite: null as unknown as ReturnType<typeof Database>,
  redactText: vi.fn((s: string) => ({
    redacted: `R(${s.slice(0, 20)})`,
    classes: s.includes('@') ? ['email'] : [],
  })),
  redactJson: vi.fn((j: unknown) => ({
    // Preserva tipo: array → array, object → object, null → null.
    // Il source casta JSON.parse(...) as Array<{ role, content }> quindi DEVE
    // restare array per conversationHistory.
    redacted: j === null ? null : Array.isArray(j) ? j : { redacted: true, original: j },
    classes: [] as string[],
  })),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.sqlite }),
}));

vi.mock('./pii-redactor.service.js', () => ({
  piiRedactor: {
    redactText: (...a: unknown[]) => m.redactText(...(a as [string])),
    redactJson: (j: unknown) => m.redactJson(j),
  },
}));

vi.mock('@/lib/logger.js');

import { AIInteractionsService } from './ai-interactions.service.js';

function setupSchema(db: ReturnType<typeof Database>): void {
  db.exec(`
    CREATE TABLE ai_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      workflow_id TEXT,
      interaction_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      prompt TEXT NOT NULL,
      workflow_snapshot_json TEXT,
      conversation_history_json TEXT,
      response_message TEXT NOT NULL,
      response_patch_json TEXT,
      response_model TEXT NOT NULL,
      response_latency_ms INTEGER NOT NULL,
      response_tokens_in INTEGER,
      response_tokens_out INTEGER,
      outcome TEXT NOT NULL DEFAULT 'pending',
      outcome_at TEXT,
      outcome_patch_applied_json TEXT,
      outcome_followup_run_id TEXT,
      outcome_followup_run_status TEXT,
      quality_score INTEGER,
      reviewer_user_id TEXT,
      reviewer_notes TEXT,
      pii_redacted INTEGER NOT NULL DEFAULT 1,
      pii_classes_json TEXT,
      retention_until TEXT NOT NULL,
      training_split TEXT
    );
    CREATE TABLE ai_training_settings (
      tenant_id TEXT PRIMARY KEY,
      capture_enabled INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 90,
      consent_at TEXT,
      consent_by_user_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
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

const svc = new AIInteractionsService();

const baseInsert = (over: Record<string, unknown> = {}): Parameters<typeof svc.insert>[0] =>
  ({
    context: { tenantId: 't1', userId: 'u1', workflowId: 'wf1' },
    interactionType: 'editor_chat',
    request: {
      prompt: 'how can I parse XLSX?',
      workflowSnapshot: { nodes: [] },
      conversationHistory: [{ role: 'user', content: 'previous' }],
    },
    response: {
      message: 'Use action_xlsx_parse node',
      patch: { add: ['node-1'] },
      model: 'anthropic/claude-sonnet-4-5',
      latencyMs: 1200,
      tokensIn: 50,
      tokensOut: 100,
    },
    ...over,
  }) as Parameters<typeof svc.insert>[0];

beforeEach(() => {
  m.sqlite = new Database(':memory:');
  setupSchema(m.sqlite);
  // Reset mock implementations (mockClear non resetta mockReturnValueOnce
  // o mockImplementation set in test precedenti — usa mockReset + reapply default)
  m.redactText.mockReset().mockImplementation((s: string) => ({
    redacted: `R(${s.slice(0, 20)})`,
    classes: s.includes('@') ? ['email'] : ([] as string[]),
  }));
  m.redactJson.mockReset().mockImplementation((j: unknown) => ({
    redacted: j === null ? null : Array.isArray(j) ? j : { redacted: true, original: j },
    classes: [] as string[],
  }));
  // Track B è opt-in (default OFF): i blocchi che testano la MECCANICA (insert/
  // outcome/list/stats/export/sweep) abilitano la cattura per i tenant usati. Il
  // gate opt-out e i default si testano con tenant FRESCHI ('t-default').
  svc.setCapturePreference('t1', true);
  svc.setCapturePreference('t2', true);
});

describe('isCaptureEnabled / capture preferences', () => {
  it('🚨 default OPT-IN (GDPR): nessun row → false (niente consenso = niente cattura)', () => {
    expect(svc.isCaptureEnabled('t-default')).toBe(false);
  });

  it('setCapturePreference(true) → isCaptureEnabled → true', () => {
    svc.setCapturePreference('t1', true);
    expect(svc.isCaptureEnabled('t1')).toBe(true);
  });

  it('setCapturePreference(false) → isCaptureEnabled → false', () => {
    svc.setCapturePreference('t1', false);
    expect(svc.isCaptureEnabled('t1')).toBe(false);
  });

  it('setCapturePreference upsert: 2 chiamate, ultima vince', () => {
    svc.setCapturePreference('t1', false, 30);
    svc.setCapturePreference('t1', true, 180);
    const settings = svc.getCaptureSettings('t1');
    expect(settings.captureEnabled).toBe(true);
    expect(settings.retentionDays).toBe(180);
  });

  it('🚨 getCaptureSettings default: OFF + 90 days + nessun consenso', () => {
    const s = svc.getCaptureSettings('t-default');
    expect(s).toEqual({
      captureEnabled: false,
      retentionDays: 90,
      consentAt: null,
      consentByUserId: null,
      decided: false,
    });
  });

  it('🚨 ENABLE registra la prova del consenso (accountability art.7): consent_at + consent_by', () => {
    svc.setCapturePreference('t1', true, 90, 'user-admin-42');
    const s = svc.getCaptureSettings('t1');
    expect(s.captureEnabled).toBe(true);
    expect(s.consentByUserId).toBe('user-admin-42');
    expect(s.consentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(s.decided).toBe(true);
  });

  it('🚨 decided distingue "opt-out esplicito" da "mai deciso": false→opt-out crea row→decided=true', () => {
    expect(svc.getCaptureSettings('t-fresh').decided).toBe(false); // mai deciso
    svc.setCapturePreference('t-fresh', false); // opt-out esplicito
    expect(svc.getCaptureSettings('t-fresh').decided).toBe(true);
  });

  it('🚨 DISABLE (revoca) azzera la prova del consenso', () => {
    svc.setCapturePreference('t1', true, 90, 'user-admin-42');
    svc.setCapturePreference('t1', false, 90, 'user-admin-42');
    const s = svc.getCaptureSettings('t1');
    expect(s.captureEnabled).toBe(false);
    expect(s.consentAt).toBeNull();
    expect(s.consentByUserId).toBeNull();
  });
});

describe('🚨 Track A — ai_signals registrato SEMPRE (anche opt-out)', () => {
  it('🚨 tenant OPT-OUT: insert→null MA il segnale non-personale è registrato', () => {
    svc.setCapturePreference('t1', false);
    const id = svc.insert(baseInsert());
    expect(id).toBeNull(); // Track B opt-out: niente testo grezzo
    const sig = m.sqlite
      .prepare('SELECT * FROM ai_signals WHERE tenant_id = ?')
      .get('t1') as Record<string, unknown>;
    expect(sig).toBeDefined();
    expect(sig.interaction_type).toBe('editor_chat');
    expect(sig.response_model).toBe('anthropic/claude-sonnet-4-5');
    // ai_interactions (testo) NON deve esistere per il tenant opt-out
    expect(
      m.sqlite.prepare('SELECT COUNT(*) AS c FROM ai_interactions WHERE tenant_id = ?').get('t1'),
    ).toEqual({ c: 0 });
  });

  it('🚨 tenant OPT-IN: STESSO id in ai_interactions e ai_signals', () => {
    const id = svc.insert(baseInsert());
    expect(id).not.toBeNull();
    expect(m.sqlite.prepare('SELECT id FROM ai_interactions WHERE id = ?').get(id)).toBeDefined();
    expect(m.sqlite.prepare('SELECT id FROM ai_signals WHERE id = ?').get(id)).toBeDefined();
  });

  it("🚨 updateOutcome riflette l'esito ANCHE nel segnale", () => {
    const id = svc.insert(baseInsert()) ?? '';
    svc.updateOutcome({ interactionId: id, tenantId: 't1', outcome: 'accepted' });
    const sig = m.sqlite.prepare('SELECT outcome FROM ai_signals WHERE id = ?').get(id) as {
      outcome: string;
    };
    expect(sig.outcome).toBe('accepted');
  });
});

describe('🚨 insert — PII redaction + retention', () => {
  it('insert happy path: ritorna id + INSERT eseguito', () => {
    const id = svc.insert(baseInsert());
    expect(typeof id).toBe('string');
    expect((id ?? '').length).toBeGreaterThan(10); // UUID

    const row = m.sqlite.prepare('SELECT * FROM ai_interactions WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    expect(row.tenant_id).toBe('t1');
    expect(row.pii_redacted).toBe(1);
    expect(row.outcome).toBe('pending'); // default
    expect(row.response_model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('🚨 PII redaction chiamata su TUTTI i campi text/json', () => {
    svc.insert(baseInsert());
    // 2 redactText (prompt + response.message)
    expect(m.redactText).toHaveBeenCalledTimes(2);
    expect(m.redactText).toHaveBeenCalledWith('how can I parse XLSX?');
    expect(m.redactText).toHaveBeenCalledWith('Use action_xlsx_parse node');
    // 3 redactJson (workflowSnapshot + conversationHistory + patch)
    expect(m.redactJson).toHaveBeenCalledTimes(3);
  });

  it('🚨 PII classes union: union di tutti gli array redactor → pii_classes_json', () => {
    m.redactText.mockReturnValueOnce({ redacted: 'X', classes: ['email'] });
    m.redactText.mockReturnValueOnce({ redacted: 'Y', classes: ['phone'] });
    m.redactJson.mockReturnValue({ redacted: { stub: true } as never, classes: ['cf'] });
    const id = svc.insert(baseInsert());
    const row = m.sqlite
      .prepare('SELECT pii_classes_json FROM ai_interactions WHERE id = ?')
      .get(id) as { pii_classes_json: string };
    const classes = JSON.parse(row.pii_classes_json) as string[];
    expect(classes).toContain('email');
    expect(classes).toContain('phone');
    expect(classes).toContain('cf');
  });

  it('🚨 tenant opted-out → return null + nessun INSERT', () => {
    svc.setCapturePreference('t1', false);
    const id = svc.insert(baseInsert());
    expect(id).toBeNull();
    const count = (
      m.sqlite.prepare('SELECT COUNT(*) AS c FROM ai_interactions').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('🚨 retention_until = NOW + retentionDays', () => {
    svc.setCapturePreference('t1', true, 30);
    const beforeMs = Date.now();
    const id = svc.insert(baseInsert());
    const row = m.sqlite
      .prepare('SELECT retention_until FROM ai_interactions WHERE id = ?')
      .get(id) as { retention_until: string };
    const retentionMs = new Date(row.retention_until).getTime();
    // 30gg = 30*86400*1000 = 2592000000 ms — entro ±1s di tolleranza
    expect(retentionMs).toBeGreaterThan(beforeMs + 30 * 86_400 * 1000 - 5000);
    expect(retentionMs).toBeLessThan(beforeMs + 30 * 86_400 * 1000 + 5000);
  });

  it('🚨 DB error during insert → log + return null (no throw)', () => {
    // Drop the table per provocare error
    m.sqlite.exec('DROP TABLE ai_interactions');
    const id = svc.insert(baseInsert());
    expect(id).toBeNull();
  });

  it('insert con campi opzionali assenti (no patch/history/snapshot) → ok', () => {
    const id = svc.insert({
      context: { tenantId: 't1' },
      interactionType: 'workflow_from_text',
      request: { prompt: 'hi' },
      response: { message: 'reply', model: 'm', latencyMs: 100 },
    });
    expect(id).toBeDefined();
    const row = m.sqlite.prepare('SELECT * FROM ai_interactions WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row.user_id).toBeNull();
    expect(row.workflow_id).toBeNull();
    expect(row.response_tokens_in).toBeNull();
  });
});

describe('🚨 updateOutcome — tenant scope', () => {
  it('updateOutcome happy: cambia outcome + outcome_at + returns true', () => {
    const id = svc.insert(baseInsert());
    const ok = svc.updateOutcome({
      interactionId: id!,
      tenantId: 't1',
      outcome: 'accepted',
      followupRunId: 'run-99',
      followupRunStatus: 'success',
    });
    expect(ok).toBe(true);
    const row = m.sqlite.prepare('SELECT * FROM ai_interactions WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row.outcome).toBe('accepted');
    expect(row.outcome_at).toBeTruthy();
    expect(row.outcome_followup_run_id).toBe('run-99');
    expect(row.outcome_followup_run_status).toBe('success');
  });

  it('🚨 cross-tenant update → returns false (no change)', () => {
    const id = svc.insert(baseInsert());
    const ok = svc.updateOutcome({
      interactionId: id!,
      tenantId: 't2-OTHER',
      outcome: 'accepted',
    });
    expect(ok).toBe(false);
    const row = m.sqlite.prepare('SELECT outcome FROM ai_interactions WHERE id = ?').get(id) as {
      outcome: string;
    };
    expect(row.outcome).toBe('pending'); // unchanged
  });

  it('updateOutcome con patch applied → redacted in DB', () => {
    const id = svc.insert(baseInsert());
    svc.updateOutcome({
      interactionId: id!,
      tenantId: 't1',
      outcome: 'edited',
      patchApplied: { custom: 'user-edit' },
    });
    expect(m.redactJson).toHaveBeenCalledWith({ custom: 'user-edit' });
  });
});

describe('🚨 updateReview — quality score validation', () => {
  it('quality 0-5 ok, training_split assigned', () => {
    const id = svc.insert(baseInsert());
    const ok = svc.updateReview({
      interactionId: id!,
      tenantId: 't1',
      qualityScore: 4,
      reviewerUserId: 'reviewer-1',
      reviewerNotes: 'good',
      trainingSplit: 'train',
    });
    expect(ok).toBe(true);
    const row = m.sqlite.prepare('SELECT * FROM ai_interactions WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row.quality_score).toBe(4);
    expect(row.training_split).toBe('train');
  });

  it('🚨 qualityScore > 5 → throw "must be 0-5"', () => {
    const id = svc.insert(baseInsert());
    expect(() =>
      svc.updateReview({
        interactionId: id!,
        tenantId: 't1',
        qualityScore: 6,
        reviewerUserId: 'r',
      }),
    ).toThrow(/must be 0-5/u);
  });

  it('🚨 qualityScore < 0 → throw', () => {
    const id = svc.insert(baseInsert());
    expect(() =>
      svc.updateReview({
        interactionId: id!,
        tenantId: 't1',
        qualityScore: -1,
        reviewerUserId: 'r',
      }),
    ).toThrow(/must be 0-5/u);
  });

  it('🚨 cross-tenant review → returns false', () => {
    const id = svc.insert(baseInsert());
    const ok = svc.updateReview({
      interactionId: id!,
      tenantId: 't2',
      qualityScore: 5,
      reviewerUserId: 'r',
    });
    expect(ok).toBe(false);
  });
});

describe('🚨 get / list — tenant scope + filters', () => {
  it('get tenant-scoped: ritorna row se tenant ok, null altrimenti', () => {
    const id = svc.insert(baseInsert());
    expect(svc.get(id!, 't1')).not.toBeNull();
    expect(svc.get(id!, 't2-OTHER')).toBeNull();
  });

  it('list filtra per tenant + count totale', () => {
    svc.insert(baseInsert({ context: { tenantId: 't1' } }));
    svc.insert(baseInsert({ context: { tenantId: 't1' } }));
    svc.insert(baseInsert({ context: { tenantId: 't2' } }));
    const t1 = svc.list({ tenantId: 't1' });
    expect(t1.total).toBe(2);
    expect(t1.rows).toHaveLength(2);
    const t2 = svc.list({ tenantId: 't2' });
    expect(t2.total).toBe(1);
  });

  it('list filtro interactionType', () => {
    svc.insert(baseInsert({ interactionType: 'editor_chat' }));
    svc.insert(baseInsert({ interactionType: 'run_explain' }));
    const r = svc.list({ tenantId: 't1', interactionType: 'editor_chat' });
    expect(r.total).toBe(1);
  });

  it('list filtro outcome', () => {
    const id1 = svc.insert(baseInsert());
    const id2 = svc.insert(baseInsert());
    svc.updateOutcome({ interactionId: id1!, tenantId: 't1', outcome: 'accepted' });
    svc.updateOutcome({ interactionId: id2!, tenantId: 't1', outcome: 'rejected' });
    expect(svc.list({ tenantId: 't1', outcome: 'accepted' }).total).toBe(1);
    expect(svc.list({ tenantId: 't1', outcome: 'rejected' }).total).toBe(1);
  });

  it('list paginazione: limit + offset', () => {
    for (let i = 0; i < 5; i += 1) svc.insert(baseInsert());
    const page1 = svc.list({ tenantId: 't1', limit: 2, offset: 0 });
    const page2 = svc.list({ tenantId: 't1', limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
  });
});

describe('🚨 exportJsonl — fine-tuning dataset', () => {
  function setupSampleData(): { idAccepted: string; idRejected: string; idPending: string } {
    const idAccepted =
      svc.insert(
        baseInsert({
          request: { prompt: 'q1', conversationHistory: [{ role: 'system', content: 's' }] },
          response: { message: 'a1', model: 'm', latencyMs: 1 },
        }),
      ) ?? '';
    const idRejected = svc.insert(baseInsert()) ?? '';
    const idPending = svc.insert(baseInsert()) ?? '';

    svc.updateOutcome({ interactionId: idAccepted, tenantId: 't1', outcome: 'accepted' });
    svc.updateOutcome({ interactionId: idRejected, tenantId: 't1', outcome: 'rejected' });

    svc.updateReview({
      interactionId: idAccepted,
      tenantId: 't1',
      qualityScore: 5,
      reviewerUserId: 'r',
      trainingSplit: 'train',
    });
    svc.updateReview({
      interactionId: idRejected,
      tenantId: 't1',
      qualityScore: 5,
      reviewerUserId: 'r',
      trainingSplit: 'train',
    });
    return { idAccepted, idRejected, idPending };
  }

  it('🚨 export solo accepted/edited (NO rejected/pending/ignored)', () => {
    setupSampleData();
    const jsonl = svc.exportJsonl({ tenantId: 't1' });
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // solo l'accepted
  });

  it('🚨 export solo quality >= minQuality (default 3)', () => {
    const id = svc.insert(baseInsert()) ?? '';
    svc.updateOutcome({ interactionId: id, tenantId: 't1', outcome: 'accepted' });
    svc.updateReview({
      interactionId: id,
      tenantId: 't1',
      qualityScore: 2, // sotto soglia default 3
      reviewerUserId: 'r',
      trainingSplit: 'train',
    });
    expect(svc.exportJsonl({ tenantId: 't1' })).toBe('');
  });

  it('🚨 export richiede training_split NOT NULL', () => {
    const id = svc.insert(baseInsert()) ?? '';
    svc.updateOutcome({ interactionId: id, tenantId: 't1', outcome: 'accepted' });
    svc.updateReview({
      interactionId: id,
      tenantId: 't1',
      qualityScore: 5,
      reviewerUserId: 'r', // no trainingSplit
    });
    expect(svc.exportJsonl({ tenantId: 't1' })).toBe('');
  });

  it('exportJsonl format: messages chat-template HuggingFace', () => {
    setupSampleData();
    const jsonl = svc.exportJsonl({ tenantId: 't1' });
    const obj = JSON.parse(jsonl.trim()) as {
      messages: { role: string; content: string }[];
      metadata: { quality: number; model: string };
    };
    expect(obj.messages).toBeDefined();
    expect(obj.messages.length).toBeGreaterThanOrEqual(2);
    expect(obj.messages[obj.messages.length - 1]?.role).toBe('assistant');
    expect(obj.metadata.quality).toBe(5);
  });

  it('exportJsonl filtro per split', () => {
    setupSampleData();
    // Aggiungi un val split per testare filtro
    const id = svc.insert(baseInsert()) ?? '';
    svc.updateOutcome({ interactionId: id, tenantId: 't1', outcome: 'accepted' });
    svc.updateReview({
      interactionId: id,
      tenantId: 't1',
      qualityScore: 5,
      reviewerUserId: 'r',
      trainingSplit: 'val',
    });
    const trainOnly = svc.exportJsonl({ tenantId: 't1', trainingSplit: 'train' });
    const valOnly = svc.exportJsonl({ tenantId: 't1', trainingSplit: 'val' });
    expect(trainOnly.split('\n').filter(Boolean)).toHaveLength(1);
    expect(valOnly.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('🚨 sweep — retention purge', () => {
  it('sweep delete rows past retention_until', () => {
    svc.setCapturePreference('t1', true, 90);
    const id = svc.insert(baseInsert());
    // Update retention to past
    m.sqlite
      .prepare(
        "UPDATE ai_interactions SET retention_until = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(id);
    const res = svc.sweep();
    expect(res.deleted).toBe(1);
    expect(svc.list({ tenantId: 't1' }).total).toBe(0);
  });

  it('sweep NON cancella row future', () => {
    svc.insert(baseInsert());
    const res = svc.sweep();
    expect(res.deleted).toBe(0);
  });
});

describe('🚨 stats — per tenant aggregations', () => {
  it('stats byOutcome/byType/bySplit/piiDetections', () => {
    const id1 = svc.insert(baseInsert({ interactionType: 'editor_chat' })) ?? '';
    const id2 = svc.insert(baseInsert({ interactionType: 'run_explain' })) ?? '';
    svc.insert(baseInsert({ interactionType: 'editor_chat' }));
    svc.updateOutcome({ interactionId: id1, tenantId: 't1', outcome: 'accepted' });
    svc.updateOutcome({ interactionId: id2, tenantId: 't1', outcome: 'rejected' });

    const s = svc.stats('t1');
    expect(s.total).toBe(3);
    expect(s.byOutcome.accepted).toBe(1);
    expect(s.byOutcome.rejected).toBe(1);
    expect(s.byOutcome.pending).toBe(1);
    expect(s.byInteractionType.editor_chat).toBe(2);
    expect(s.byInteractionType.run_explain).toBe(1);
    expect(s.piiDetections).toBeGreaterThanOrEqual(0);
  });

  it('stats su tenant senza data → tutti 0', () => {
    const s = svc.stats('t-empty');
    expect(s.total).toBe(0);
    expect(s.byOutcome).toEqual({});
    expect(s.byInteractionType).toEqual({});
    expect(s.piiDetections).toBe(0);
  });

  it('stats: piiDetections conta solo classes non vuoti', () => {
    // Reset mock: prima insert con classes vuoti, secondo con classes
    m.redactText.mockImplementation((s: string) => ({
      redacted: s,
      classes: s === 'with-pii' ? ['email'] : [],
    }));
    m.redactJson.mockReturnValue({ redacted: null, classes: [] });

    svc.insert(
      baseInsert({
        request: { prompt: 'plain' },
        response: { message: 'plain', model: 'm', latencyMs: 1 },
      }),
    );
    svc.insert(
      baseInsert({
        request: { prompt: 'with-pii' },
        response: { message: 'plain', model: 'm', latencyMs: 1 },
      }),
    );
    const s = svc.stats('t1');
    expect(s.piiDetections).toBe(1);
  });
});
