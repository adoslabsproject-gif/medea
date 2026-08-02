/**
 * Test 2026-grade — SystemEmailAccountsService (multi-tenant SMTP/IMAP/OAuth2 vault).
 *
 * Coverage REALE (DB sqlite :memory:, real encryption con dev sentinel master):
 *  - ensureTable + idempotent ALTER TABLE OAuth columns
 *  - list/getDefault/picker tenant-isolated
 *  - upsert password account: encryption SMTP+IMAP, plaintext NON in row
 *  - upsert mantiene password se input.smtp.password vuoto (COALESCE)
 *  - 🚨 default-account uniqueness: set isDefault=true → unset precedente
 *  - delete tenant-scoped
 *  - upsertOAuthAccount: provider preset smtp.gmail.com:587 STARTTLS (G secure)
 *  - resolveForExecutor: decifra plaintext, ritorna in field password
 *  - resolveOAuthForExecutor: decifra refresh+access, ritorna expiresAt Date
 *  - updateOAuthAccessToken: rotation senza ricreare row
 *  - 🚨 cross-tenant isolation: account tenantA NOT visible da tenantB
 *  - mapRow: hasPassword=true se cipher presente, false altrimenti
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/master-password.js', () => ({
  loadMasterPassword: () => ({ password: 'test-master-pw-32-bytes-min-aaaaaaaaa', source: 'env' }),
  getMasterPasswordOrThrow: () => 'test-master-pw-32-bytes-min-aaaaaaaaa',
}));

import { SystemEmailAccountsService } from './system-email-accounts.service.js';

beforeEach(() => {
  m.db = new Database(':memory:');
});

const baseUpsert = (
  tenantId = 't1',
  label = 'Marketing',
): Parameters<SystemEmailAccountsService['upsert']>[0] => ({
  tenantId,
  label,
  fromAddress: 'mkt@x.com',
  isDefault: false,
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    username: 'mkt@x.com',
    password: 'pw-strong',
  },
  imap: { host: 'imap.example.com', port: 993, username: 'mkt@x.com', password: 'imap-pw' },
});

describe('ensureTable + columns idempotency', () => {
  it('costruttore non rompe se table non esiste', () => {
    expect(() => new SystemEmailAccountsService()).not.toThrow();
  });

  it('costruttore idempotente — instanziare 2 volte non fa duplicate-column', () => {
    new SystemEmailAccountsService();
    expect(() => new SystemEmailAccountsService()).not.toThrow();
  });

  it('tabella ha colonna auth_type con default password', () => {
    new SystemEmailAccountsService();
    const cols = m.db!.prepare("PRAGMA table_info('system_email_accounts')").all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const authType = cols.find((c) => c.name === 'auth_type');
    expect(authType).toBeDefined();
    expect(authType!.dflt_value).toContain('password');
  });

  it('tabella ha colonne oauth_* (refresh + access)', () => {
    new SystemEmailAccountsService();
    const cols = m.db!.prepare("PRAGMA table_info('system_email_accounts')").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('oauth_provider');
    expect(names).toContain('oauth_refresh_ciphertext');
    expect(names).toContain('oauth_access_ciphertext');
    expect(names).toContain('oauth_expires_at');
  });
});

describe('upsert password account — happy path', () => {
  it('insert nuovo: ritorna account con id generato', () => {
    const svc = new SystemEmailAccountsService();
    const acct = svc.upsert(baseUpsert());
    expect(acct.id).toBeDefined();
    expect(acct.label).toBe('Marketing');
    expect(acct.authType).toBe('password');
    expect(acct.smtp.hasPassword).toBe(true);
    expect(acct.imap?.hasPassword).toBe(true);
    expect(acct.smtp.password).toBeUndefined(); // NON ritornato da upsert (solo resolveForExecutor)
  });

  it('🚨 plaintext password NON viene scritto nel DB row', () => {
    const svc = new SystemEmailAccountsService();
    const acct = svc.upsert(baseUpsert());
    const row = m
      .db!.prepare('SELECT * FROM system_email_accounts WHERE id = ?')
      .get(acct.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('pw-strong');
    expect(JSON.stringify(row)).not.toContain('imap-pw');
    expect(row.smtp_pw_ciphertext).toBeTruthy();
    expect(row.smtp_pw_nonce).toBeTruthy();
    expect(row.smtp_pw_auth_tag).toBeTruthy();
  });

  it('update con password vuota: mantiene cipher esistente (COALESCE)', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsert(baseUpsert());
    const rowBefore = m
      .db!.prepare('SELECT smtp_pw_ciphertext FROM system_email_accounts WHERE id = ?')
      .get(a1.id) as { smtp_pw_ciphertext: string };
    const cipherBefore = rowBefore.smtp_pw_ciphertext;

    svc.upsert(
      { ...baseUpsert(), label: 'Renamed', smtp: { ...baseUpsert().smtp, password: '' } },
      a1.id,
    );
    const rowAfter = m
      .db!.prepare('SELECT smtp_pw_ciphertext, label FROM system_email_accounts WHERE id = ?')
      .get(a1.id) as { smtp_pw_ciphertext: string; label: string };
    expect(rowAfter.label).toBe('Renamed');
    expect(rowAfter.smtp_pw_ciphertext).toBe(cipherBefore);
  });

  it('update con password nuova: cipher diverso (re-encrypted)', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsert(baseUpsert());
    const cipherBefore = (
      m
        .db!.prepare('SELECT smtp_pw_ciphertext FROM system_email_accounts WHERE id = ?')
        .get(a1.id) as { smtp_pw_ciphertext: string }
    ).smtp_pw_ciphertext;
    svc.upsert(
      { ...baseUpsert(), smtp: { ...baseUpsert().smtp, password: 'new-rotated-pw' } },
      a1.id,
    );
    const cipherAfter = (
      m
        .db!.prepare('SELECT smtp_pw_ciphertext FROM system_email_accounts WHERE id = ?')
        .get(a1.id) as { smtp_pw_ciphertext: string }
    ).smtp_pw_ciphertext;
    expect(cipherAfter).not.toBe(cipherBefore);
  });

  it('senza imap: imap colonne null', () => {
    const svc = new SystemEmailAccountsService();
    const input = baseUpsert();
    delete input.imap;
    const acct = svc.upsert(input);
    expect(acct.imap).toBeUndefined();
  });
});

describe('default-account uniqueness', () => {
  it('🚨 set isDefault=true: il precedente default viene unset', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsert({ ...baseUpsert('t1', 'A'), isDefault: true });
    const a2 = svc.upsert({ ...baseUpsert('t1', 'B'), isDefault: true });
    const a1After = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a1.id) as { is_default: number };
    const a2After = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a2.id) as { is_default: number };
    expect(a1After.is_default).toBe(0);
    expect(a2After.is_default).toBe(1);
  });

  it('default su tenant A non influisce su tenant B', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsert({ ...baseUpsert('tA', 'A'), isDefault: true });
    const a2 = svc.upsert({ ...baseUpsert('tB', 'B'), isDefault: true });
    const a1After = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a1.id) as { is_default: number };
    const a2After = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a2.id) as { is_default: number };
    expect(a1After.is_default).toBe(1);
    expect(a2After.is_default).toBe(1);
  });
});

describe('list / picker / getDefault — tenant isolation', () => {
  it('list per tenant ritorna solo i propri', () => {
    const svc = new SystemEmailAccountsService();
    svc.upsert({ ...baseUpsert('tA', 'A1') });
    svc.upsert({ ...baseUpsert('tA', 'A2') });
    svc.upsert({ ...baseUpsert('tB', 'B1') });
    expect(svc.list('tA')).toHaveLength(2);
    expect(svc.list('tB')).toHaveLength(1);
  });

  it('list ordinata: default primo + label asc', () => {
    const svc = new SystemEmailAccountsService();
    svc.upsert({ ...baseUpsert('t1', 'Zeta') });
    svc.upsert({ ...baseUpsert('t1', 'Alpha'), isDefault: true });
    const sorted = svc.list('t1');
    expect(sorted[0]!.label).toBe('Alpha');
    expect(sorted[0]!.isDefault).toBe(true);
    expect(sorted[1]!.label).toBe('Zeta');
  });

  it('picker espone solo non-secret fields', () => {
    const svc = new SystemEmailAccountsService();
    svc.upsert({ ...baseUpsert('t1') });
    const p = svc.picker('t1');
    expect(p[0]!).toHaveProperty('id');
    expect(p[0]!).toHaveProperty('label');
    expect(p[0]!).toHaveProperty('fromAddress');
    expect(p[0]!).toHaveProperty('isDefault');
    expect(p[0]!).not.toHaveProperty('smtp');
  });

  it('getDefault: ritorna null se nessuno è default', () => {
    const svc = new SystemEmailAccountsService();
    svc.upsert(baseUpsert());
    expect(svc.getDefault('t1')).toBeNull();
  });

  it("getDefault: ritorna l'account con isDefault=true", () => {
    const svc = new SystemEmailAccountsService();
    svc.upsert(baseUpsert());
    const def = svc.upsert({ ...baseUpsert('t1', 'Default'), isDefault: true });
    const d = svc.getDefault('t1');
    expect(d?.id).toBe(def.id);
  });
});

describe('resolveForExecutor — decrypt plaintext at run-time', () => {
  it('ritorna account con smtp.password plaintext decifrato', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsert(baseUpsert());
    const resolved = svc.resolveForExecutor('t1', a.id);
    expect(resolved?.smtp.password).toBe('pw-strong');
    expect(resolved?.imap?.password).toBe('imap-pw');
  });

  it('🚨 cross-tenant: tenant B NON può resolve account di tenant A', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsert({ ...baseUpsert('tA') });
    expect(svc.resolveForExecutor('tB', a.id)).toBeNull();
    expect(svc.resolveForExecutor('tA', a.id)).not.toBeNull();
  });

  it('account inesistente → null', () => {
    const svc = new SystemEmailAccountsService();
    expect(svc.resolveForExecutor('t1', 'fake-id')).toBeNull();
  });
});

describe('delete — tenant-scoped', () => {
  it('happy path: ritorna true, row sparita', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsert(baseUpsert());
    expect(svc.delete(a.id, 't1')).toBe(true);
    expect(svc.list('t1')).toHaveLength(0);
  });

  it('id inesistente → false', () => {
    const svc = new SystemEmailAccountsService();
    expect(svc.delete('fake-id', 't1')).toBe(false);
  });

  it('🚨 cross-tenant: tenant B NON può delete account tenant A', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsert({ ...baseUpsert('tA') });
    expect(svc.delete(a.id, 'tB')).toBe(false);
    expect(svc.list('tA')).toHaveLength(1); // ancora li`
  });
});

describe('upsertOAuthAccount — Google XOAUTH2', () => {
  const oauthArgs = {
    tenantId: 't1',
    label: 'My Gmail',
    fromAddress: 'me@example.com',
    isDefault: true,
    provider: 'google' as const,
    email: 'me@gmail.com',
    refreshToken: 'RT-LONG-LIVED',
    accessToken: 'AT-SHORT-LIVED',
    expiresAt: new Date('2026-06-06T11:00:00Z'),
    scope: 'gmail.send openid',
  };

  it('insert nuovo OAuth account: authType=oauth2 + preset Gmail STARTTLS 587', () => {
    const svc = new SystemEmailAccountsService();
    const acct = svc.upsertOAuthAccount(oauthArgs);
    expect(acct.authType).toBe('oauth2');
    expect(acct.smtp.host).toBe('smtp.gmail.com');
    expect(acct.smtp.port).toBe(587);
    expect(acct.smtp.security).toBe('starttls');
    expect(acct.imap?.host).toBe('imap.gmail.com');
    expect(acct.imap?.port).toBe(993);
    expect(acct.oauth?.provider).toBe('google');
    expect(acct.oauth?.email).toBe('me@gmail.com');
  });

  it('🚨 access_token e refresh_token NON in plaintext nel DB', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsertOAuthAccount(oauthArgs);
    const row = m
      .db!.prepare('SELECT * FROM system_email_accounts WHERE id = ?')
      .get(a.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('RT-LONG-LIVED');
    expect(JSON.stringify(row)).not.toContain('AT-SHORT-LIVED');
    expect(row.oauth_refresh_ciphertext).toBeTruthy();
    expect(row.oauth_access_ciphertext).toBeTruthy();
  });

  it('default uniqueness anche per OAuth: vecchio default unset', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsert({ ...baseUpsert('t1', 'SMTP'), isDefault: true });
    const a2 = svc.upsertOAuthAccount(oauthArgs);
    const r1 = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a1.id) as { is_default: number };
    const r2 = m
      .db!.prepare('SELECT is_default FROM system_email_accounts WHERE id = ?')
      .get(a2.id) as { is_default: number };
    expect(r1.is_default).toBe(0);
    expect(r2.is_default).toBe(1);
  });

  it('upsert con existingId: aggiorna in place stesso id', () => {
    const svc = new SystemEmailAccountsService();
    const a1 = svc.upsertOAuthAccount(oauthArgs);
    const a2 = svc.upsertOAuthAccount({ ...oauthArgs, existingId: a1.id, label: 'Renamed' });
    expect(a2.id).toBe(a1.id);
    expect(a2.label).toBe('Renamed');
    expect(svc.list('t1')).toHaveLength(1); // no duplicate
  });
});

describe('resolveOAuthForExecutor — decrypt tokens', () => {
  const oauthArgs = {
    tenantId: 't1',
    label: 'gmail',
    fromAddress: 'me@gmail.com',
    isDefault: false,
    provider: 'google' as const,
    email: 'me@gmail.com',
    refreshToken: 'RT-XYZ',
    accessToken: 'AT-ABC',
    expiresAt: new Date('2026-06-06T11:00:00Z'),
    scope: 'gmail.send',
  };

  it('ritorna refresh + access decifrati + expiresAt Date', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsertOAuthAccount(oauthArgs);
    const res = svc.resolveOAuthForExecutor('t1', a.id);
    expect(res).not.toBeNull();
    expect(res!.refreshToken).toBe('RT-XYZ');
    expect(res!.accessToken).toBe('AT-ABC');
    expect(res!.expiresAt).toBeInstanceOf(Date);
    expect(res!.provider).toBe('google');
    expect(res!.email).toBe('me@gmail.com');
    expect(res!.scope).toBe('gmail.send');
  });

  it('🚨 cross-tenant: tenant B non vede account OAuth di A', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsertOAuthAccount({ ...oauthArgs, tenantId: 'tA' });
    expect(svc.resolveOAuthForExecutor('tB', a.id)).toBeNull();
  });

  it('account password (non-oauth) → null', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsert(baseUpsert());
    expect(svc.resolveOAuthForExecutor('t1', a.id)).toBeNull();
  });
});

describe('updateOAuthAccessToken — token rotation', () => {
  it('aggiorna access cipher + expiresAt, refresh resta', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsertOAuthAccount({
      tenantId: 't1',
      label: 'g',
      fromAddress: 'a@b',
      isDefault: false,
      provider: 'google',
      email: 'a@b',
      refreshToken: 'RT-1',
      accessToken: 'AT-old',
      expiresAt: new Date(0),
      scope: 's',
    });
    const refreshBefore = (
      m
        .db!.prepare('SELECT oauth_refresh_ciphertext FROM system_email_accounts WHERE id = ?')
        .get(a.id) as { oauth_refresh_ciphertext: string }
    ).oauth_refresh_ciphertext;

    svc.updateOAuthAccessToken({
      tenantId: 't1',
      accountId: a.id,
      accessToken: 'AT-new',
      expiresAt: new Date('2030-01-01'),
    });

    const after = m
      .db!.prepare(
        'SELECT oauth_refresh_ciphertext, oauth_expires_at FROM system_email_accounts WHERE id = ?',
      )
      .get(a.id) as { oauth_refresh_ciphertext: string; oauth_expires_at: string };
    expect(after.oauth_refresh_ciphertext).toBe(refreshBefore); // refresh inalterato
    expect(after.oauth_expires_at).toBe(new Date('2030-01-01').toISOString());
    const resolved = svc.resolveOAuthForExecutor('t1', a.id);
    expect(resolved!.accessToken).toBe('AT-new');
    expect(resolved!.refreshToken).toBe('RT-1');
  });

  it('🚨 cross-tenant updateOAuthAccessToken non aggiorna account altrui', () => {
    const svc = new SystemEmailAccountsService();
    const a = svc.upsertOAuthAccount({
      tenantId: 'tA',
      label: 'g',
      fromAddress: 'a@b',
      isDefault: false,
      provider: 'google',
      email: 'a@b',
      refreshToken: 'RT-1',
      accessToken: 'AT-old',
      expiresAt: new Date(0),
      scope: 's',
    });
    svc.updateOAuthAccessToken({
      tenantId: 'tB',
      accountId: a.id,
      accessToken: 'AT-stolen',
      expiresAt: new Date('2030-01-01'),
    });
    const resolved = svc.resolveOAuthForExecutor('tA', a.id);
    expect(resolved!.accessToken).toBe('AT-old'); // non modificato
  });
});
