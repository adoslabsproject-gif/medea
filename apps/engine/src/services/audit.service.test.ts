/**
 * Test 2026-grade — AuditLogService (hash chain SHA-256 immutability).
 *
 * INTEGRITY: prevHash + sequential SHA-256 → tampering detection.
 * GENESIS: first entry prevHash = 'GENESIS' literal.
 * VERIFY: replay hash chain → brokenAt index su mismatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let stateRows: any[] = [];
const dbMock = {
  select: () => ({
    from: () => ({
      orderBy: (_col: any) => ({
        limit: (_n: number) =>
          Promise.resolve([...stateRows].sort((a, b) => b.id - a.id).slice(0, 1)),
      }),
      // chain for verify (no limit)
    }),
  }),
  insert: (_table: any) => ({
    values: (v: any) => {
      stateRows.push({ id: stateRows.length + 1, ...v });
      return Promise.resolve();
    },
  }),
};

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ db: dbMock }),
}));
vi.mock('@/storage/schema.js', () => ({
  auditLog: { id: 'id', $inferInsert: {} },
}));
vi.mock('drizzle-orm', () => ({
  desc: (c: any) => c,
}));

const { AuditLogService } = await import('./audit.service.js');

beforeEach(() => {
  stateRows = [];
  // Reset default select per ogni test (i test successivi possono sovrascriverlo)
  dbMock.select = () =>
    ({
      from: () => ({
        orderBy: (_col: any) => ({
          limit: (_n: number) =>
            Promise.resolve([...stateRows].sort((a, b) => b.id - a.id).slice(0, 1)),
        }),
      }),
    }) as any;
});

describe('🚨 append — hash chain', () => {
  it('🚨 first entry: prevHash = GENESIS literal', async () => {
    await new AuditLogService().append({ action: 'user.login', resourceType: 'session' });
    expect(stateRows[0].prevHash).toBe('GENESIS');
    expect(stateRows[0].hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('🚨 sequenza: prevHash[i] === hash[i-1]', async () => {
    const svc = new AuditLogService();
    await svc.append({ action: 'a', resourceType: 'r' });
    const first = stateRows[0];
    // Mock db.select to return last row for next append
    dbMock.select = () =>
      ({
        from: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([first]) }),
        }),
      }) as any;
    await svc.append({ action: 'b', resourceType: 'r' });
    expect(stateRows[1].prevHash).toBe(first.hash);
  });

  it('🚨 default tenantId="default" + actorId="system" applicati in hash chain', async () => {
    await new AuditLogService().append({ action: 'a', resourceType: 'r' });
    const row = stateRows[0];
    // L'hash è 64-char hex (SHA-256) e prevHash è 'GENESIS' (default actor/tenant).
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.prevHash).toBe('GENESIS');
    expect(row.metadataJson).toBe('{}'); // metadata default vuoto
  });

  it('🚨 metadata serializzato in JSON', async () => {
    await new AuditLogService().append({
      action: 'a',
      resourceType: 'r',
      metadata: { foo: 'bar', n: 42 },
    });
    expect(stateRows[0].metadataJson).toBe('{"foo":"bar","n":42}');
  });

  it('🚨 metadata undefined → "{}"', async () => {
    await new AuditLogService().append({ action: 'a', resourceType: 'r' });
    expect(stateRows[0].metadataJson).toBe('{}');
  });

  it('🚨 tenantId explicit propagato', async () => {
    await new AuditLogService().append({
      tenantId: 't-1',
      action: 'a',
      resourceType: 'r',
    });
    expect(stateRows[0].tenantId).toBe('t-1');
  });

  it('🚨 actorId undefined → field NON inserito (default DB)', async () => {
    await new AuditLogService().append({ action: 'a', resourceType: 'r' });
    expect(stateRows[0].actorId).toBeUndefined();
  });

  it('🚨 resourceId opzionale', async () => {
    await new AuditLogService().append({
      action: 'a',
      resourceType: 'r',
      resourceId: 'res-42',
    });
    expect(stateRows[0].resourceId).toBe('res-42');
  });
});

describe('🚨 verifyIntegrity', () => {
  beforeEach(() => {
    dbMock.select = () =>
      ({
        from: () => ({
          orderBy: (_c: any) => Promise.resolve(stateRows) as any,
        }),
      }) as any;
  });

  it('🚨 chain integra → valid:true', async () => {
    const svc = new AuditLogService();
    // Append 3 entries, ricaricando il "last" mock prima di ciascuno
    for (let i = 1; i <= 3; i++) {
      const last = stateRows[stateRows.length - 1];
      dbMock.select = () =>
        ({
          from: () => ({
            orderBy: (_c: any) => ({ limit: () => Promise.resolve(last ? [last] : []) }),
          }),
        }) as any;
      await svc.append({ action: `a-${i}`, resourceType: 'r' });
    }
    // verifyIntegrity needs different mock
    dbMock.select = () =>
      ({
        from: () => ({
          orderBy: (_c: any) => Promise.resolve(stateRows) as any,
        }),
      }) as any;
    expect(await svc.verifyIntegrity()).toEqual({ valid: true });
  });

  it('🚨 hash tampered → valid:false + brokenAt = row.id', async () => {
    const svc = new AuditLogService();
    for (let i = 1; i <= 3; i++) {
      const last = stateRows[stateRows.length - 1];
      dbMock.select = () =>
        ({
          from: () => ({
            orderBy: (_c: any) => ({ limit: () => Promise.resolve(last ? [last] : []) }),
          }),
        }) as any;
      await svc.append({ action: `a-${i}`, resourceType: 'r' });
    }
    // Tamper middle row
    stateRows[1].action = 'TAMPERED';
    dbMock.select = () =>
      ({
        from: () => ({
          orderBy: (_c: any) => Promise.resolve(stateRows) as any,
        }),
      }) as any;
    const result = await svc.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('🚨 zero rows → valid:true (chain vuota OK)', async () => {
    stateRows = [];
    expect(await new AuditLogService().verifyIntegrity()).toEqual({ valid: true });
  });
});
