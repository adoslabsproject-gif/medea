/**
 * Test 2026-grade — adapters/audit-emitter.adapter.ts (audit delegate).
 *
 * 🚨 DELEGATION: passa event a AuditLogService.append. No re-impl.
 *
 * 🚨 CONDITIONAL SPREAD: campi opzionali (resourceId/actorId/metadata)
 *    OMESSI dal payload se undefined (no `field: undefined` nel JSON audit).
 *    Bug = audit log con esplicito undefined → query SQL strane.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditEmitterAdapter } from './audit-emitter.adapter.js';

const appendMock = vi.fn();
const auditService = { append: appendMock } as never;

let adapter: AuditEmitterAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  adapter = new AuditEmitterAdapter(auditService);
});

describe('🚨 emit — delegation + conditional spread', () => {
  it('🚨 minimo (solo tenantId+action+resourceType) → append con solo questi', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'janitor.test',
      resourceType: 'janitor_rule_config',
    });
    expect(appendMock).toHaveBeenCalledTimes(1);
    const payload = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({
      tenantId: 't1',
      action: 'janitor.test',
      resourceType: 'janitor_rule_config',
    });
    expect('resourceId' in payload).toBe(false);
    expect('actorId' in payload).toBe(false);
    expect('metadata' in payload).toBe(false);
  });

  it('🚨 resourceId presente → propagato', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'a',
      resourceType: 'r',
      resourceId: 'res-1',
    });
    const payload = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.resourceId).toBe('res-1');
  });

  it('🚨 actorId presente → propagato', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'a',
      resourceType: 'r',
      actorId: 'user-1',
    });
    const payload = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.actorId).toBe('user-1');
  });

  it('🚨 metadata Record presente → propagato', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'a',
      resourceType: 'r',
      metadata: { changedFields: ['enabled'], oldValue: true },
    });
    const payload = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.metadata).toEqual({ changedFields: ['enabled'], oldValue: true });
  });

  it('🚨 tutti i campi → tutti propagati', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'janitor.rule.patched',
      resourceType: 'janitor_rule_config',
      resourceId: 'rule.a',
      actorId: 'admin-alice',
      metadata: { fields: ['enabled'] },
    });
    expect(appendMock).toHaveBeenCalledWith({
      tenantId: 't1',
      action: 'janitor.rule.patched',
      resourceType: 'janitor_rule_config',
      resourceId: 'rule.a',
      actorId: 'admin-alice',
      metadata: { fields: ['enabled'] },
    });
  });

  it('🚨 metadata empty object {} → propagato (esplicito)', async () => {
    await adapter.emit({
      tenantId: 't1',
      action: 'a',
      resourceType: 'r',
      metadata: {},
    });
    const payload = appendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.metadata).toEqual({});
  });

  it('🚨 RESILIENCE: AuditService throw → propaga error (no swallow)', async () => {
    appendMock.mockRejectedValueOnce(new Error('audit chain broken'));
    await expect(
      adapter.emit({
        tenantId: 't1',
        action: 'a',
        resourceType: 'r',
      }),
    ).rejects.toThrow(/audit chain broken/);
  });
});
