/**
 * Bug-bounty di ensureTenant (A2 free-trial) su SQLite REALE in-memory.
 * Punti critici:
 *  - INSERT con stato dal claim (trial+trialEndsAt) / default 'active' (retrocompat)
 *  - ON CONFLICT sincronizza trial→active (pagamento)
 *  - 🚨 NON sovrascrive 'suspended'/'archived' (anti-bypass: chi è stato
 *    sospeso dall'admin non si riattiva passando dal billing)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: h.db }) }));

import { ensureTenant, normalizeTenantStatusClaim } from './tenant-upsert.js';

function getRow(id: string): { status: string; trial_ends_at: string | null } | undefined {
  return h.db!.prepare('SELECT status, trial_ends_at FROM tenants WHERE id = ?').get(id) as
    | { status: string; trial_ends_at: string | null }
    | undefined;
}

/** Pre-inserisce un tenant con uno status dato (simula stato pregresso). */
function seed(id: string, status: string): void {
  h.db!.prepare(
    `INSERT INTO tenants (id, display_name, status, plan, country, locale, timezone, max_workflows, max_runs_per_month, max_storage_mb, trial_ends_at)
       VALUES (?, ?, ?, 'enterprise', 'IT', 'it', 'Europe/Rome', 0, 0, 0, NULL)`,
  ).run(id, id, status);
}

beforeEach(() => {
  h.db = new Database(':memory:');
  h.db.exec(`CREATE TABLE tenants (
    id TEXT PRIMARY KEY, display_name TEXT, status TEXT NOT NULL, plan TEXT,
    country TEXT, locale TEXT, timezone TEXT,
    max_workflows INTEGER, max_runs_per_month INTEGER, max_storage_mb INTEGER,
    trial_ends_at TEXT, deleted_at TEXT
  )`);
});

describe('ensureTenant — INSERT (primo SSO)', () => {
  it('crea con status="trial" + trialEndsAt dal claim', () => {
    ensureTenant({
      tenantId: 't1',
      displayName: 'Acme',
      status: 'trial',
      trialEndsAt: '2026-07-01T00:00:00.000Z',
    });
    expect(getRow('t1')).toEqual({ status: 'trial', trial_ends_at: '2026-07-01T00:00:00.000Z' });
  });

  it('default "active" + trial null se il claim non porta lo stato (retrocompat token vecchi)', () => {
    ensureTenant({ tenantId: 't2', displayName: 'Globex' });
    expect(getRow('t2')).toEqual({ status: 'active', trial_ends_at: null });
  });
});

describe('ensureTenant — ON CONFLICT (login successivi, sync billing→runtime)', () => {
  it('trial → active dopo il pagamento (sincronizza dal claim)', () => {
    seed('t3', 'trial');
    ensureTenant({ tenantId: 't3', displayName: 'Acme', status: 'active', trialEndsAt: null });
    expect(getRow('t3')?.status).toBe('active');
  });

  it('aggiorna trial_ends_at se cambia (es. trial esteso)', () => {
    ensureTenant({
      tenantId: 't4',
      displayName: 'A',
      status: 'trial',
      trialEndsAt: '2026-07-01T00:00:00.000Z',
    });
    ensureTenant({
      tenantId: 't4',
      displayName: 'A',
      status: 'trial',
      trialEndsAt: '2026-07-15T00:00:00.000Z',
    });
    expect(getRow('t4')?.trial_ends_at).toBe('2026-07-15T00:00:00.000Z');
  });

  it('🚨 SECURITY: tenant "suspended" NON viene riattivato dal claim (anti-bypass billing)', () => {
    seed('t5', 'suspended');
    ensureTenant({ tenantId: 't5', displayName: 'A', status: 'active', trialEndsAt: null });
    expect(getRow('t5')?.status).toBe('suspended'); // resta sospeso
  });

  it('🚨 SECURITY: tenant "archived" NON viene riattivato dal claim', () => {
    seed('t6', 'archived');
    ensureTenant({ tenantId: 't6', displayName: 'A', status: 'active', trialEndsAt: null });
    expect(getRow('t6')?.status).toBe('archived');
  });
});

describe('normalizeTenantStatusClaim', () => {
  it('solo "trial" → trial; tutto il resto → active (fail-safe, mai trial spurio)', () => {
    expect(normalizeTenantStatusClaim('trial')).toBe('trial');
    expect(normalizeTenantStatusClaim('active')).toBe('active');
    expect(normalizeTenantStatusClaim('suspended')).toBe('active'); // suspended NON arriva dal claim
    expect(normalizeTenantStatusClaim(undefined)).toBe('active');
    expect(normalizeTenantStatusClaim('hacker')).toBe('active');
  });
});
