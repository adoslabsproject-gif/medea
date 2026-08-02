/**
 * Test 2026-grade — adapters/run-log-repo.sqlite.ts (append-only run log).
 *
 * 🚨 APPEND-ONLY: appendRule + appendCycle (no-op interno) — niente DELETE.
 *
 * 🚨 FILTRO MULTI-AXIS: tenantId / ruleId / successOnly / dryRunOnly / range date.
 *    Bug = leak runs di tenant-altri o omette dry-runs admin.
 *
 * 🚨 LIMIT max 500 (cap server-side — protezione DoS pagination).
 *
 * 🚨 ORDER DESC by id (più recente prima).
 *
 * 🚨 TREND BUCKETS: GROUP BY date_iso + rule_id, SUM correttamente.
 *
 * 🚨 LAST BY RULE: subquery MAX(id) per rule_id → solo ultima per regola.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type { JanitorRuleReport } from '@/services/janitor/domain/index.js';

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock('@/storage/db.js', () => ({
  getDatabase: getDatabaseMock,
}));

const { SqliteRunLogRepository } = await import('./run-log-repo.sqlite.js');
const { janitorRunLog } = await import('@/storage/schema.js');

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let repo: InstanceType<typeof SqliteRunLogRepository>;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE janitor_run_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      data_source_ref TEXT NOT NULL,
      target_table TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      rows_detected INTEGER NOT NULL DEFAULT 0,
      rows_repaired INTEGER NOT NULL DEFAULT 0,
      rows_quarantined INTEGER NOT NULL DEFAULT 0,
      rows_skipped INTEGER NOT NULL DEFAULT 0,
      critical_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      dry_run INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL,
      error_message TEXT,
      triggered_by TEXT NOT NULL
    );
  `);
  db = drizzle(sqlite, { schema: { janitorRunLog } });
  getDatabaseMock.mockReturnValue({
    db,
    conn: sqlite,
    kind: 'sqlite',
    close: () => Promise.resolve(),
  });
  repo = new SqliteRunLogRepository();
});

const mkReport = (over: Partial<JanitorRuleReport> = {}): JanitorRuleReport => ({
  cycleId: over.cycleId ?? 'cycle-1',
  ruleId: over.ruleId ?? 'rule.a',
  tenantId: over.tenantId ?? 't1',
  dataSourceRef: over.dataSourceRef ?? SYSTEM_REF,
  targetTable: over.targetTable ?? 'runs',
  startedAt: over.startedAt ?? '2026-06-08T12:00:00.000Z',
  endedAt: over.endedAt ?? '2026-06-08T12:00:05.000Z',
  durationMs: over.durationMs ?? 5000,
  rowsDetected: over.rowsDetected ?? 0,
  rowsRepaired: over.rowsRepaired ?? 0,
  rowsQuarantined: over.rowsQuarantined ?? 0,
  rowsSkipped: over.rowsSkipped ?? 0,
  bySeverity: over.bySeverity ?? { critical: 0, warning: 0 },
  dryRun: over.dryRun ?? false,
  success: over.success ?? true,
  triggeredBy: over.triggeredBy ?? 'scheduler',
  ...(over.error !== undefined ? { error: over.error } : {}),
});

describe('🚨 appendRule + listRuleReports', () => {
  it('🚨 append + list (no filtro) → ritorna inserito', async () => {
    await repo.appendRule(mkReport());
    const out = await repo.listRuleReports({});
    expect(out).toHaveLength(1);
    expect(out[0]!.ruleId).toBe('rule.a');
  });

  it('🚨 multipli append → ordinati DESC by id (più recente prima)', async () => {
    await repo.appendRule(mkReport({ ruleId: 'rule.first' }));
    await repo.appendRule(mkReport({ ruleId: 'rule.second' }));
    await repo.appendRule(mkReport({ ruleId: 'rule.third' }));
    const out = await repo.listRuleReports({});
    expect(out[0]!.ruleId).toBe('rule.third');
    expect(out[2]!.ruleId).toBe('rule.first');
  });

  it('🚨 errorMessage opzionale → undefined se non set, presente se set', async () => {
    await repo.appendRule(mkReport({ success: false, error: 'boom' }));
    const out = await repo.listRuleReports({});
    expect(out[0]!.error).toBe('boom');
  });

  it('🚨 errorMessage null in DB → undefined in output (no leak)', async () => {
    await repo.appendRule(mkReport({ success: true }));
    const out = await repo.listRuleReports({});
    expect(out[0]!.error).toBeUndefined();
  });

  it('🚨 bySeverity round-trip da critical_count/warning_count', async () => {
    await repo.appendRule(mkReport({ bySeverity: { critical: 5, warning: 2 } }));
    const out = await repo.listRuleReports({});
    expect(out[0]!.bySeverity).toEqual({ critical: 5, warning: 2 });
  });

  it('🚨 output frozen (immutability)', async () => {
    await repo.appendRule(mkReport());
    const out = await repo.listRuleReports({});
    expect(Object.isFrozen(out[0])).toBe(true);
  });
});

describe('🚨 listRuleReports — filtri', () => {
  beforeEach(async () => {
    await repo.appendRule(
      mkReport({ ruleId: 'rule.a', tenantId: 't1', success: true, dryRun: false }),
    );
    await repo.appendRule(
      mkReport({ ruleId: 'rule.a', tenantId: 't1', success: false, dryRun: false }),
    );
    await repo.appendRule(
      mkReport({ ruleId: 'rule.b', tenantId: 't1', success: true, dryRun: true }),
    );
    await repo.appendRule(
      mkReport({ ruleId: 'rule.a', tenantId: 't2', success: true, dryRun: false }),
    );
  });

  it('🚨 SECURITY: filter tenantId → no cross-tenant leak', async () => {
    const out = await repo.listRuleReports({ tenantId: 't1' });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.tenantId === 't1')).toBe(true);
  });

  it('🚨 filter ruleId', async () => {
    const out = await repo.listRuleReports({ ruleId: 'rule.a' });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.ruleId === 'rule.a')).toBe(true);
  });

  it('🚨 successOnly=true → solo success', async () => {
    const out = await repo.listRuleReports({ successOnly: true });
    expect(out.every((r) => r.success === true)).toBe(true);
  });

  it('🚨 dryRunOnly=true → solo dry runs', async () => {
    const out = await repo.listRuleReports({ dryRunOnly: true });
    expect(out.every((r) => r.dryRun === true)).toBe(true);
  });

  it('🚨 combined filter tenantId+ruleId', async () => {
    const out = await repo.listRuleReports({ tenantId: 't1', ruleId: 'rule.a' });
    expect(out).toHaveLength(2);
  });

  it('🚨 fromIso filter → solo runs >= date', async () => {
    // Tutti hanno started_at 2026-06-08
    const out1 = await repo.listRuleReports({ fromIso: '2026-06-09T00:00:00Z' });
    expect(out1).toHaveLength(0);
    const out2 = await repo.listRuleReports({ fromIso: '2026-06-01T00:00:00Z' });
    expect(out2.length).toBeGreaterThan(0);
  });

  it('🚨 toIso filter → solo runs <= date', async () => {
    const out = await repo.listRuleReports({ toIso: '2026-06-07T00:00:00Z' });
    expect(out).toHaveLength(0);
  });
});

describe('🚨 listRuleReports — limit cap', () => {
  beforeEach(async () => {
    for (let i = 0; i < 600; i++) {
      await repo.appendRule(mkReport({ ruleId: `rule.${i}` }));
    }
  });

  it('🚨 limit default 100', async () => {
    const out = await repo.listRuleReports({});
    expect(out).toHaveLength(100);
  });

  it('🚨 limit custom rispettato', async () => {
    const out = await repo.listRuleReports({ limit: 50 });
    expect(out).toHaveLength(50);
  });

  it('🚨 SECURITY: limit cap 500 (DoS guard) — chiedo 9999 ricevo 500', async () => {
    const out = await repo.listRuleReports({ limit: 9999 });
    expect(out).toHaveLength(500);
  });

  it('🚨 limit 1 (boundary)', async () => {
    const out = await repo.listRuleReports({ limit: 1 });
    expect(out).toHaveLength(1);
  });
});

describe('🚨 appendCycle — no-op simmetrico', () => {
  it('🚨 appendCycle non lancia errori (no-op interno)', async () => {
    await expect(
      repo.appendCycle({
        cycleId: 'c1',
        startedAt: '2026-06-08T12:00:00Z',
        endedAt: '2026-06-08T12:01:00Z',
        durationMs: 60_000,
        triggeredBy: 'scheduler',
        dryRun: false,
        rules: [],
        rulesExecuted: 0,
        rulesSkippedLock: 0,
        rulesSkippedDisabled: 0,
      }),
    ).resolves.not.toThrow();
  });
});

describe('🚨 trendBuckets — daily aggregate', () => {
  // 2026-07-08 fix flaky-per-data: le date erano hardcoded 2026-06-08 e il test
  // filtra `daysBack: 30` relativo a OGGI → il giorno esatto in cui (oggi - 30)
  // == 2026-06-08 il record cade sul bordo della finestra ed è escluso → 0
  // bucket → rosso solo quel giorno (bloccò il deploy). Fix: date relative a
  // "oggi" (stesso giorno per tutti e 3 → sempre dentro la finestra, il GROUP
  // BY per data resta esattamente ciò che il test verifica).
  const today = new Date().toISOString().slice(0, 10);
  beforeEach(async () => {
    // Stesso giorno (oggi), due rule diverse, due record per rule.a
    await repo.appendRule(
      mkReport({
        ruleId: 'rule.a',
        tenantId: 't1',
        startedAt: `${today}T10:00:00Z`,
        rowsQuarantined: 5,
        rowsRepaired: 2,
        success: true,
      }),
    );
    await repo.appendRule(
      mkReport({
        ruleId: 'rule.a',
        tenantId: 't1',
        startedAt: `${today}T11:00:00Z`,
        rowsQuarantined: 3,
        rowsRepaired: 1,
        success: false,
      }),
    );
    await repo.appendRule(
      mkReport({
        ruleId: 'rule.b',
        tenantId: 't1',
        startedAt: `${today}T12:00:00Z`,
        rowsQuarantined: 1,
        rowsRepaired: 0,
        success: true,
      }),
    );
  });

  it('🚨 GROUP BY date + rule → bucket aggregati', async () => {
    const out = await repo.trendBuckets({ daysBack: 30 });
    expect(out).toHaveLength(2); // rule.a + rule.b stesso giorno
    const a = out.find((b) => b.ruleId === 'rule.a');
    expect(a).toBeDefined();
    expect(a!.rowsQuarantined).toBe(8); // 5+3 SUM
    expect(a!.rowsRepaired).toBe(3); // 2+1 SUM
    expect(a!.errors).toBe(1); // 1 success=false
  });

  it('🚨 SECURITY: tenant filter applicato', async () => {
    await repo.appendRule(
      mkReport({
        ruleId: 'rule.c',
        tenantId: 't2',
        startedAt: '2026-06-08T10:00:00Z',
        rowsQuarantined: 999,
      }),
    );
    const out = await repo.trendBuckets({ tenantId: 't1', daysBack: 30 });
    // rule.c di t2 NON deve apparire
    expect(out.find((b) => b.ruleId === 'rule.c')).toBeUndefined();
  });

  it("🚨 daysBack=0 → finestra stretta: i record più vecchi dell'istante attuale sono esclusi", async () => {
    // Fix flaky-per-ora (2026-07-10): il vecchio assert `toHaveLength(0)` assumeva
    // i record a giugno-08 e "oggi"=giugno-09; dopo il fix data-relativa del
    // beforeEach (record a OGGI-T10:00) l'esito dipendeva dall'ora del giorno
    // (fromIso = Date.now()-0: se il test gira prima delle 10:00 UTC i record
    // "futuri" venivano inclusi → rosso). Ora l'asserzione è DETERMINISTICA:
    // un record del passato remoto NON cade mai nella finestra "ultime 0 giornate".
    await repo.appendRule(
      mkReport({ ruleId: 'rule.ancient', tenantId: 't1', startedAt: '2000-01-01T00:00:00Z' }),
    );
    const out = await repo.trendBuckets({ tenantId: 't1', daysBack: 0 });
    expect(out.find((b) => b.ruleId === 'rule.ancient')).toBeUndefined();
  });
});

describe('🚨 lastByRule — only latest per rule', () => {
  beforeEach(async () => {
    await repo.appendRule(mkReport({ ruleId: 'rule.a', tenantId: 't1', success: true }));
    await repo.appendRule(mkReport({ ruleId: 'rule.a', tenantId: 't1', success: false }));
    await repo.appendRule(mkReport({ ruleId: 'rule.b', tenantId: 't1', success: true }));
    await repo.appendRule(mkReport({ ruleId: 'rule.a', tenantId: 't2', success: true }));
  });

  it('🚨 ritorna max(id) per rule_id → solo ultima per regola', async () => {
    const out = await repo.lastByRule('t1');
    expect(Object.keys(out)).toHaveLength(2); // rule.a + rule.b
    expect(out['rule.a']!.success).toBe(false); // l'ULTIMA insert era success=false
  });

  it('🚨 SECURITY: filter tenant — rule.a di t2 NON visibile a t1', async () => {
    const out = await repo.lastByRule('t1');
    // Le 3 invocazioni di t1 erano 2 rule.a + 1 rule.b
    // l'ultima rule.a di t1 ha success=false; quella di t2 è success=true
    expect(out['rule.a']!.success).toBe(false);
  });

  it('🚨 tenant senza runs → {} vuoto', async () => {
    const out = await repo.lastByRule('mai-esistito');
    expect(Object.keys(out)).toHaveLength(0);
  });
});
