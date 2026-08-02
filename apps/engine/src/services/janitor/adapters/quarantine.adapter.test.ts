/**
 * Test 2026-grade — QuarantineGatewayAdapter (cross-DB quarantine bus).
 *
 * Coverage REALE:
 *  - ensureSchema cache: secondo call su stesso dataSourceRef → no createSchema
 *  - 🚨 engine non SQL (mongodb/redis) → throw esplicito
 *  - Schema esistente (query LIMIT 1 ok) → no createSchema
 *  - Schema assente (query throw) → createSchema via applyMigration con 1
 *    create_table + 5 add_index (including UNIQUE dedup)
 *  - quarantineRow: insert + delete su live, dataSourceRef in payload,
 *    tenant_id=null se row senza tenantId
 *  - 🚨 SQL injection guard: originalTable con char proibiti → throw
 *  - 🚨 INSERT UNIQUE conflict (idempotent crash recovery) → swallow + delete
 *  - INSERT errore non-UNIQUE → throw
 *  - list: filter table/tenantId/ruleId/severity/cursor applicati, limit cap 500
 *  - list senza dataSourceRef → ricade su 'system'
 *  - stats: count totale + groupBy table/rule/severity, executeRaw assente →
 *    stats vuote, mongodb → stats vuote
 *  - restore: INSERT su original_table + DELETE da quarantine; FK fail → throw
 *    con "resta in quarantine"
 *  - 🚨 restore: assertSafeIdentifier su original_table letta dal row (defense
 *    in depth contro DB compromesso)
 *  - purge: DELETE su quarantine; affectedRows=0 → throw not-found
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuarantineGatewayAdapter } from './quarantine.adapter.js';
import type { DataSourceRef, DetectedRow } from '@/services/janitor/domain/index.js';

vi.mock('@/lib/logger.js');

const SYS = 'system' as DataSourceRef;
const TENANT = 'tenant:t1:orders' as DataSourceRef;

function makeAdapter(
  over: Partial<{
    engine: string;
    query: (...a: unknown[]) => unknown;
    insert: (...a: unknown[]) => unknown;
    delete: (...a: unknown[]) => unknown;
    executeRaw: ((sql: string) => unknown) | undefined;
    applyMigration: (...a: unknown[]) => unknown;
  }> = {},
): Record<string, unknown> {
  return {
    engine: over.engine ?? 'sqlite',
    query: vi.fn(over.query ?? (async () => ({ rows: [] }))),
    insert: vi.fn(over.insert ?? (async () => ({}))),
    delete: vi.fn(over.delete ?? (async () => ({ affectedRows: 1 }))),
    executeRaw:
      'executeRaw' in over
        ? over.executeRaw === undefined
          ? undefined
          : vi.fn(over.executeRaw)
        : vi.fn(async () => ({ rows: [] })),
    applyMigration: vi.fn(over.applyMigration ?? (async () => ({ sql: '', affectedTables: [] }))),
    connect: vi.fn(async () => {
      /* noop */
    }),
    introspect: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    previewMigration: vi.fn(async () => ''),
    transaction: undefined,
  };
}

interface Resolver {
  resolve: (ref: DataSourceRef) => Promise<unknown>;
}

function makeResolver(adapter: unknown): Resolver {
  return { resolve: vi.fn(async () => adapter) };
}

beforeEach(() => {
  // vitest auto-reset
});

