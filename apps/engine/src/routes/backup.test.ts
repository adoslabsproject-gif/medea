/**
 * Security test — backup endpoints owner-only + column whitelist.
 *
 * Finding 2026-06-05 (broken access control, OWASP A01): /backup/export e
 * /backup/restore esponevano/sovrascrivevano `credentials`, `user_credentials`
 * e `audit_log` con la sola sessione (qualsiasi ruolo). Un `viewer` poteva
 * esfiltrare tutte le credenziali del tenant e riscrivere l'audit log.
 * Inoltre /restore interpolava nomi-colonna dal JSON utente (identifier
 * injection). Fix: requireRole('owner') + whitelist colonne via PRAGMA.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../storage/migrate.schema.js';

let db: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 't1' }));

// requireRole legge c.get('auth'): lo inietto con una pre-middleware.
const { createBackupRoutes } = await import('./backup.js');

function appAs(role: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { tenantId: 't1', role } as never);
    await next();
  });
  app.route('/api/v1', createBackupRoutes());
  return app;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

describe('backup — owner-only (broken-access-control fix)', () => {
  it('viewer → 403 su /backup/export (niente esfiltrazione credenziali)', async () => {
    const res = await appAs('viewer').request('/api/v1/backup/export');
    expect(res.status).toBe(403);
  });

  it('operator → 403 su /backup/restore (niente overwrite audit_log)', async () => {
    const res = await appAs('operator').request('/api/v1/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 't1' }),
    });
    expect(res.status).toBe(403);
  });

  it('owner → 200 su /backup/export', async () => {
    const res = await appAs('owner').request('/api/v1/backup/export');
    expect(res.status).toBe(200);
  });

  it('superadmin → 200 (bypass per supporto SaaS)', async () => {
    const res = await appAs('superadmin').request('/api/v1/backup/export');
    expect(res.status).toBe(200);
  });
});

describe('backup restore — whitelist colonne (anti identifier-injection)', () => {
  it('chiave colonna malevola nel envelope → scartata, nessuna injection', async () => {
    const envelope = {
      tenantId: 't1',
      workflows: [
        {
          id: 'w1',
          tenant_id: 't1',
          name: 'Legit',
          enabled: 1,
          schema_version: '1.0.0',
          created_at: '2026-06-05',
          updated_at: '2026-06-05',
          // Chiave malevola: senza whitelist finirebbe nella lista colonne SQL.
          'x) ; DROP TABLE workflows; --': 'pwned',
        },
      ],
    };
    const res = await appAs('owner').request('/api/v1/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: Record<string, number> };
    // Insert riuscito (count=1), NON -1 (che indicherebbe SQL error da injection).
    expect(body.restored.workflows).toBe(1);
    // La tabella esiste ancora (DROP non eseguito) e la riga è pulita.
    const row = db.prepare('SELECT id, name FROM workflows WHERE id = ?').get('w1') as
      | { id: string; name: string }
      | undefined;
    expect(row?.name).toBe('Legit');
  });

  it('cross-tenant restore → 403', async () => {
    const res = await appAs('owner').request('/api/v1/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'altro-tenant' }),
    });
    expect(res.status).toBe(403);
  });
});
