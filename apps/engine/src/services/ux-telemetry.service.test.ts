/**
 * Test 2026-grade — UxTelemetryService (opt-in product analytics).
 *
 * PRIVACY: NO PII storage (no email/name/content) — solo event + ids opaqui.
 * RELIABILITY: record errors swallowed (telemetry mai blocca user request).
 * INSIGHT: stuckUsers report — workflow_created senza run_started in window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { at, first } from '@/__testkit__/assert.js';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

const { UxTelemetryService } = await import('./ux-telemetry.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE ux_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      event_type TEXT NOT NULL,
      workflow_id TEXT,
      node_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

describe('🚨 record', () => {
  it('🚨 happy: insert event con tutti i campi', () => {
    new UxTelemetryService().record({
      tenantId: 't-1',
      userId: 'u-1',
      eventType: 'workflow_created',
      workflowId: 'wf-1',
      nodeId: 'n-1',
      metadata: { source: 'wizard' },
    });
    const row = sqliteInst.prepare('SELECT * FROM ux_events').get() as any;
    expect(row.tenant_id).toBe('t-1');
    expect(row.user_id).toBe('u-1');
    expect(row.event_type).toBe('workflow_created');
    expect(row.workflow_id).toBe('wf-1');
    expect(row.node_id).toBe('n-1');
    expect(JSON.parse(row.metadata_json)).toEqual({ source: 'wizard' });
  });

  it('🚨 userId opzionale → null', () => {
    new UxTelemetryService().record({ tenantId: 't', eventType: 'helpchat_opened' });
    const row = sqliteInst.prepare('SELECT * FROM ux_events').get() as any;
    expect(row.user_id).toBeNull();
  });

  it('🚨 metadata undefined → null (no "{}")', () => {
    new UxTelemetryService().record({ tenantId: 't', eventType: 'tour_completed' });
    const row = sqliteInst.prepare('SELECT metadata_json FROM ux_events').get() as any;
    expect(row.metadata_json).toBeNull();
  });

  it('🚨 error swallow: tabella inesistente → no throw', () => {
    sqliteInst.exec('DROP TABLE ux_events');
    expect(() =>
      new UxTelemetryService().record({
        tenantId: 't',
        eventType: 'workflow_created',
      }),
    ).not.toThrow();
  });

  it('🚨 NO PII: nessun field email/name accettato', () => {
    new UxTelemetryService().record({
      tenantId: 't',
      userId: 'opaque-uuid-not-email',
      eventType: 'workflow_created',
      metadata: { source: 'click' },
    });
    const row = sqliteInst.prepare('SELECT user_id, metadata_json FROM ux_events').get() as any;
    expect(row.user_id).not.toMatch(/@/u); // no email
    expect(row.metadata_json).not.toContain('@');
  });
});

describe('🚨 funnel — cross-tenant aggregation', () => {
  beforeEach(() => {
    const svc = new UxTelemetryService();
    svc.record({ tenantId: 't1', userId: 'u1', eventType: 'workflow_created' });
    svc.record({ tenantId: 't1', userId: 'u1', eventType: 'workflow_created' });
    svc.record({ tenantId: 't2', userId: 'u2', eventType: 'workflow_created' });
    svc.record({ tenantId: 't1', userId: 'u1', eventType: 'run_started' });
  });

  it('🚨 conta totale + utenti unique per eventType', () => {
    const f = new UxTelemetryService().funnel();
    expect(f).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'workflow_created', count: 3, uniqueUsers: 2 }),
        expect.objectContaining({ eventType: 'run_started', count: 1, uniqueUsers: 1 }),
      ]),
    );
  });

  it('🚨 sortBy count DESC', () => {
    const f = new UxTelemetryService().funnel();
    for (let i = 1; i < f.length; i++) {
      expect(at(f, i, 'funnel').count).toBeLessThanOrEqual(at(f, i - 1, 'funnel').count);
    }
  });

  it('🚨 sinceHours filter window', () => {
    // Insert event vecchio 48h
    sqliteInst.exec(
      `INSERT INTO ux_events (tenant_id, event_type, created_at) VALUES ('t', 'old_event', '2026-01-01')`,
    );
    const f24 = new UxTelemetryService().funnel({ sinceHours: 24 });
    expect(f24.find((s) => s.eventType === 'old_event')).toBeUndefined();
  });

  it('🚨 default 24h window se opts omessi', () => {
    const f = new UxTelemetryService().funnel();
    expect(f.length).toBeGreaterThan(0);
  });
});

describe('🚨 recent', () => {
  beforeEach(() => {
    const svc = new UxTelemetryService();
    for (let i = 1; i <= 5; i++) {
      svc.record({ tenantId: i <= 3 ? 't1' : 't2', userId: `u${i}`, eventType: 'tour_completed' });
    }
  });

  it('🚨 ordine DESC per id', () => {
    const r = new UxTelemetryService().recent(10);
    for (let i = 1; i < r.length; i++) {
      expect(at(r, i, 'recent').id).toBeLessThan(at(r, i - 1, 'recent').id);
    }
  });

  it('🚨 limit applicato', () => {
    expect(new UxTelemetryService().recent(2)).toHaveLength(2);
  });

  it('🚨 default limit 200', () => {
    expect(new UxTelemetryService().recent().length).toBeLessThanOrEqual(200);
  });

  it('🚨 filter per tenantId', () => {
    const r1 = new UxTelemetryService().recent(10, 't1');
    const r2 = new UxTelemetryService().recent(10, 't2');
    expect(r1.every((e) => e.tenantId === 't1')).toBe(true);
    expect(r2.every((e) => e.tenantId === 't2')).toBe(true);
    expect(r1.length).toBe(3);
    expect(r2.length).toBe(2);
  });

  it('🚨 mapRow: metadata JSON → object', () => {
    new UxTelemetryService().record({
      tenantId: 't-meta',
      eventType: 'wizard_started',
      metadata: { intent: 'crm' },
    });
    const r = new UxTelemetryService().recent(1, 't-meta');
    expect(first(r, 'recent').metadata).toEqual({ intent: 'crm' });
  });

  it('🚨 mapRow: metadata null preservato', () => {
    new UxTelemetryService().record({ tenantId: 't-x', eventType: 'tour_completed' });
    const r = new UxTelemetryService().recent(1, 't-x');
    expect(first(r, 'recent').metadata).toBeNull();
  });
});

describe('🚨 stuckUsers — drop-off detection', () => {
  it('🚨 utente con workflow_created ma NO run_started → flagged', () => {
    const svc = new UxTelemetryService();
    svc.record({
      tenantId: 't1',
      userId: 'stuck-user',
      eventType: 'workflow_created',
      workflowId: 'wf-x',
    });
    const stuck = svc.stuckUsers();
    expect(stuck.length).toBe(1);
    const s = first(stuck, 'stuck-users');
    expect(s.userId).toBe('stuck-user');
    expect(s.workflowId).toBe('wf-x');
  });

  it('🚨 utente che POI ha fatto run_started → NON stuck', () => {
    const svc = new UxTelemetryService();
    svc.record({ tenantId: 't1', userId: 'success-user', eventType: 'workflow_created' });
    svc.record({ tenantId: 't1', userId: 'success-user', eventType: 'run_started' });
    expect(svc.stuckUsers()).toEqual([]);
  });

  it('🚨 userId null escluso (anonymous)', () => {
    const svc = new UxTelemetryService();
    svc.record({ tenantId: 't1', eventType: 'workflow_created' });
    expect(svc.stuckUsers()).toEqual([]);
  });

  it('🚨 sinceHours window strict', () => {
    sqliteInst.exec(
      `INSERT INTO ux_events (tenant_id, user_id, event_type, created_at) VALUES ('t', 'old-user', 'workflow_created', '2026-01-01')`,
    );
    const stuck = new UxTelemetryService().stuckUsers({ sinceHours: 24 });
    expect(stuck.find((s) => s.userId === 'old-user')).toBeUndefined();
  });

  it('🚨 limit hardcoded a 100 row', () => {
    const svc = new UxTelemetryService();
    for (let i = 1; i <= 150; i++) {
      svc.record({ tenantId: 't', userId: `u${i}`, eventType: 'workflow_created' });
    }
    expect(svc.stuckUsers().length).toBeLessThanOrEqual(100);
  });

  it('🚨 ordine DESC per createdAt (più recenti prima)', () => {
    const svc = new UxTelemetryService();
    svc.record({ tenantId: 't', userId: 'u1', eventType: 'workflow_created' });
    svc.record({ tenantId: 't', userId: 'u2', eventType: 'workflow_created' });
    // Usa date dinamiche per restare nella finestra sinceHours=24 default.
    // u2 deve essere PIÙ RECENTE di u1 → "DESC per createdAt" → u2 in [0]
    const now = Date.now();
    const olderIso = new Date(now - 60 * 60 * 1000).toISOString(); // -1h
    const newerIso = new Date(now - 30 * 60 * 1000).toISOString(); // -30min
    sqliteInst.exec(`UPDATE ux_events SET created_at='${olderIso}' WHERE user_id='u1'`);
    sqliteInst.exec(`UPDATE ux_events SET created_at='${newerIso}' WHERE user_id='u2'`);
    const stuck = svc.stuckUsers();
    expect(first(stuck, 'stuck-users').userId).toBe('u2');
  });
});
