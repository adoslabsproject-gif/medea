/**
 * tenant.service tests — enterprise grade.
 *
 * Coverage focus:
 *   • Slug validation regex (3-64 char, [a-z0-9-], no leading/trailing dash)
 *   • Slug conflict ONLY su tenant ATTIVI (deleted slug è riusabile)
 *   • Lookup soft-delete exclusion (find/get skip deleted_at NOT NULL)
 *   • list() filter status/plan/includeDeleted + pagination cap 500
 *   • State machine: active ↔ suspended ↔ archived ↔ soft-deleted
 *   • assertActive: trial valid, trial expired, suspended, archived
 *   • checkQuota: limit=0 (unlimited) skip, current+requested>limit throw
 *   • Audit log: ogni operazione mutativa emette evento
 *   • Custom errors: TenantNotFoundError / TenantSlugConflictError /
 *     TenantNotActiveError / QuotaExceededError
 */

import { coerceString } from '@/lib/coerce.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const m = vi.hoisted(() => {
  const sqliteStmt = {
    get: vi.fn(),
    run: vi.fn(),
    all: vi.fn(),
  };
  return {
    sqliteStmt,
    prepare: vi.fn(() => sqliteStmt),
    auditAppend: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: { prepare: m.prepare },
  }),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({
    // Il service ora usa appendSync (audit #1: durabilità sincrona). Le due
    // spie puntano allo STESSO mock così le asserzioni esistenti (m.auditAppend)
    // continuano a osservare l'audit, ora emesso via appendSync.
    append: m.auditAppend,
    appendSync: m.auditAppend,
  })),
}));

vi.mock('@/lib/logger.js');

import {
  TenantService,
  TenantNotFoundError,
  TenantNotActiveError,
  TenantSlugConflictError,
  QuotaExceededError,
} from './tenant.service.js';
import { resetConfigForTests } from '@/config.js';

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tenant-acme',
    display_name: 'ACME Srl',
    legal_name: null,
    vat_number: null,
    tax_code: null,
    billing_email: null,
    billing_address: null,
    country: 'IT',
    locale: 'it',
    timezone: 'Europe/Rome',
    status: 'active',
    trial_ends_at: null,
    suspended_at: null,
    suspended_reason: null,
    archived_at: null,
    plan: 'pro',
    subscription_ref: null,
    max_workflows: 10,
    max_runs_per_month: 1000,
    max_storage_mb: 500,
    settings_json: '{}',
    parent_tenant_id: null,
    created_at: '2026-05-29T00:00:00Z',
    updated_at: '2026-05-29T00:00:00Z',
    created_by_user_id: null,
    deleted_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sqliteStmt.get.mockReset();
  m.sqliteStmt.run.mockReset();
  m.sqliteStmt.all.mockReset();
});

