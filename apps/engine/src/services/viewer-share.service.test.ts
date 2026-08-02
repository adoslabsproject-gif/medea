/**
 * viewer-share.service tests — focus #208 P0-9.
 *
 * create() + revoke() ora await audit.append (era fire-and-forget pre-fix).
 * Anche per token "share" pubblici, l'audit GDPR è obbligatorio: chi ha
 * creato, quando, con quali parametri (name/expires), chi l'ha revocato.
 *
 * Coverage:
 *  - create(...) → audit.append append-awaited
 *  - revoke(id esistente) → audit + return true
 *  - revoke(id inesistente) → no audit + return false
 *  - revoke con audit rejection → throw propagato
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  run: vi.fn().mockReturnValue({ changes: 1 }),
  prepare: vi.fn(),
  auditAppend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: (sql: string) => {
        m.prepare(sql);
        return {
          run: (...args: unknown[]) => m.run(sql, ...args),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
        };
      },
    },
  }),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({
    append: m.auditAppend,
  })),
}));

vi.mock('nanoid', () => ({
  nanoid: () => 'fixed-nanoid-1',
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.run.mockReturnValue({ changes: 1 });
  m.auditAppend.mockResolvedValue(undefined);
});

describe('#208 P0-9 — ViewerShareService.create await audit', () => {
  it('create chiama audit con await + ritorna token con campi popolati', async () => {
    const { ViewerShareService } = await import('./viewer-share.service.js');
    const svc = new ViewerShareService();
    const tok = await svc.create('tenant-1', {
      name: 'Public Dashboard',
      expiresInDays: 7,
      createdBy: 'user-1',
    });
    expect(tok.tenantId).toBe('tenant-1');
    expect(tok.name).toBe('Public Dashboard');
    expect(tok.token).toMatch(/^[0-9a-f]{64}$/);
    expect(m.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'viewer_share.create',
        resourceType: 'viewer_share_token',
        actorId: 'user-1',
      }),
    );
  });

  it('create con audit rejection → throw propagato (no swallow)', async () => {
    m.auditAppend.mockRejectedValueOnce(new Error('audit chain corrupted'));
    const { ViewerShareService } = await import('./viewer-share.service.js');
    const svc = new ViewerShareService();
    await expect(svc.create('tenant-1', { name: 'X' })).rejects.toThrow(/audit chain corrupted/);
  });
});

describe('#208 P0-9 — ViewerShareService.revoke await audit', () => {
  it('revoke su id esistente → true + audit chiamato', async () => {
    m.run.mockReturnValueOnce({ changes: 1 });
    const { ViewerShareService } = await import('./viewer-share.service.js');
    const svc = new ViewerShareService();
    const ok = await svc.revoke('tenant-1', 'share-id-1', 'admin-1');
    expect(ok).toBe(true);
    expect(m.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'viewer_share.revoke',
        resourceId: 'share-id-1',
        actorId: 'admin-1',
      }),
    );
  });

  it('revoke su id inesistente (changes=0) → false + NO audit', async () => {
    m.run.mockReturnValueOnce({ changes: 0 });
    const { ViewerShareService } = await import('./viewer-share.service.js');
    const svc = new ViewerShareService();
    const ok = await svc.revoke('tenant-1', 'bogus-id');
    expect(ok).toBe(false);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('revoke con audit rejection → throw propagato', async () => {
    m.run.mockReturnValueOnce({ changes: 1 });
    m.auditAppend.mockRejectedValueOnce(new Error('audit DB down'));
    const { ViewerShareService } = await import('./viewer-share.service.js');
    const svc = new ViewerShareService();
    await expect(svc.revoke('tenant-1', 'share-id-2')).rejects.toThrow(/audit DB down/);
  });
});