describe('ensureSchema — caching + engine guard', () => {
  it('engine non-SQL (mongodb) → throw esplicito', async () => {
    const adapter = makeAdapter({ engine: 'mongodb' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.ensureSchema(SYS)).rejects.toThrow(/non supporta SQL/u);
  });

  it('engine redis → throw', async () => {
    const adapter = makeAdapter({ engine: 'redis' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.ensureSchema(SYS)).rejects.toThrow();
  });

  it('schema esistente (query ok) → NO applyMigration', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.ensureSchema(SYS);
    expect(adapter.applyMigration).not.toHaveBeenCalled();
  });

  it('schema assente (query throw "no such table") → applyMigration chiamato', async () => {
    const adapter = makeAdapter({
      query: async () => {
        throw new Error('no such table');
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.ensureSchema(SYS);
    expect(adapter.applyMigration).toHaveBeenCalledTimes(1);
    const actions = (adapter.applyMigration as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as Record<string, unknown>[];
    expect(actions[0]!.kind).toBe('create_table');
    const indexes = actions.filter((a) => a.kind === 'add_index');
    expect(indexes).toHaveLength(5); // table + rule + severity + tenant + UNIQUE dedup
    // 🚨 UNIQUE dedup index present (anti-duplicate quarantine)
    const unique = indexes.find((a) => (a.index as Record<string, unknown>).unique === true);
    expect(unique).toBeDefined();
  });

  it('cache: seconda chiamata stesso ref → adapter NON re-resolve schema check', async () => {
    let queryCalls = 0;
    const adapter = makeAdapter({
      query: async () => {
        queryCalls += 1;
        return { rows: [] };
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.ensureSchema(SYS);
    await gw.ensureSchema(SYS);
    expect(queryCalls).toBe(1); // solo prima chiamata
  });

  it('cache scoped per ref: SYS poi TENANT → 2 query check', async () => {
    let queryCalls = 0;
    const adapter = makeAdapter({
      query: async () => {
        queryCalls += 1;
        return { rows: [] };
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.ensureSchema(SYS);
    await gw.ensureSchema(TENANT);
    expect(queryCalls).toBe(2);
  });
});

const sampleRow: DetectedRow = Object.freeze({
  id: 'row-42',
  reason: 'orphan FK',
  severity: 'critical',
  raw: Object.freeze({ id: 'row-42', user_id: 'gone' }),
  tenantId: 't1',
});

describe('quarantineRow — happy path + idempotency', () => {
  it('happy path: INSERT in quarantine + DELETE da live', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }), // schema ensured
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.quarantineRow({
      originalTable: 'users',
      pkColumn: 'id',
      row: sampleRow,
      ruleId: 'janitor.test.fk',
      dataSourceRef: SYS,
      triggeredBy: 'cron',
    });
    expect(adapter.insert).toHaveBeenCalledTimes(1);
    expect(adapter.delete).toHaveBeenCalledTimes(1);
    const insertArgs = (adapter.insert as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    expect(insertArgs[0]).toBe('quarantined_rows');
    const payload = insertArgs[1] as Record<string, unknown>;
    expect(payload.original_id).toBe('row-42');
    expect(payload.original_table).toBe('users');
    expect(payload.tenant_id).toBe('t1');
    expect(payload.severity).toBe('critical');
    expect(payload.rule_id).toBe('janitor.test.fk');
    expect(payload.data_source_ref).toBe(SYS);
    expect(typeof payload.raw_json).toBe('string');
    expect(JSON.parse(payload.raw_json as string)).toEqual({ id: 'row-42', user_id: 'gone' });
  });

  it('row senza tenantId → tenant_id=null nel payload', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    const noTenant: DetectedRow = Object.freeze({
      id: 'x',
      reason: 'r',
      severity: 'warning',
      raw: Object.freeze({}),
    });
    await gw.quarantineRow({
      originalTable: 'logs',
      pkColumn: 'id',
      row: noTenant,
      ruleId: 'janitor.test.r',
      dataSourceRef: SYS,
      triggeredBy: 'cron',
    });
    const payload = (adapter.insert as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(payload.tenant_id).toBeNull();
  });

  it('🚨 SQL injection: originalTable con apostrofo → throw assertSafeIdentifier', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(
      gw.quarantineRow({
        originalTable: "users'; DROP TABLE foo;--",
        pkColumn: 'id',
        row: sampleRow,
        ruleId: 'r',
        dataSourceRef: SYS,
        triggeredBy: 'cron',
      }),
    ).rejects.toThrow(/non sicuro/u);
  });

  it('🚨 pkColumn invalido → throw', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(
      gw.quarantineRow({
        originalTable: 'users',
        pkColumn: 'id; DROP',
        row: sampleRow,
        ruleId: 'r',
        dataSourceRef: SYS,
        triggeredBy: 'cron',
      }),
    ).rejects.toThrow(/non sicuro/u);
  });

  it('🚨 INSERT UNIQUE conflict (crash recovery) → swallow + proceed con DELETE', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }),
      insert: async () => {
        throw new Error('UNIQUE constraint failed: quarantined_rows.dedup');
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.quarantineRow({
      originalTable: 'users',
      pkColumn: 'id',
      row: sampleRow,
      ruleId: 'r',
      dataSourceRef: SYS,
      triggeredBy: 'cron',
    });
    expect(adapter.delete).toHaveBeenCalledTimes(1);
  });

  it('🚨 INSERT errore "duplicate" → swallow (Postgres style)', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }),
      insert: async () => {
        throw new Error('duplicate key violates');
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.quarantineRow({
      originalTable: 'u',
      pkColumn: 'id',
      row: sampleRow,
      ruleId: 'r',
      dataSourceRef: SYS,
      triggeredBy: 't',
    });
    expect(adapter.delete).toHaveBeenCalled();
  });

  it('INSERT errore NON-UNIQUE → throw', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }),
      insert: async () => {
        throw new Error('connection lost');
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(
      gw.quarantineRow({
        originalTable: 'u',
        pkColumn: 'id',
        row: sampleRow,
        ruleId: 'r',
        dataSourceRef: SYS,
        triggeredBy: 't',
      }),
    ).rejects.toThrow(/connection lost/u);
    expect(adapter.delete).not.toHaveBeenCalled();
  });
});

describe('list — filter + limit cap', () => {
  it('senza dataSourceRef → ricade su system', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const resolver = makeResolver(adapter);
    const gw = new QuarantineGatewayAdapter(resolver as never);
    await gw.list({});
    expect(resolver.resolve).toHaveBeenCalledWith(SYS);
  });

  it('engine non-SQL → ritorna [] vuoto (no throw)', async () => {
    const adapter = makeAdapter({ engine: 'mongodb' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    const r = await gw.list({});
    expect(r).toEqual([]);
  });

  it('filters table/tenantId/ruleId/severity/cursor applicati', async () => {
    let capturedFilters: { column: string; op: string; value: unknown }[] = [];
    const adapter = makeAdapter({
      query: async (spec: unknown) => {
        capturedFilters = (spec as { filters: { column: string; op: string; value: unknown }[] })
          .filters;
        return { rows: [] };
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.list({
      dataSourceRef: SYS,
      table: 'orders',
      tenantId: 't1',
      ruleId: 'r-1',
      severity: 'critical',
      cursor: 100,
    });
    const cols = capturedFilters.map((f) => f.column);
    expect(cols).toContain('original_table');
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('rule_id');
    expect(cols).toContain('severity');
    const cursorFilter = capturedFilters.find((f) => f.column === 'id');
    expect(cursorFilter).toBeDefined();
    expect(cursorFilter!.op).toBe('lt');
  });

  it('limit cap 500 (no DoS)', async () => {
    let capturedLimit = 0;
    const adapter = makeAdapter({
      query: async (spec: unknown) => {
        capturedLimit = (spec as { limit: number }).limit;
        return { rows: [] };
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.list({ dataSourceRef: SYS, limit: 999999 });
    expect(capturedLimit).toBe(500);
  });

  it('limit default 100 se non specificato', async () => {
    let capturedLimit = 0;
    const adapter = makeAdapter({
      query: async (spec: unknown) => {
        capturedLimit = (spec as { limit: number }).limit;
        return { rows: [] };
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.list({ dataSourceRef: SYS });
    expect(capturedLimit).toBe(100);
  });

  it('rows mapped a QuarantineRecord shape', async () => {
    const adapter = makeAdapter({
      query: async () => ({
        rows: [
          {
            id: 5,
            original_id: 'x',
            original_table: 't',
            tenant_id: 'tA',
            data_source_ref: SYS,
            quarantined_at: '2026',
            quarantined_by: 'cron',
            rule_id: 'r',
            severity: 'warning',
            reason: 'why',
            raw_json: '{}',
          },
        ],
      }),
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    const r = await gw.list({ dataSourceRef: SYS });
    expect(r[0]!.id).toBe(5);
    expect(r[0]!.severity).toBe('warning');
    expect(r[0]!.ruleId).toBe('r');
  });
});

describe('stats', () => {
  it('engine non-SQL → stats vuote', async () => {
    const adapter = makeAdapter({ engine: 'mongodb' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    const s = await gw.stats(SYS);
    expect(s).toEqual({
      total: 0,
      byTable: {},
      byRule: {},
      bySeverity: { critical: 0, warning: 0 },
    });
  });

  it('executeRaw assente → throw', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }),
      executeRaw: undefined,
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.stats(SYS)).rejects.toThrow(/executeRaw/u);
  });

  it('aggrega total + byTable + byRule + bySeverity', async () => {
    let callIdx = 0;
    const responses = [
      { rows: [{ c: 10 }] }, // total
      {
        rows: [
          { k: 'users', c: 7 },
          { k: 'orders', c: 3 },
        ],
      }, // byTable
      {
        rows: [
          { k: 'r1', c: 5 },
          { k: 'r2', c: 5 },
        ],
      }, // byRule
      {
        rows: [
          { k: 'critical', c: 6 },
          { k: 'warning', c: 4 },
        ],
      }, // bySeverity
    ];
    const adapter = makeAdapter({
      query: async () => ({ rows: [] }),
      executeRaw: async () => {
        const r = responses[callIdx];
        callIdx += 1;
        return r;
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    const s = await gw.stats(SYS);
    expect(s.total).toBe(10);
    expect(s.byTable).toEqual({ users: 7, orders: 3 });
    expect(s.byRule).toEqual({ r1: 5, r2: 5 });
    expect(s.bySeverity).toEqual({ critical: 6, warning: 4 });
  });

  it('default dataSourceRef = system se non specificato', async () => {
    const adapter = makeAdapter({ engine: 'mongodb' });
    const resolver = makeResolver(adapter);
    const gw = new QuarantineGatewayAdapter(resolver as never);
    await gw.stats();
    expect(resolver.resolve).toHaveBeenCalledWith(SYS);
  });
});

describe('restore', () => {
  const quarantineRow = {
    id: 42,
    original_id: 'r1',
    original_table: 'users',
    tenant_id: 't1',
    data_source_ref: SYS,
    quarantined_at: '2026',
    quarantined_by: 'cron',
    rule_id: 'r',
    severity: 'warning',
    reason: 'why',
    raw_json: '{"id":"r1","name":"X"}',
  };

  it('happy path: INSERT su original_table + DELETE da quarantine', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [quarantineRow] }),
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.restore(42, SYS);
    const insertCalls = (adapter.insert as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(insertCalls[0]![0]).toBe('users');
    expect(insertCalls[0]![1]).toEqual({ id: 'r1', name: 'X' });
    expect(adapter.delete).toHaveBeenCalledWith('quarantined_rows', { id: 42 });
  });

  it('quarantine id non trovato → throw', async () => {
    const adapter = makeAdapter({ query: async () => ({ rows: [] }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.restore(999, SYS)).rejects.toThrow(/non trovato/u);
  });

  it('🚨 INSERT FK fail → throw "resta in quarantine" + NO delete', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [quarantineRow] }),
      insert: async () => {
        throw new Error('FK violation');
      },
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.restore(42, SYS)).rejects.toThrow(/resta in quarantine/u);
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('🚨 original_table dal row con char proibiti → throw assertSafeIdentifier', async () => {
    const adapter = makeAdapter({
      query: async () => ({ rows: [{ ...quarantineRow, original_table: "users';--" }] }),
    });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.restore(42, SYS)).rejects.toThrow(/non sicuro/u);
  });

  it('engine non-SQL → throw', async () => {
    const adapter = makeAdapter({ engine: 'mongodb' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.restore(42, SYS)).rejects.toThrow(/non supportato/u);
  });
});

describe('purge', () => {
  it('DELETE su quarantined_rows con id', async () => {
    const adapter = makeAdapter({ delete: async () => ({ affectedRows: 1 }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await gw.purge(7, SYS);
    expect(adapter.delete).toHaveBeenCalledWith('quarantined_rows', { id: 7 });
  });

  it('affectedRows=0 → throw not found', async () => {
    const adapter = makeAdapter({ delete: async () => ({ affectedRows: 0 }) });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.purge(99, SYS)).rejects.toThrow(/non trovato/u);
  });

  it('engine non-SQL → throw', async () => {
    const adapter = makeAdapter({ engine: 'redis' });
    const gw = new QuarantineGatewayAdapter(makeResolver(adapter) as never);
    await expect(gw.purge(1, SYS)).rejects.toThrow(/non supportato/u);
  });
});