// ════════════════════════════════════════════════════════════════════
// create() — slug validation + conflict
// ════════════════════════════════════════════════════════════════════
describe('TenantService.create — slug validation', () => {
  it('rejects slug troppo corto (<3 char)', () => {
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'ab', displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
  });

  it('rejects slug con leading dash', () => {
    const svc = new TenantService();
    expect(() => svc.create({ slug: '-acme', displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
  });

  it('rejects slug con trailing dash', () => {
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'acme-', displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
  });

  it('rejects slug con caratteri speciali (!@#$ ecc.)', () => {
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'acme!srl', displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
    expect(() => svc.create({ slug: 'acme srl', displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
    expect(() => svc.create({ slug: 'ACME', displayName: 'X' }))
      .not.toThrow(/Slug.*non valido/); // uppercase viene lowercased internamente
  });

  it('rejects slug troppo lungo (>64 char)', () => {
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'a'.repeat(65), displayName: 'X' }))
      .toThrow(/Slug.*non valido/);
  });

  it('accetta slug 3-64 alphanumerico + dash interno', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined) // SELECT 1 conflict check
      .mockReturnValueOnce(makeRow({ id: 'acme-2026' })); // get() post-insert
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'acme-2026', displayName: 'ACME' })).not.toThrow();
  });

  it('LOWERCASES slug prima di check', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeRow({ id: 'acme-srl' }));
    const svc = new TenantService();
    svc.create({ slug: 'ACME-SRL', displayName: 'X' });
    // Conflict check + INSERT + get() — verify slug passato è lowercase
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    expect(insertCall?.[0]).toBe('acme-srl');
  });

  it('TRIMS slug whitespace', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.create({ slug: '  acme  ', displayName: 'X' });
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    expect(insertCall?.[0]).toBe('acme');
  });

  it('THROWS TenantSlugConflictError se slug attivo già esiste', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ exists: 1 }); // conflict found
    const svc = new TenantService();
    expect(() => svc.create({ slug: 'acme', displayName: 'X' }))
      .toThrow(TenantSlugConflictError);
  });

  it('emette audit tenant.created con metadata', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeRow({ id: 'acme', display_name: 'ACME' }));
    const svc = new TenantService();
    svc.create({ slug: 'acme', displayName: 'ACME', plan: 'enterprise' }, 'user-admin-1');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'acme',
      actorId: 'user-admin-1',
      action: 'tenant.created',
      metadata: expect.objectContaining({ displayName: 'ACME', plan: 'enterprise' }),
    }));
  });

  it('default values applied: country=IT, locale=it, timezone=Europe/Rome, plan=enterprise', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeRow({ id: 'x' }));
    const svc = new TenantService();
    svc.create({ slug: 'newtenant', displayName: 'New' });
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    // Position-based: slug, displayName, legalName, vat, tax, billing_email, billing_addr, country, locale, timezone, status, trial_ends, plan, ...
    expect(insertCall?.[7]).toBe('IT');
    expect(insertCall?.[8]).toBe('it');
    expect(insertCall?.[9]).toBe('Europe/Rome');
    expect(insertCall?.[12]).toBe('enterprise');
  });
});

// ════════════════════════════════════════════════════════════════════
// get() / find() — soft-delete exclusion
// ════════════════════════════════════════════════════════════════════
describe('TenantService.get + find', () => {
  it('find returns null se inesistente', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    expect(svc.find('missing')).toBeNull();
  });

  it('find returns Tenant se ok', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    const t = svc.find('acme');
    expect(t?.id).toBe('acme');
  });

  it('get throws TenantNotFoundError se inesistente', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    expect(() => svc.get('missing')).toThrow(TenantNotFoundError);
  });

  it('find/get usa SQL "deleted_at IS NULL" — soft-deleted invisibile', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    svc.find('soft-deleted-tenant');
    const sqlCall = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(sqlCall).toMatch(/deleted_at IS NULL/);
  });

  it('parsing settings_json malformed → settings={} fallback', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({
      id: 'acme', settings_json: '{this-is-not-json',
    }));
    const svc = new TenantService();
    const t = svc.find('acme');
    expect(t?.settings).toEqual({});
  });

  it('parsing settings_json OK preserva object', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({
      id: 'acme',
      settings_json: JSON.stringify({ feature_a: true, max_x: 42 }),
    }));
    const svc = new TenantService();
    const t = svc.find('acme');
    expect(t?.settings).toEqual({ feature_a: true, max_x: 42 });
  });
});

