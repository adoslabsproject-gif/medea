/**
 * Test 2026-grade — application/manage-quarantine.usecase.ts (restore/purge).
 *
 * 🚨 SECURITY HARD GATE PURGE: confirmationToken='DELETE-PERMANENT' literal.
 *    Bug = misclick UI cancella permanente.
 *
 * 🚨 AUDIT PRIMA del cambio stato: lookup record → emit audit con rawJson →
 *    eseguiamo restore/purge. Bug = audit dopo → record sparito → audit vuoto.
 *
 * 🚨 RESTORE: record not found → throw fail-loud.
 *
 * 🚨 PURGE METADATA include 'warning' string (compliance evidence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManageQuarantineUseCase } from './manage-quarantine.usecase.js';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type { IQuarantineGateway, IAuditEmitter } from '@/services/janitor/ports/index.js';
import type { QuarantineRecord } from '@/services/janitor/domain/index.js';

const mkRec = (over: Partial<QuarantineRecord> = {}): QuarantineRecord => ({
  id: over.id ?? 42,
  originalId: over.originalId ?? 'row-1',
  originalTable: over.originalTable ?? 'runs',
  tenantId: over.tenantId ?? 't1',
  dataSourceRef: over.dataSourceRef ?? SYSTEM_REF,
  quarantinedAt: over.quarantinedAt ?? '2026-06-08T12:00:00Z',
  quarantinedBy: over.quarantinedBy ?? 'scheduler',
  ruleId: over.ruleId ?? 'rule.a',
  severity: over.severity ?? 'critical',
  reason: over.reason ?? 'corrupted',
  rawJson: over.rawJson ?? '{"id":"row-1","status":"corrupted"}',
});

let quarantine: IQuarantineGateway;
let audit: IAuditEmitter;
let uc: ManageQuarantineUseCase;

beforeEach(() => {
  quarantine = {
    ensureSchema: vi.fn(),
    quarantineRow: vi.fn(),
    list: vi.fn(async () => []),
    stats: vi.fn(async () => ({
      total: 0,
      byTable: {},
      byRule: {},
      bySeverity: { critical: 0, warning: 0 },
    })),
    restore: vi.fn(),
    purge: vi.fn(),
  };
  audit = { emit: vi.fn() };
  uc = new ManageQuarantineUseCase(quarantine, audit);
});

describe('🚨 list + stats — passthrough delegation', () => {
  it('🚨 list delega al gateway', async () => {
    const rec = mkRec();
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([rec]);
    const out = await uc.list({ tenantId: 't1' });
    expect(quarantine.list).toHaveBeenCalledWith({ tenantId: 't1' });
    expect(out).toEqual([rec]);
  });

  it('🚨 stats delega al gateway', async () => {
    await uc.stats(SYSTEM_REF);
    expect(quarantine.stats).toHaveBeenCalledWith(SYSTEM_REF);
  });
});

describe('🚨 restore — audit-before-mutation + lookup', () => {
  it('🚨 record trovato → audit emit → restore', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([mkRec({ id: 42 })]);
    await uc.restore({
      quarantineId: 42,
      dataSourceRef: SYSTEM_REF,
      tenantId: 't1',
      actorId: 'alice',
    });
    expect(audit.emit).toHaveBeenCalledBefore(quarantine.restore as never);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.quarantine.restore',
        resourceType: 'quarantined_row',
        resourceId: '42',
        actorId: 'alice',
        tenantId: 't1',
      }),
    );
    expect(quarantine.restore).toHaveBeenCalledWith(42, SYSTEM_REF);
  });

  it('🚨 record NOT FOUND → THROW (fail-loud)', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(
      uc.restore({
        quarantineId: 999,
        dataSourceRef: SYSTEM_REF,
        tenantId: 't1',
        actorId: 'alice',
      }),
    ).rejects.toThrow(/non trovato/);
    expect(quarantine.restore).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('🚨 audit metadata include rawJson + originalTable + originalId + ruleId', async () => {
    const rec = mkRec({ id: 42, rawJson: '{"sensitive":"data"}' });
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([rec]);
    await uc.restore({
      quarantineId: 42,
      dataSourceRef: SYSTEM_REF,
      tenantId: 't1',
      actorId: 'alice',
    });
    const call = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      metadata: Record<string, unknown>;
    };
    expect(call.metadata.rawJson).toBe('{"sensitive":"data"}');
    expect(call.metadata.originalTable).toBe('runs');
    expect(call.metadata.originalId).toBe('row-1');
    expect(call.metadata.ruleId).toBe('rule.a');
  });
});

describe('🚨 purge — confirmation token hard gate', () => {
  it('🚨 SECURITY: confirmationToken mancante (string vuota) → THROW', async () => {
    await expect(
      uc.purge({
        quarantineId: 42,
        dataSourceRef: SYSTEM_REF,
        tenantId: 't1',
        actorId: 'alice',
        confirmationToken: '',
      }),
    ).rejects.toThrow(/DELETE-PERMANENT/);
    expect(quarantine.purge).not.toHaveBeenCalled();
  });

  it('🚨 SECURITY: confirmationToken case sensitive', async () => {
    await expect(
      uc.purge({
        quarantineId: 42,
        dataSourceRef: SYSTEM_REF,
        tenantId: 't1',
        actorId: 'alice',
        confirmationToken: 'delete-permanent',
      }),
    ).rejects.toThrow(/DELETE-PERMANENT/);
  });

  it('🚨 SECURITY: confirmationToken wrong literal → THROW', async () => {
    await expect(
      uc.purge({
        quarantineId: 42,
        dataSourceRef: SYSTEM_REF,
        tenantId: 't1',
        actorId: 'alice',
        confirmationToken: 'CONFIRM',
      }),
    ).rejects.toThrow(/DELETE-PERMANENT/);
  });

  it('🚨 token corretto + record found → purge eseguito', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([mkRec({ id: 42 })]);
    await uc.purge({
      quarantineId: 42,
      dataSourceRef: SYSTEM_REF,
      tenantId: 't1',
      actorId: 'alice',
      confirmationToken: 'DELETE-PERMANENT',
    });
    expect(quarantine.purge).toHaveBeenCalledWith(42, SYSTEM_REF);
  });

  it('🚨 token corretto MA record not found → THROW', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(
      uc.purge({
        quarantineId: 999,
        dataSourceRef: SYSTEM_REF,
        tenantId: 't1',
        actorId: 'alice',
        confirmationToken: 'DELETE-PERMANENT',
      }),
    ).rejects.toThrow(/non trovato/);
  });

  it('🚨 audit metadata include warning string (compliance evidence)', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([mkRec({ id: 42 })]);
    await uc.purge({
      quarantineId: 42,
      dataSourceRef: SYSTEM_REF,
      tenantId: 't1',
      actorId: 'alice',
      confirmationToken: 'DELETE-PERMANENT',
    });
    const call = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      metadata: { warning: string };
    };
    expect(call.metadata.warning).toContain('HARD DELETE');
  });

  it('🚨 audit-before-mutation order (purge dopo)', async () => {
    (quarantine.list as ReturnType<typeof vi.fn>).mockResolvedValue([mkRec({ id: 42 })]);
    await uc.purge({
      quarantineId: 42,
      dataSourceRef: SYSTEM_REF,
      tenantId: 't1',
      actorId: 'alice',
      confirmationToken: 'DELETE-PERMANENT',
    });
    expect(audit.emit).toHaveBeenCalledBefore(quarantine.purge as never);
  });
});
