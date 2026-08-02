/**
 * Test 2026-grade — integrations/store (multi-tenant credentials vault).
 *
 * Coverage REALE (sqlite :memory: + REAL encrypt/decrypt via secrets-crypto +
 * audit mocked solo per ispezione):
 *  - saveIntegration insert: nuovo record con label/expiresAt, ID nanoid,
 *    rotated=false, audit emesso con action=integration.create
 *  - saveIntegration rotate: stesso (tenant,provider,label) → UPDATE in place,
 *    rotated=true, audit action=integration.rotate
 *  - 🚨 audit NON include plaintext credentials (security GDPR)
 *  - 🚨 row encrypted: plaintext del credential MAI in DB row
 *  - getIntegration: decrypt corretto, last_used_at touched, null se not found
 *  - 🚨 cross-tenant isolation: get tenant B su id A → null
 *  - updateIntegrationCredentials: ruota cipher+nonce+expiresAt, no audit row
 *  - 🚨 cross-tenant updateCredentials: tenant B su id A → 0 changes
 *  - deleteIntegration: SELECT pre per audit metadata, DELETE WHERE tenant,
 *    audit action=integration.delete con provider/label, 0 se cross-tenant
 *  - listIntegrations: solo metadata (NO credentials_encrypted), ordinato per
 *    provider ASC + updated_at DESC, tenant-scoped
 *  - validation: tenantId/provider/credentials missing → throw
 *  - normalizeLabel: empty/whitespace → null, distinto da label trimmed
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  db: null as Database.Database | null,
  auditAppend: vi.fn(),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append(args: unknown) {
      return m.auditAppend(args);
    }
  },
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/master-password.js', () => ({
  loadMasterPassword: () => ({ password: 'test-master-pw-32-bytes-min-aaaaaaaaa', source: 'env' }),
  getMasterPasswordOrThrow: () => 'test-master-pw-32-bytes-min-aaaaaaaaa',
}));

import * as store from './store.js';

function setupSchema(): void {
  m.db!.exec(`
    CREATE TABLE tenant_integrations (
      id                   TEXT PRIMARY KEY,
      provider             TEXT NOT NULL,
      tenant_id            TEXT NOT NULL,
      label                TEXT,
      credentials_encrypted BLOB NOT NULL,
      credentials_nonce    BLOB NOT NULL,
      expires_at           INTEGER,
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_used_at         TEXT,
      created_by_user_id   TEXT
    );
    CREATE UNIQUE INDEX tenant_integrations_tenant_provider_label_uniq
      ON tenant_integrations(tenant_id, provider, COALESCE(label, ''));
  `);
}

beforeEach(() => {
  m.db = new Database(':memory:');
  setupSchema();
  m.auditAppend.mockReset();
  m.auditAppend.mockResolvedValue(undefined);
});

const baseSave = (over: Partial<store.SaveIntegrationInput> = {}): store.SaveIntegrationInput => ({
  provider: 'stripe',
  tenantId: 'tA',
  label: 'Live',
  credentials: { secret_key: 'sk_live_secret_abc123', publishable_key: 'pk_live_xyz' },
  createdByUserId: 'user-1',
  ...over,
});

describe('saveIntegration — insert + audit', () => {
  it('insert nuovo: rotated=false, id nanoid, audit integration.create', async () => {
    const r = await store.saveIntegration(baseSave());
    expect(r.rotated).toBe(false);
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{8,}$/u);
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.auditAppend.mock.calls[0]![0]).toMatchObject({
      tenantId: 'tA',
      actorId: 'user-1',
      action: 'integration.create',
      resourceType: 'integration',
      resourceId: r.id,
    });
  });

  it('🚨 plaintext credentials NON nel DB row (security)', async () => {
    await store.saveIntegration(baseSave());
    const row = m.db!.prepare('SELECT * FROM tenant_integrations').get() as Record<string, unknown>;
    const rowSerialized = JSON.stringify(row, (_k, v) => {
      if (Buffer.isBuffer(v)) return v.toString('binary');
      return v;
    });
    expect(rowSerialized).not.toContain('sk_live_secret_abc123');
    expect(rowSerialized).not.toContain('pk_live_xyz');
  });

  it('🚨 audit metadata NON contiene plaintext credentials (audit log immutable)', async () => {
    await store.saveIntegration(baseSave());
    const auditArgs = m.auditAppend.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(JSON.stringify(auditArgs.metadata)).not.toContain('sk_live_secret_abc123');
    expect(auditArgs.metadata).toMatchObject({
      provider: 'stripe',
      label: 'Live',
    });
  });

  it('audit actorId default "system" se createdByUserId assente', async () => {
    const { createdByUserId: _omit, ...withoutUser } = baseSave();
    void _omit;
    await store.saveIntegration(withoutUser);
    expect((m.auditAppend.mock.calls[0]![0] as { actorId: string }).actorId).toBe('system');
  });

  it('label vuoto/whitespace → normalizzato a null', async () => {
    const r = await store.saveIntegration({ ...baseSave(), label: '   ' });
    const row = m.db!.prepare('SELECT label FROM tenant_integrations WHERE id = ?').get(r.id) as {
      label: string | null;
    };
    expect(row.label).toBeNull();
  });

  it('label trim: "  Live  " → "Live"', async () => {
    const r = await store.saveIntegration({ ...baseSave(), label: '  Live  ' });
    const row = m.db!.prepare('SELECT label FROM tenant_integrations WHERE id = ?').get(r.id) as {
      label: string;
    };
    expect(row.label).toBe('Live');
  });

  it('expiresAt unix epoch passato a DB', async () => {
    const exp = Date.now() + 3600_000;
    const r = await store.saveIntegration({ ...baseSave(), expiresAt: exp });
    const row = m
      .db!.prepare('SELECT expires_at FROM tenant_integrations WHERE id = ?')
      .get(r.id) as { expires_at: number };
    expect(row.expires_at).toBe(exp);
  });
});

describe('saveIntegration — rotation (idempotent upsert)', () => {
  it('stesso (tenant,provider,label) → UPDATE, rotated=true, stesso id', async () => {
    const a = await store.saveIntegration(baseSave());
    const b = await store.saveIntegration({
      ...baseSave(),
      credentials: { secret_key: 'sk_live_ROTATED', publishable_key: 'pk_new' },
    });
    expect(b.id).toBe(a.id);
    expect(b.rotated).toBe(true);
    expect(m.auditAppend.mock.calls[1]![0]).toMatchObject({
      action: 'integration.rotate',
    });
  });

  it('cipher cambia dopo rotate (re-encrypted, no leak vecchio cipher)', async () => {
    const a = await store.saveIntegration(baseSave());
    const cipherA = (
      m
        .db!.prepare('SELECT credentials_encrypted FROM tenant_integrations WHERE id = ?')
        .get(a.id) as { credentials_encrypted: Buffer }
    ).credentials_encrypted;
    await store.saveIntegration({
      ...baseSave(),
      credentials: { secret_key: 'totally-different-key' },
    });
    const cipherB = (
      m
        .db!.prepare('SELECT credentials_encrypted FROM tenant_integrations WHERE id = ?')
        .get(a.id) as { credentials_encrypted: Buffer }
    ).credentials_encrypted;
    expect(cipherA.equals(cipherB)).toBe(false);
  });

  it('label differente → distinct rows (multi-instance per provider)', async () => {
    await store.saveIntegration({ ...baseSave(), label: 'Live' });
    await store.saveIntegration({ ...baseSave(), label: 'Test' });
    const all = m.db!.prepare('SELECT id FROM tenant_integrations').all();
    expect(all).toHaveLength(2);
  });

  it('rotation aggiorna updated_at', async () => {
    const a = await store.saveIntegration(baseSave());
    const tBefore = (
      m.db!.prepare('SELECT updated_at FROM tenant_integrations WHERE id = ?').get(a.id) as {
        updated_at: string;
      }
    ).updated_at;
    await new Promise((r) => setTimeout(r, 10));
    await store.saveIntegration(baseSave());
    const tAfter = (
      m.db!.prepare('SELECT updated_at FROM tenant_integrations WHERE id = ?').get(a.id) as {
        updated_at: string;
      }
    ).updated_at;
    expect(tAfter >= tBefore).toBe(true);
  });
});

describe('saveIntegration — validation', () => {
  it('tenantId missing → throw', async () => {
    await expect(store.saveIntegration({ ...baseSave(), tenantId: '' })).rejects.toThrow(
      /tenantId/u,
    );
  });

  it('provider missing → throw', async () => {
    await expect(
      store.saveIntegration({ ...baseSave(), provider: undefined as never }),
    ).rejects.toThrow(/provider/u);
  });

  it('credentials non-object → throw', async () => {
    await expect(
      store.saveIntegration({ ...baseSave(), credentials: 'string' as never }),
    ).rejects.toThrow(/credentials/u);
  });

  it('credentials null → throw', async () => {
    await expect(
      store.saveIntegration({ ...baseSave(), credentials: null as never }),
    ).rejects.toThrow();
  });
});

describe('getIntegration — decrypt + last_used_at touch', () => {
  it('happy path: ritorna credentials decifrate', () => {
    return store.saveIntegration(baseSave()).then(() => {
      const got = store.getIntegration({ provider: 'stripe', tenantId: 'tA', label: 'Live' });
      expect(got).not.toBeNull();
      expect(got!.credentials).toEqual({
        secret_key: 'sk_live_secret_abc123',
        publishable_key: 'pk_live_xyz',
      });
    });
  });

  it('last_used_at viene aggiornato post-get', async () => {
    await store.saveIntegration(baseSave());
    expect(
      (
        m.db!.prepare('SELECT last_used_at FROM tenant_integrations').get() as {
          last_used_at: string | null;
        }
      ).last_used_at,
    ).toBeNull();
    store.getIntegration({ provider: 'stripe', tenantId: 'tA', label: 'Live' });
    const after = (
      m.db!.prepare('SELECT last_used_at FROM tenant_integrations').get() as {
        last_used_at: string | null;
      }
    ).last_used_at;
    expect(after).not.toBeNull();
  });

  it('not found → null', async () => {
    await store.saveIntegration(baseSave());
    expect(store.getIntegration({ provider: 'gmail', tenantId: 'tA' })).toBeNull();
  });

  it('🚨 cross-tenant: tenant B su credenziali A → null', async () => {
    await store.saveIntegration({ ...baseSave(), tenantId: 'tA' });
    expect(store.getIntegration({ provider: 'stripe', tenantId: 'tB', label: 'Live' })).toBeNull();
  });

  it('tenantId vuoto → throw', () => {
    expect(() => store.getIntegration({ provider: 'stripe', tenantId: '' })).toThrow(/tenantId/u);
  });

  it('label null vs label "" → entrambi cercano label NULL', async () => {
    const { label: _omitLabel, ...withoutLabel } = baseSave();
    void _omitLabel;
    await store.saveIntegration(withoutLabel);
    expect(
      store.getIntegration({ provider: 'stripe', tenantId: 'tA', label: null }),
    ).not.toBeNull();
    expect(store.getIntegration({ provider: 'stripe', tenantId: 'tA', label: '' })).not.toBeNull();
  });
});

describe('updateIntegrationCredentials — OAuth refresh path', () => {
  it('happy path: cipher rotato, no audit row (debug log only)', async () => {
    const a = await store.saveIntegration(baseSave());
    m.auditAppend.mockReset();
    const cipherBefore = (
      m
        .db!.prepare('SELECT credentials_encrypted FROM tenant_integrations WHERE id = ?')
        .get(a.id) as { credentials_encrypted: Buffer }
    ).credentials_encrypted;
    const ok = await store.updateIntegrationCredentials({
      id: a.id,
      tenantId: 'tA',
      credentials: { access_token: 'NEW-ACCESS', refresh_token: 'RT' },
      expiresAt: 99999,
    });
    expect(ok).toBe(true);
    const cipherAfter = (
      m
        .db!.prepare('SELECT credentials_encrypted FROM tenant_integrations WHERE id = ?')
        .get(a.id) as { credentials_encrypted: Buffer }
    ).credentials_encrypted;
    expect(cipherAfter.equals(cipherBefore)).toBe(false);
    // get conferma decrypt nuove creds
    const got = store.getIntegration({ provider: 'stripe', tenantId: 'tA', label: 'Live' });
    expect(got!.credentials).toEqual({ access_token: 'NEW-ACCESS', refresh_token: 'RT' });
    expect(got!.expiresAt).toBe(99999);
    // audit NON viene chiamato dal refresh
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('🚨 cross-tenant: tenant B → 0 changes (false)', async () => {
    const a = await store.saveIntegration({ ...baseSave(), tenantId: 'tA' });
    const ok = await store.updateIntegrationCredentials({
      id: a.id,
      tenantId: 'tB',
      credentials: { stolen: true },
    });
    expect(ok).toBe(false);
  });

  it('id inesistente → false', async () => {
    const ok = await store.updateIntegrationCredentials({
      id: 'fake',
      tenantId: 'tA',
      credentials: {},
    });
    expect(ok).toBe(false);
  });

  it('id missing → throw', async () => {
    await expect(
      store.updateIntegrationCredentials({
        id: '',
        tenantId: 'tA',
        credentials: {},
      }),
    ).rejects.toThrow(/id/u);
  });
});

describe('deleteIntegration', () => {
  it('happy path → 1 change + audit integration.delete', async () => {
    const a = await store.saveIntegration(baseSave());
    m.auditAppend.mockReset();
    const n = await store.deleteIntegration({ id: a.id, tenantId: 'tA', actorId: 'admin-1' });
    expect(n).toBe(1);
    expect(m.db!.prepare('SELECT COUNT(*) AS c FROM tenant_integrations').get()).toEqual({ c: 0 });
    expect(m.auditAppend.mock.calls[0]![0]).toMatchObject({
      action: 'integration.delete',
      actorId: 'admin-1',
      metadata: { provider: 'stripe', label: 'Live' },
    });
  });

  it('id inesistente → 0', async () => {
    const n = await store.deleteIntegration({ id: 'fake', tenantId: 'tA' });
    expect(n).toBe(0);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('🚨 cross-tenant: tenant B → 0 (audit NON emesso, row persiste)', async () => {
    const a = await store.saveIntegration({ ...baseSave(), tenantId: 'tA' });
    m.auditAppend.mockReset();
    const n = await store.deleteIntegration({ id: a.id, tenantId: 'tB' });
    expect(n).toBe(0);
    expect(m.auditAppend).not.toHaveBeenCalled();
    expect(m.db!.prepare('SELECT COUNT(*) AS c FROM tenant_integrations').get()).toEqual({ c: 1 });
  });

  it('id missing → throw', async () => {
    await expect(store.deleteIntegration({ id: '', tenantId: 'tA' })).rejects.toThrow(/id/u);
  });
});

describe('listIntegrations — metadata only, tenant-scoped', () => {
  it('vuoto → []', () => {
    expect(store.listIntegrations('tA')).toEqual([]);
  });

  it('🚨 NO credentials_encrypted nel payload', async () => {
    await store.saveIntegration(baseSave());
    const list = store.listIntegrations('tA');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('credentials');
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('provider');
    expect(list[0]).toHaveProperty('label');
  });

  it('ordinato per provider ASC, updated_at DESC', async () => {
    await store.saveIntegration({ ...baseSave(), provider: 'stripe', label: 'A' });
    await new Promise((r) => setTimeout(r, 10));
    await store.saveIntegration({ ...baseSave(), provider: 'stripe', label: 'B' });
    await new Promise((r) => setTimeout(r, 10));
    await store.saveIntegration({ ...baseSave(), provider: 'gmail', label: 'Gmail' });
    const list = store.listIntegrations('tA');
    expect(list[0]!.provider).toBe('gmail');
    expect(list[1]!.provider).toBe('stripe');
    // entro stesso provider: updated DESC → label B viene prima (insert dopo)
    expect(list[1]!.label).toBe('B');
    expect(list[2]!.label).toBe('A');
  });

  it('tenant isolation: tA list NON include row di tB', async () => {
    await store.saveIntegration({ ...baseSave(), tenantId: 'tA' });
    await store.saveIntegration({ ...baseSave(), tenantId: 'tB' });
    expect(store.listIntegrations('tA')).toHaveLength(1);
    expect(store.listIntegrations('tB')).toHaveLength(1);
  });

  it('tenantId vuoto → throw', () => {
    expect(() => store.listIntegrations('')).toThrow(/tenantId/u);
  });
});