// ════════════════════════════════════════════════════════════════════
// list() — filter + pagination
// ════════════════════════════════════════════════════════════════════
describe('TenantService.list', () => {
  it('returns empty se nessun match', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    const res = svc.list();
    expect(res.total).toBe(0);
    expect(res.tenants).toEqual([]);
  });

  it('filter status=suspended applica WHERE status=?', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ status: 'suspended' });
    const countSql = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(countSql).toMatch(/status = \?/);
  });

  it('filter status="all" NON applica WHERE status', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ status: 'all' });
    const countSql = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(countSql).not.toMatch(/status = \?/);
  });

  it('filter plan applica WHERE plan=?', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ plan: 'enterprise' });
    const countSql = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(countSql).toMatch(/plan = \?/);
  });

  it('includeDeleted=false (default) applica WHERE deleted_at IS NULL', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list();
    const countSql = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(countSql).toMatch(/deleted_at IS NULL/);
  });

  it('includeDeleted=true NON applica WHERE deleted_at', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ includeDeleted: true });
    const countSql = coerceString((m.prepare.mock.calls as unknown[][])[0]?.[0] ?? '');
    expect(countSql).not.toMatch(/deleted_at IS NULL/);
  });

  it('limit cap a 500 anche se richiesto >', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ limit: 10000 });
    const lastAllCall = m.sqliteStmt.all.mock.calls[0];
    // ultimi 2 args sono limit + offset
    const limit = lastAllCall?.[lastAllCall.length - 2];
    expect(limit).toBe(500);
  });

  it('limit default 50 se non specificato', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list();
    const lastAllCall = m.sqliteStmt.all.mock.calls[0];
    const limit = lastAllCall?.[lastAllCall.length - 2];
    expect(limit).toBe(50);
  });

  it('offset negativo viene clamped a 0', () => {
    m.sqliteStmt.get.mockReturnValueOnce({ n: 0 });
    m.sqliteStmt.all.mockReturnValueOnce([]);
    const svc = new TenantService();
    svc.list({ offset: -10 });
    const lastAllCall = m.sqliteStmt.all.mock.calls[0];
    const offset = lastAllCall?.[lastAllCall.length - 1];
    expect(offset).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// update() — patch + audit
// ════════════════════════════════════════════════════════════════════
describe('TenantService.update', () => {
  it('THROWS se tenant inesistente', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    expect(() => svc.update('missing', { displayName: 'X' })).toThrow(TenantNotFoundError);
  });

  it('patch vuoto è no-op (ritorna current senza UPDATE)', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', {});
    expect(m.sqliteStmt.run).not.toHaveBeenCalled();
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('settings JSON-stringified prima di INSERT', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' })) // get pre-update
      .mockReturnValueOnce(makeRow({ id: 'acme' })); // get post-update
    const svc = new TenantService();
    svc.update('acme', { settings: { foo: 'bar' } });
    const runCall = m.sqliteStmt.run.mock.calls[0];
    // settings_json è il primo (e unico) param + l'id alla fine
    expect(runCall?.[0]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('emette audit tenant.updated con changes (nomi field)', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', { displayName: 'NewName', maxRunsPerMonth: 5000 }, 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.updated',
      actorId: 'admin',
      metadata: { changes: expect.arrayContaining(['displayName', 'maxRunsPerMonth']) },
    }));
  });

  it('null patch su nullable field → SET col = NULL', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', vat_number: 'IT123' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', vat_number: null }));
    const svc = new TenantService();
    svc.update('acme', { vatNumber: null });
    const runCall = m.sqliteStmt.run.mock.calls[0];
    expect(runCall?.[0]).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// suspend / activate / archive / softDelete
// ════════════════════════════════════════════════════════════════════
describe('TenantService — state machine', () => {
  it('suspend: throws se tenant inesistente', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    expect(() => svc.suspend('missing', 'fraud')).toThrow(TenantNotFoundError);
  });

  it('suspend: UPDATE + audit tenant.suspended con reason', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' })) // pre-get
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'suspended' })); // post-get
    const svc = new TenantService();
    svc.suspend('acme', 'payment_failed', 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.suspended',
      metadata: { reason: 'payment_failed' },
    }));
  });

  it('activate: UPDATE rimuove suspended_at + reason', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'suspended' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'active' }));
    const svc = new TenantService();
    svc.activate('acme', 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.activated',
    }));
    // verify SQL contiene SET suspended_at = NULL
    const updateSql = coerceString((m.prepare.mock.calls as unknown[][]).find((c) => coerceString(c[0] ?? '').includes('UPDATE tenants'))?.[0] ?? '');
    expect(updateSql).toMatch(/suspended_at = NULL/);
    expect(updateSql).toMatch(/suspended_reason = NULL/);
  });

  it('archive: status=archived + audit con reason (audit #5) + actor', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'archived' }));
    const svc = new TenantService();
    svc.archive('acme', 'contract ended', 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.archived',
      actorId: 'admin',
      metadata: { reason: 'contract ended' },
    }));
  });

  it('softDelete: deleted_at=NOW + audit con reason (audit #5) + actor', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.softDelete('acme', 'gdpr erasure request', 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tenant.deleted',
      actorId: 'admin',
      metadata: { reason: 'gdpr erasure request' },
    }));
  });
});

