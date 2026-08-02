/**
 * Test 2026-grade — CheckpointService + CheckpointRecoveryService.
 *
 * DURABILITY: snapshot ogni N nodi → crash recovery resume da ultimo checkpoint.
 * RETENTION: solo l'ultimo per runId (delete older).
 * RECOVERY: orphan detection runs running + stale > 120s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';
import { first } from '@/__testkit__/assert.js';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { CheckpointService, CheckpointRecoveryService } = await import('./checkpoint.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE workflow_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      at_node_id TEXT NOT NULL,
      outputs_by_id_json TEXT NOT NULL,
      visited_json TEXT NOT NULL,
      pending_queue_json TEXT NOT NULL,
      item_graph_json TEXT,
      step_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      ended_at TEXT,
      updated_at TEXT
    );
  `);
});

function makeArgs(overrides: Partial<any> = {}) {
  return {
    runId: 'r-1',
    workflowId: 'wf-1',
    tenantId: 't-1',
    atNodeId: 'n-current',
    outputsById: new Map<string, unknown>([
      ['n-1', { value: 'a' }],
      ['n-2', 42],
    ]),
    visited: new Set(['n-1', 'n-2']),
    pendingQueue: [{ nodeId: 'n-3', carriedInput: { foo: 'bar' }, sourceNodeId: 'n-2' }],
    // GAP #2: lineage della run — il round-trip è asserito nei test sotto.
    itemGraph: new Map([
      ['n-1', [{ json: { value: 'a' }, pairedItem: { item: 0, sourceNodeId: 'n-0' } }]],
    ]),
    stepCount: 5,
    ...overrides,
  };
}

describe('🚨 save — single snapshot per run + retention', () => {
  it('🚨 happy: insert row con tutti i campi serializzati', () => {
    const svc = new CheckpointService();
    svc.save(makeArgs());
    const row = sqliteInst.prepare('SELECT * FROM workflow_checkpoints').get() as any;
    expect(row.run_id).toBe('r-1');
    expect(row.workflow_id).toBe('wf-1');
    expect(row.tenant_id).toBe('t-1');
    expect(row.at_node_id).toBe('n-current');
    expect(JSON.parse(row.outputs_by_id_json)).toEqual({ 'n-1': { value: 'a' }, 'n-2': 42 });
    expect(JSON.parse(row.visited_json)).toEqual(['n-1', 'n-2']);
    // GAP #2: sourceNodeId della pendingQueue e itemGraph round-trippano.
    expect(JSON.parse(row.pending_queue_json)).toEqual([
      { nodeId: 'n-3', carriedInput: { foo: 'bar' }, sourceNodeId: 'n-2' },
    ]);
    expect(JSON.parse(row.item_graph_json)).toEqual({
      'n-1': [{ json: { value: 'a' }, pairedItem: { item: 0, sourceNodeId: 'n-0' } }],
    });
    expect(row.step_count).toBe(5);
  });

  it("🚨 retention: 2x save → solo l'ultimo per runId resta (delete older)", () => {
    const svc = new CheckpointService();
    svc.save(makeArgs({ atNodeId: 'first', stepCount: 1 }));
    svc.save(makeArgs({ atNodeId: 'second', stepCount: 2 }));
    svc.save(makeArgs({ atNodeId: 'third', stepCount: 3 }));
    const rows = sqliteInst
      .prepare('SELECT * FROM workflow_checkpoints WHERE run_id=?')
      .all('r-1') as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].at_node_id).toBe('third');
    expect(rows[0].step_count).toBe(3);
  });

  it('🚨 retention NON cancella checkpoints di ALTRI runId', () => {
    const svc = new CheckpointService();
    svc.save(makeArgs({ runId: 'r-A', atNodeId: 'a1' }));
    svc.save(makeArgs({ runId: 'r-B', atNodeId: 'b1' }));
    svc.save(makeArgs({ runId: 'r-A', atNodeId: 'a2' }));
    const all = sqliteInst
      .prepare('SELECT run_id, at_node_id FROM workflow_checkpoints ORDER BY run_id, id')
      .all() as any[];
    expect(all.length).toBe(2);
    expect(all.find((r) => r.run_id === 'r-A').at_node_id).toBe('a2'); // ultimo A
    expect(all.find((r) => r.run_id === 'r-B').at_node_id).toBe('b1'); // unico B
  });
});

describe('🚨 latest', () => {
  it('🚨 nessun checkpoint → null', () => {
    expect(new CheckpointService().latest('no-run')).toBeNull();
  });

  it('🚨 ritorna ultimo checkpoint con mapRow corretto', () => {
    const svc = new CheckpointService();
    svc.save(makeArgs({ atNodeId: 'older' }));
    svc.save(makeArgs({ atNodeId: 'newer', stepCount: 99 }));
    const cp = svc.latest('r-1');
    expect(cp).not.toBeNull();
    expect(cp!.atNodeId).toBe('newer');
    expect(cp!.stepCount).toBe(99);
    expect(cp!.outputsById).toEqual({ 'n-1': { value: 'a' }, 'n-2': 42 });
    expect(cp!.visited).toEqual(['n-1', 'n-2']);
    expect(cp!.pendingQueue).toEqual([
      { nodeId: 'n-3', carriedInput: { foo: 'bar' }, sourceNodeId: 'n-2' },
    ]);
    // GAP #2: il lineage torna INTATTO dal round-trip (deserializzato in mapRow).
    expect(cp!.itemGraph).toEqual({
      'n-1': [{ json: { value: 'a' }, pairedItem: { item: 0, sourceNodeId: 'n-0' } }],
    });
  });

  it('🚨 riga LEGACY (item_graph_json NULL, pre-4.2) → itemGraph {} (lineage assente, mai crash)', () => {
    const svc = new CheckpointService();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-legacy', 'wf', 't', 'n', '{}', '[]', '[]', 1, '2026-01-01')`,
      )
      .run();
    const cp = svc.latest('r-legacy');
    expect(cp).not.toBeNull();
    expect(cp!.itemGraph).toEqual({});
  });
});

describe('🚨 purge', () => {
  it('🚨 happy: cancella tutti i checkpoint del run', () => {
    const svc = new CheckpointService();
    svc.save(makeArgs({ runId: 'r-purge', atNodeId: 'x' }));
    svc.purge('r-purge');
    expect(
      sqliteInst
        .prepare('SELECT COUNT(*) as n FROM workflow_checkpoints WHERE run_id=?')
        .get('r-purge'),
    ).toEqual({ n: 0 });
  });

  it('🚨 purge runId inesistente → no-op (no throw)', () => {
    expect(() => new CheckpointService().purge('nonexistent')).not.toThrow();
  });

  it('🚨 purge NON cancella altri runId', () => {
    const svc = new CheckpointService();
    svc.save(makeArgs({ runId: 'r-A' }));
    svc.save(makeArgs({ runId: 'r-B' }));
    svc.purge('r-A');
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM workflow_checkpoints').get()).toEqual({
      n: 1,
    });
  });
});

describe('🚨 findOrphanedRuns', () => {
  it('🚨 nessun orphan → []', () => {
    expect(new CheckpointService().findOrphanedRuns()).toEqual([]);
  });

  it('🚨 run "running" + checkpoint stale > 120s → orphan rilevato', () => {
    const svc = new CheckpointService();
    sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run('r-crashed', 'running');
    // Manualmente inserisco un checkpoint con created_at < threshold
    const oldTime = new Date(Date.now() - 200 * 1000).toISOString();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('r-crashed', 'wf-1', 't-1', 'n-3', '{}', '[]', '[]', 3, oldTime);
    const orphans = svc.findOrphanedRuns(120);
    expect(orphans.length).toBe(1);
    expect(first(orphans, 'orphans').runId).toBe('r-crashed');
  });

  it('🚨 run "completed" → NON orphan', () => {
    const svc = new CheckpointService();
    sqliteInst
      .prepare(`INSERT INTO runs VALUES (?, ?, ?, NULL)`)
      .run('r-done', 'completed', '2026-06-07');
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-done', 'wf', 't', 'n', '{}', '[]', '[]', 1, '2026-01-01')`,
      )
      .run();
    expect(svc.findOrphanedRuns()).toEqual([]);
  });

  it('🚨 run running fresh (< 120s) → NON orphan', () => {
    const svc = new CheckpointService();
    sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run('r-fresh', 'running');
    const recent = new Date().toISOString();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-fresh', 'wf', 't', 'n', '{}', '[]', '[]', 1, ?)`,
      )
      .run(recent);
    expect(svc.findOrphanedRuns(120)).toEqual([]);
  });

  it("🚨 multiple checkpoint per run → solo l'ultimo è considerato", () => {
    const svc = new CheckpointService();
    sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run('r-x', 'running');
    const oldTime = new Date(Date.now() - 300 * 1000).toISOString();
    const recentTime = new Date(Date.now() - 10 * 1000).toISOString();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-x', 'wf', 't', 'n1', '{}', '[]', '[]', 1, ?)`,
      )
      .run(oldTime);
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-x', 'wf', 't', 'n2', '{}', '[]', '[]', 2, ?)`,
      )
      .run(recentTime);
    // L'ultimo checkpoint è recente → NON orphan
    expect(svc.findOrphanedRuns(120)).toEqual([]);
  });

  /**
   * 🚨 AUDIT FIX WE-3 (2026-06-09 CRITICAL) — REGRESSION GUARD ATOMIC CLAIM:
   *
   * Pre-fix: findOrphanedRuns era SELECT puro → 2 chiamate consecutive
   * ritornavano lo stesso row → 2 process resume duplicato side-effect.
   *
   * Post-fix: la prima chiamata UPDATE status='recovering' atomicamente.
   * La seconda chiamata vede status='recovering' (not 'running') → 0 row.
   * Simula 2 process di recovery che concorrentemente leggono il DB.
   */
  it('🚨 [REGRESSION WE-3] atomic claim: 2 findOrphanedRuns concorrenti → solo 1 ritorna il row', () => {
    const svc = new CheckpointService();
    sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run('r-race', 'running');
    const oldTime = new Date(Date.now() - 200 * 1000).toISOString();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('r-race', 'wf', 't', 'n', '{}', '[]', '[]', 1, oldTime);

    // Process A: claim
    const orphans1 = svc.findOrphanedRuns(120);
    expect(orphans1.length).toBe(1);
    expect(first(orphans1, 'orphans1').runId).toBe('r-race');

    // Process B (rolling deploy concorrente): SECOND call → vede recovering, 0 row
    const orphans2 = svc.findOrphanedRuns(120);
    expect(orphans2.length, 'second findOrphanedRuns deve ritornare 0 (claim atomico)').toBe(0);

    // Verifica DB state: run è in stato 'recovering'
    const runAfter = sqliteInst.prepare(`SELECT status FROM runs WHERE id = ?`).get('r-race') as {
      status: string;
    };
    expect(runAfter.status).toBe('recovering');
  });

  it('🚨 [REGRESSION WE-3] run già in stato "recovering" → MAI ri-claimato', () => {
    const svc = new CheckpointService();
    // Simula: process precedente l'aveva già claimed ma è crashato a metà.
    // Il run resta in stato 'recovering' fino a manual cleanup.
    sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run('r-stuck', 'recovering');
    const oldTime = new Date(Date.now() - 300 * 1000).toISOString();
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('r-stuck', 'wf', 't', 'n', '{}', '[]', '[]', 1, oldTime);
    expect(svc.findOrphanedRuns(120)).toEqual([]);
  });

  it('🚨 [REGRESSION WE-3] 3 process paralleli su 3 runs distinti → ognuno claima 1, no overlap', () => {
    const svc = new CheckpointService();
    const oldTime = new Date(Date.now() - 200 * 1000).toISOString();
    for (const id of ['r-1', 'r-2', 'r-3']) {
      sqliteInst.prepare(`INSERT INTO runs VALUES (?, ?, NULL, NULL)`).run(id, 'running');
      sqliteInst
        .prepare(
          `INSERT INTO workflow_checkpoints
        (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, 'wf', 't', 'n', '{}', '[]', '[]', 1, oldTime);
    }
    // Una sola chiamata "process A" prende tutti
    const claimed = svc.findOrphanedRuns(120);
    expect(claimed.length).toBe(3);
    // Una seconda chiamata "process B" non prende nulla
    expect(svc.findOrphanedRuns(120)).toEqual([]);
  });
});

describe('🚨 CheckpointRecoveryService', () => {
  it('🚨 zero orphan → ritorna 0, NO log info', async () => {
    const svc = new CheckpointService();
    const resume = vi.fn();
    const recovery = new CheckpointRecoveryService(svc, resume);
    expect(await recovery.recover()).toBe(0);
    expect(resume).not.toHaveBeenCalled();
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('🚨 N orphan → resume invoked + count return', async () => {
    const svc = new CheckpointService();
    // setup 2 orphan
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-1', 'running', NULL, NULL)`).run();
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-2', 'running', NULL, NULL)`).run();
    const old = new Date(Date.now() - 200 * 1000).toISOString();
    for (const rid of ['r-1', 'r-2']) {
      sqliteInst
        .prepare(
          `INSERT INTO workflow_checkpoints
        (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
        VALUES (?, 'wf', 't', 'n', '{}', '[]', '[]', 1, ?)`,
        )
        .run(rid, old);
    }
    const resume = vi.fn().mockResolvedValue(undefined);
    const recovery = new CheckpointRecoveryService(svc, resume);
    expect(await recovery.recover()).toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      'Recovering orphaned runs from checkpoints',
    );
  });

  it('🚨 resume throw su singolo run → log error + continua altri', async () => {
    const svc = new CheckpointService();
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-bad', 'running', NULL, NULL)`).run();
    sqliteInst.prepare(`INSERT INTO runs VALUES ('r-good', 'running', NULL, NULL)`).run();
    const old = new Date(Date.now() - 200 * 1000).toISOString();
    for (const rid of ['r-bad', 'r-good']) {
      sqliteInst
        .prepare(
          `INSERT INTO workflow_checkpoints
        (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
        VALUES (?, 'wf', 't', 'n', '{}', '[]', '[]', 1, ?)`,
        )
        .run(rid, old);
    }
    const resume = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'r-bad') throw new Error('resume failed');
    });
    const recovery = new CheckpointRecoveryService(svc, resume);
    const count = await recovery.recover();
    expect(count).toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r-bad' }),
      'Checkpoint recovery failed for run',
    );
  });
});
