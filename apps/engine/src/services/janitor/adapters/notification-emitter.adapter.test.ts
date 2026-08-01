/**
 * Test 2026-grade — adapters/notification-emitter.adapter.ts.
 *
 * Da 2026-06-15 l'adapter NON emette più un evento bus orfano: consegna una
 * NOTIFICA IN-APP reale agli owner del workspace. Copertura bug-bounty:
 *
 * 🚨 SUPPRESSION: critical=0 + rowsQuarantined=0 → NESSUNA notifica (e nessun
 *    lookup destinatari) — bug = flood per dry-run "tutto ok".
 * 🚨 FAN-OUT: 1 notifica per OGNI owner del tenant (≥1 e >1).
 * 🚨 NO-RECIPIENTS: nessun owner → 0 create (no crash, stato osservabile).
 * 🚨 TENANT-SCOPE: i destinatari sono risolti col tenantId del REPORT (anti
 *    cross-tenant — non un id arbitrario).
 * 🚨 PAYLOAD: type 'janitor.detection', actorName, preview con ruleId/righe/tabella.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationEmitterAdapter, buildPreview, type INotificationSink } from './notification-emitter.adapter.js';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type { JanitorRuleReport } from '@/services/janitor/domain/index.js';

vi.mock('@/lib/logger.js');

interface SinkSpy extends INotificationSink {
  tenantAdminUserIds: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function makeSink(recipients: string[]): SinkSpy {
  return {
    tenantAdminUserIds: vi.fn(() => recipients),
    create: vi.fn(),
  };
}

const mkReport = (over: Partial<JanitorRuleReport> = {}): JanitorRuleReport => ({
  cycleId: 'c1', ruleId: 'rule.a', tenantId: 't1', dataSourceRef: SYSTEM_REF,
  targetTable: 'runs', startedAt: '2026-06-08T12:00:00Z', endedAt: '2026-06-08T12:00:01Z',
  durationMs: 1000, rowsDetected: 0, rowsRepaired: 0, rowsQuarantined: 0, rowsSkipped: 0,
  bySeverity: { critical: 0, warning: 0 }, dryRun: false, success: true,
  triggeredBy: 'scheduler', ...over,
});

let sink: SinkSpy;
let adapter: NotificationEmitterAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  sink = makeSink(['owner-1']);
  adapter = new NotificationEmitterAdapter(sink);
});

describe('🚨 notifyDetection — suppression', () => {
  it('🚨 critical=0 + rowsQuarantined=0 → NESSUNA notifica e NESSUN lookup destinatari', async () => {
    await adapter.notifyDetection(mkReport());
    expect(sink.create).not.toHaveBeenCalled();
    expect(sink.tenantAdminUserIds).not.toHaveBeenCalled();
  });

  it('🚨 SUPPRESSION DRY-RUN tipico (zero quarantine) → no notifica', async () => {
    await adapter.notifyDetection(mkReport({
      dryRun: true, rowsDetected: 5, rowsQuarantined: 0,
      bySeverity: { critical: 0, warning: 5 },
    }));
    expect(sink.create).not.toHaveBeenCalled();
  });
});

describe('🚨 notifyDetection — consegna reale', () => {
  it('🚨 critical >= 1 → crea 1 notifica per il singolo owner', async () => {
    await adapter.notifyDetection(mkReport({
      rowsQuarantined: 1, bySeverity: { critical: 1, warning: 0 },
    }));
    expect(sink.create).toHaveBeenCalledTimes(1);
    expect(sink.create.mock.calls[0]![0]).toMatchObject({ userId: 'owner-1', type: 'janitor.detection' });
  });

  it('🚨 rowsQuarantined > 0 (solo warning) → consegna comunque', async () => {
    await adapter.notifyDetection(mkReport({
      rowsQuarantined: 3, bySeverity: { critical: 0, warning: 3 },
    }));
    expect(sink.create).toHaveBeenCalledTimes(1);
  });

  it('🚨 FAN-OUT: 3 owner → 3 notifiche, una per ciascuno', async () => {
    sink = makeSink(['a', 'b', 'c']);
    adapter = new NotificationEmitterAdapter(sink);
    await adapter.notifyDetection(mkReport({
      rowsQuarantined: 2, bySeverity: { critical: 2, warning: 0 },
    }));
    expect(sink.create).toHaveBeenCalledTimes(3);
    expect(sink.create.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['a', 'b', 'c']);
  });

  it('🚨 NO-RECIPIENTS: nessun owner → 0 create, nessun crash', async () => {
    sink = makeSink([]);
    adapter = new NotificationEmitterAdapter(sink);
    await expect(adapter.notifyDetection(mkReport({
      rowsQuarantined: 1, bySeverity: { critical: 1, warning: 0 },
    }))).resolves.toBeUndefined();
    expect(sink.create).not.toHaveBeenCalled();
  });

  it('🚨 TENANT-SCOPE: i destinatari sono risolti col tenantId del REPORT', async () => {
    await adapter.notifyDetection(mkReport({
      tenantId: 'tenant-XYZ', rowsQuarantined: 1, bySeverity: { critical: 1, warning: 0 },
    }));
    expect(sink.tenantAdminUserIds).toHaveBeenCalledWith('tenant-XYZ');
  });

  it('🚨 PAYLOAD: actorName + preview con ruleId, righe, tabella', async () => {
    await adapter.notifyDetection(mkReport({
      ruleId: 'rule.duplicate-emails', targetTable: 'contacts',
      rowsQuarantined: 7, bySeverity: { critical: 4, warning: 3 },
    }));
    const arg = sink.create.mock.calls[0]![0] as { actorName: string; preview: string };
    expect(arg.actorName).toBe('FlowForge Janitor');
    expect(arg.preview).toContain('rule.duplicate-emails');
    expect(arg.preview).toContain('7');
    expect(arg.preview).toContain('contacts');
    expect(arg.preview).toContain('4'); // critiche
  });
});

describe('🚨 buildPreview', () => {
  it('include "di cui N critiche" solo se critical > 0', () => {
    const withCrit = buildPreview(mkReport({ ruleId: 'r', targetTable: 't', rowsQuarantined: 5, bySeverity: { critical: 2, warning: 3 } }));
    expect(withCrit).toContain('di cui 2 critiche');
    const noCrit = buildPreview(mkReport({ ruleId: 'r', targetTable: 't', rowsQuarantined: 5, bySeverity: { critical: 0, warning: 5 } }));
    expect(noCrit).not.toContain('critiche');
  });
});