// ════════════════════════════════════════════════════════════════════
// assertActive — guard at critical operations
// ════════════════════════════════════════════════════════════════════
describe('TenantService.assertActive', () => {
  it('active → ok', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', status: 'active' }));
    const svc = new TenantService();
    expect(() => svc.assertActive('acme')).not.toThrow();
  });

  it('trial valido (trialEndsAt futuro) → ok', () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({
      id: 'acme', status: 'trial', trial_ends_at: future,
    }));
    const svc = new TenantService();
    expect(() => svc.assertActive('acme')).not.toThrow();
  });

  it('trial scaduto (trialEndsAt passato) → throws TenantNotActiveError', () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    const row = makeRow({ id: 'acme', status: 'trial', trial_ends_at: past });
    // Due assertActive() = due get() interni
    m.sqliteStmt.get.mockReturnValueOnce(row).mockReturnValueOnce(row);
    const svc = new TenantService();
    expect(() => svc.assertActive('acme')).toThrow(TenantNotActiveError);
    expect(() => svc.assertActive('acme')).toThrow(/trial scaduto/);
  });

  it('suspended → throws TenantNotActiveError con reason in message', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({
      id: 'acme', status: 'suspended', suspended_reason: 'fraud_detected',
    }));
    const svc = new TenantService();
    expect(() => svc.assertActive('acme')).toThrow(/fraud_detected/);
  });

  it('archived → throws TenantNotActiveError', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', status: 'archived' }));
    const svc = new TenantService();
    expect(() => svc.assertActive('acme')).toThrow(TenantNotActiveError);
  });
});

