/**
 * AuditLogService.appendSync — test INTEGRAZIONE con better-sqlite3 REALE
 * (niente mock del DB) — finding #1.
 *
 * Perché DB reale: il bug era fire-and-forget (`void append`). Con un mock,
 * sia la versione sync-durevole sia quella void-async registrerebbero una
 * chiamata → il mock NON distingue. Solo un DB reale può asserire l'invariante
 * VERA: dopo `appendSync(...)` la riga è GIÀ persistita, nello STESSO tick
 * sincrono, senza `await`. È il mutation-verify: riportando `appendSync` a
 * `void this.append(...)` questo file diventa rosso (row count = 0).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { auditLog } from '@/storage/schema.js';

// DB reale in-memory, ricreato per ogni test.
let sqlite: Database.Database;
let drizzleDb: ReturnType<typeof drizzle>;

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite, db: drizzleDb }),
}));

const { AuditLogService } = await import('./audit.service.js');

function createAuditTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT DEFAULT 'default',
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      metadata_json TEXT,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

interface Row {
  id: number;
  tenant_id: string | null;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_json: string | null;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

const allRows = (): Row[] => sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all() as Row[];

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAuditTable(sqlite);
  drizzleDb = drizzle(sqlite, { schema: { auditLog } });
});

describe('appendSync — durabilità sincrona (mutation-verify)', () => {
  it('🚨 la riga è persistita IMMEDIATAMENTE, senza await, e ritorna void', () => {
    const svc = new AuditLogService();
    const before = (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    expect(before).toBe(0);

    const ret = svc.appendSync({
      action: 'tenant.deleted',
      resourceType: 'tenant',
      resourceId: 'acme',
    });

    // Nessun await: la riga DEVE esserci subito (fire-and-forget fallirebbe qui).
    const after = (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    expect(after).toBe(1);
    expect(ret).toBeUndefined();
  });

  it('prima entry: prev_hash = GENESIS, hash = 64 hex', () => {
    new AuditLogService().appendSync({
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: 'acme',
    });
    const [row] = allRows();
    expect(row!.prev_hash).toBe('GENESIS');
    expect(row!.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('catena: prev_hash[i] === hash[i-1] su più append sincroni', () => {
    const svc = new AuditLogService();
    svc.appendSync({ action: 'tenant.created', resourceType: 'tenant', resourceId: 'a' });
    svc.appendSync({
      action: 'tenant.suspended',
      resourceType: 'tenant',
      resourceId: 'a',
      metadata: { reason: 'x' },
    });
    svc.appendSync({ action: 'tenant.deleted', resourceType: 'tenant', resourceId: 'a' });
    const rows = allRows();
    expect(rows).toHaveLength(3);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
  });

  it('🚨 verifyIntegrity() valida la catena prodotta da appendSync (hash coerenti con append)', async () => {
    const svc = new AuditLogService();
    svc.appendSync({
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: 'a',
      metadata: { plan: 'pro' },
    });
    svc.appendSync({ action: 'tenant.deleted', resourceType: 'tenant', resourceId: 'a' });
    const res = await svc.verifyIntegrity();
    expect(res.valid).toBe(true);
    expect(res.brokenAt).toBeUndefined();
  });

  it('append (async) e appendSync interoperano nella stessa catena', async () => {
    const svc = new AuditLogService();
    await svc.append({ action: 'user.login', resourceType: 'session', resourceId: 's1' });
    svc.appendSync({ action: 'tenant.archived', resourceType: 'tenant', resourceId: 'a' });
    const res = await svc.verifyIntegrity();
    expect(res.valid).toBe(true);
    const rows = allRows();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
  });

  it('tamper detection: alterare metadata di una riga appendSync rompe la catena', async () => {
    const svc = new AuditLogService();
    svc.appendSync({ action: 'tenant.created', resourceType: 'tenant', resourceId: 'a' });
    svc.appendSync({ action: 'tenant.deleted', resourceType: 'tenant', resourceId: 'a' });
    // Manomissione diretta della prima riga.
    sqlite.prepare('UPDATE audit_log SET metadata_json = \'{"tampered":true}\' WHERE id = 1').run();
    const res = await svc.verifyIntegrity();
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it('coalescing: tenantId omesso → stored default; actorId/resourceId omessi → NULL; catena valida', async () => {
    const svc = new AuditLogService();
    svc.appendSync({ action: 'system.tick', resourceType: 'system' });
    const [row] = allRows();
    expect(row!.tenant_id).toBe('default');
    expect(row!.actor_id).toBeNull();
    expect(row!.resource_id).toBeNull();
    const res = await svc.verifyIntegrity();
    expect(res.valid).toBe(true);
  });
});