// ════════════════════════════════════════════════════════════════════
// checkQuota — workflows + runs_per_month + storage_mb
// ════════════════════════════════════════════════════════════════════
describe('TenantService.checkQuota', () => {
  it('throws TenantNotFoundError se tenant inesistente', () => {
    m.sqliteStmt.get.mockReturnValueOnce(undefined);
    const svc = new TenantService();
    expect(() => svc.checkQuota('missing', 'workflows')).toThrow(TenantNotFoundError);
  });

  it('limit=0 → unlimited, skip check (no COUNT query)', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({
      id: 'acme', max_workflows: 0,
    }));
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'workflows', 999)).not.toThrow();
    // SOLO la query get() del tenant, NESSUNA COUNT
    expect(m.sqliteStmt.get).toHaveBeenCalledTimes(1);
  });

  it('within limit → ok', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 10 }))
      .mockReturnValueOnce({ n: 5 }); // count
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'workflows', 1)).not.toThrow();
  });

  it('current+requested = exactly limit → ok (boundary)', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 10 }))
      .mockReturnValueOnce({ n: 9 });
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'workflows', 1)).not.toThrow();
  });

  it('current+requested > limit → throws QuotaExceededError', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 10 }))
      .mockReturnValueOnce({ n: 10 });
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'workflows', 1)).toThrow(QuotaExceededError);
  });

  it('QuotaExceededError espone tenantId/kind/limit/current', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 5 }))
      .mockReturnValueOnce({ n: 5 });
    const svc = new TenantService();
    try {
      svc.checkQuota('acme', 'workflows', 1);
      expect.fail('Should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(QuotaExceededError);
      const err = e as QuotaExceededError;
      expect(err.tenantId).toBe('acme');
      expect(err.kind).toBe('workflows');
      expect(err.limit).toBe(5);
      expect(err.current).toBe(5);
    }
  });

  // 2026-06-04 policy: workflows quota = ATTIVI (enabled=1), non totali.
  it('workflows: query include AND enabled = 1 (policy attivi-only)', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 5 }))
      .mockReturnValueOnce({ n: 3 });
    const svc = new TenantService();
    svc.checkQuota('acme', 'workflows', 1);
    const sqlCall = coerceString((m.prepare.mock.calls as unknown[][])
      .find((c) => coerceString(c[0] ?? '').includes('FROM workflows'))?.[0] ?? '');
    expect(sqlCall).toMatch(/enabled\s*=\s*1/);
  });

  it('runs_per_month: query WHERE started_at >= firstOfMonth', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_runs_per_month: 1000 }))
      .mockReturnValueOnce({ n: 100 });
    const svc = new TenantService();
    svc.checkQuota('acme', 'runs_per_month', 1);
    // FIX 2026-06-06: la tabella è `runs` (non più `workflow_runs` fantasma).
    const sqlCall = coerceString((m.prepare.mock.calls as unknown[][]).find((c) => /FROM runs\b/.test(coerceString(c[0] ?? '')))?.[0] ?? '');
    expect(sqlCall).toMatch(/FROM runs WHERE tenant_id = \? AND started_at >= \?/);
  });

  it('storage_mb: limit=0 → unlimited skip, NON misura il disco', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 0 }));
    const svc = new TenantService();
    // Spy: se il path unlimited misurasse il disco sarebbe spreco → deve NON
    // chiamare getStorageUsageMb.
    const spy = vi.spyOn(svc, 'getStorageUsageMb');
    expect(() => svc.checkQuota('acme', 'storage_mb', 100)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('storage_mb: limit>0 e uso reale SOTTO il limite → non lancia', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 1024 }));
    const svc = new TenantService();
    vi.spyOn(svc, 'getStorageUsageMb').mockReturnValue(500); // 500 MB usati
    expect(() => svc.checkQuota('acme', 'storage_mb', 1)).not.toThrow();
  });

  it('🚨 storage_mb: uso reale + requested SOPRA il limite → QuotaExceededError', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 1024 }));
    const svc = new TenantService();
    vi.spyOn(svc, 'getStorageUsageMb').mockReturnValue(1020); // 1020 + 10 > 1024
    expect(() => svc.checkQuota('acme', 'storage_mb', 10)).toThrow(QuotaExceededError);
  });

  it('🚨 storage_mb: confine esatto (used+requested === limit) → NON lancia', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 1000 }));
    const svc = new TenantService();
    vi.spyOn(svc, 'getStorageUsageMb').mockReturnValue(999);
    // 999 + 1 = 1000, NON > 1000 → ammesso (il limite è inclusivo).
    expect(() => svc.checkQuota('acme', 'storage_mb', 1)).not.toThrow();
  });

  it('default requested=1 se non specificato', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', max_workflows: 5 }))
      .mockReturnValueOnce({ n: 4 });
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'workflows')).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// Branch coverage — actorUserId undefined paths
// ════════════════════════════════════════════════════════════════════
describe('TenantService — actorUserId undefined branches', () => {
  it('create SENZA actorUserId → audit NO actorId field', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.create({ slug: 'acme', displayName: 'ACME' }); // no actorUserId
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('update SENZA actorUserId → audit NO actorId', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', { displayName: 'New' }); // no actorUserId
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('suspend SENZA actorUserId → audit NO actorId', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'suspended' }));
    const svc = new TenantService();
    svc.suspend('acme', 'reason'); // no actorUserId
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('activate SENZA actorUserId → audit NO actorId', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'suspended' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'active' }));
    const svc = new TenantService();
    svc.activate('acme'); // no actorUserId
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('archive SENZA actorUserId → audit NO actorId', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', status: 'archived' }));
    const svc = new TenantService();
    svc.archive('acme', 'reason x');
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('softDelete SENZA actorUserId → audit NO actorId', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.softDelete('acme', 'reason x');
    const auditCall = m.auditAppend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.actorId).toBeUndefined();
  });

  it('update settings: patch.settings null → branch v ?? null', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    // Forziamo branch dove v=settings è undefined dopo l'object check (ma settings non può essere null se passato — testiamo edge): testiamo update con settings={} esplicito
    svc.update('acme', { settings: {} });
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    expect(insertCall?.[0]).toBe('{}');
  });

  it('checkQuota storage_mb con limit>0 misura il disco (statfs), non una COUNT query', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 100 }));
    const svc = new TenantService();
    vi.spyOn(svc, 'getStorageUsageMb').mockReturnValue(10);
    expect(() => svc.checkQuota('acme', 'storage_mb', 50)).not.toThrow();
    // SOLO la get() del tenant: la misura storage è via statfs (getStorageUsageMb),
    // NON una seconda query sqlite come per workflows/runs.
    expect(m.sqliteStmt.get).toHaveBeenCalledTimes(1);
  });

  it('update settings null explicit → fallback {} (JSON.stringify(null ?? {}))', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', { settings: null as never });
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    expect(insertCall?.[0]).toBe('{}');
  });

  it('update settings undefined → SKIP UPDATE (early return, sets.length === 0)', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', { settings: undefined as never });
    // 🚨 BEHAVIOR: il source ha guard `if (patch[k] === undefined) continue;`
    // (line 298) seguito da `if (sets.length === 0) return current;` (line 303).
    // → undefined NON triggera UPDATE, NON triggera audit.
    // Bug pre-fix sarebbe: undefined viene scritto come SQL NULL e crash su NOT NULL.
    expect(m.sqliteStmt.run).not.toHaveBeenCalled();
    // .get chiamato 1 volta (early return su sets.length === 0 ritorna riga letta)
    expect(m.sqliteStmt.get).toHaveBeenCalledTimes(1);
  });

  it('update settings ESPLICITO {} → UPDATE chiamato con "{}" serialized', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme' }))
      .mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    svc.update('acme', { settings: {} });
    // 🚨 SAFETY: settings esplicito (anche vuoto) → UPDATE chiamato con "{}"
    expect(m.sqliteStmt.run).toHaveBeenCalled();
    const args = m.sqliteStmt.run.mock.calls[0] as unknown[];
    // Il primo param è il JSON-stringified settings
    expect(args.some(a => a === '{}')).toBe(true);
  });

  it('update vatNumber null explicit (non-settings field with null fallback v ?? null)', () => {
    m.sqliteStmt.get
      .mockReturnValueOnce(makeRow({ id: 'acme', vat_number: 'IT123' }))
      .mockReturnValueOnce(makeRow({ id: 'acme', vat_number: null }));
    const svc = new TenantService();
    svc.update('acme', { vatNumber: null });
    const insertCall = m.sqliteStmt.run.mock.calls[0];
    expect(insertCall?.[0]).toBeNull();
  });

  it('update vatNumber undefined explicit → skip in for loop (no SET clause)', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    // Tutti i field undefined → sets.length === 0 → return current senza UPDATE
    svc.update('acme', { vatNumber: undefined as never });
    expect(m.sqliteStmt.run).not.toHaveBeenCalled();
  });

  it('checkQuota runs_per_month con limit=0 → unlimited skip', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_runs_per_month: 0 }));
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'runs_per_month', 100)).not.toThrow();
    expect(m.sqliteStmt.get).toHaveBeenCalledTimes(1); // no COUNT query
  });

  // Kind sconosciuto trapassa tutti gli if e arriva al check finale current+req > limit (0+1>0=true) → throws
  it('checkQuota tipo NON gestito (kind sconosciuto) → throw (current+req > limit=0)', () => {
    m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme' }));
    const svc = new TenantService();
    expect(() => svc.checkQuota('acme', 'unknown' as never, 1)).toThrow(QuotaExceededError);
  });
});

// ════════════════════════════════════════════════════════════════════
// getStorageUsageMb — misura statfs REALE del volume del tenant (#7)
// ════════════════════════════════════════════════════════════════════
describe('TenantService.getStorageUsageMb — misura statfs reale', () => {
  const savedDataDir = process.env.MEDEA_DATA_DIR;

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.MEDEA_DATA_DIR;
    else process.env.MEDEA_DATA_DIR = savedDataDir;
    resetConfigForTests();
  });

  it('su una dir esistente ritorna un intero >= 0 (uso reale del filesystem)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-storage-'));
    try {
      process.env.MEDEA_DATA_DIR = dir;
      resetConfigForTests();
      const svc = new TenantService();
      const mb = svc.getStorageUsageMb();
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThanOrEqual(0);
      // Il filesystem host ha sempre qualcosa di occupato → > 0 (non un no-op a 0).
      expect(mb).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🚨 fail-open: path inesistente (statfs ENOENT) → 0, NON crash', () => {
    process.env.MEDEA_DATA_DIR = '/nonexistent/ff-data-dir-xyz-' + Date.now().toString();
    resetConfigForTests();
    const svc = new TenantService();
    expect(svc.getStorageUsageMb()).toBe(0);
  });

  it('🚨 checkQuota usa la misura reale: limite 1 MB con disco pieno → QuotaExceededError', () => {
    // Integrazione vera (no spy): la misura reale del FS host è enormemente
    // sopra 1 MB → con max_storage_mb=1 la quota deve scattare.
    const dir = mkdtempSync(join(tmpdir(), 'ff-storage-'));
    try {
      process.env.MEDEA_DATA_DIR = dir;
      resetConfigForTests();
      m.sqliteStmt.get.mockReturnValueOnce(makeRow({ id: 'acme', max_storage_mb: 1 }));
      const svc = new TenantService();
      expect(() => svc.checkQuota('acme', 'storage_mb', 1)).toThrow(QuotaExceededError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
