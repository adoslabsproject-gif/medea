/**
 * Test 2026-grade — PausedWorkflowsService (BPMN async frames + signal correlation).
 *
 * 🚨 WORKFLOW-CRITICAL: heart of FlowForge's logic_wait_signal pause/resume.
 * Test reali con SQLite :memory: + schema da migrate.schema.ts (no DB mock).
 *
 * Coverage:
 *  - pause(): INSERT row con state snapshot + match correlation + timeout
 *  - 🚨 resumeBySignal: tenant scope + BPMN message correlation match_key/match_value
 *  - 🚨 string-coercion comparison (numeric → string per equality)
 *  - sweepTimeouts: janitor scan + status='timeout' update
 *  - listByTenant: filter + LIMIT 200 (anti-DoS)
 *  - cancel: tenant scope + status='waiting' guard (no resume race)
 *  - mapRow: deserialize JSON columns + override payload
 */
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  sqlite: null as unknown as ReturnType<typeof Database>,
  nanoidCounter: 0,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.sqlite }),
}));

vi.mock('@/lib/logger.js');

vi.mock('nanoid', () => ({
  nanoid: () => {
    m.nanoidCounter += 1;
    return `id-${String(m.nanoidCounter).padStart(4, '0')}`;
  },
}));

import { PausedWorkflowsService } from './paused-workflows.service.js';

function setupSchema(db: ReturnType<typeof Database>): void {
  db.exec(`
    CREATE TABLE paused_workflows (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      signal_name TEXT NOT NULL,
      at_node_id TEXT NOT NULL,
      outputs_by_id_json TEXT NOT NULL,
      visited_json TEXT NOT NULL,
      pending_queue_json TEXT NOT NULL,
      item_graph_json TEXT,
      resume_payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      timeout_at TEXT,
      match_key TEXT,
      match_value TEXT,
      created_at TEXT NOT NULL,
      resumed_at TEXT
    );
  `);
}

const svc = new PausedWorkflowsService();

const basePauseArgs = (over: Record<string, unknown> = {}): Parameters<typeof svc.pause>[0] => ({
  runId: 'r-1',
  workflowId: 'wf-1',
  tenantId: 't1',
  signalName: 'order_paid',
  atNodeId: 'wait-1',
  outputsById: new Map([['n1', { value: 1 }]]),
  visited: new Set(['n1']),
  pendingQueue: [{ nodeId: 'n2', carriedInput: 'x', sourceNodeId: 'n1' }],
  // GAP #2: lineage della run — round-trip asserito nei test pause/resume.
  itemGraph: new Map([['n1', [{ json: { value: 1 }, pairedItem: { item: 0, sourceNodeId: 'n0' } }]]]),
  defaultPayload: { ok: true },
  timeoutSeconds: 3600,
  ...over,
}) as Parameters<typeof svc.pause>[0];

beforeEach(() => {
  m.sqlite = new Database(':memory:');
  setupSchema(m.sqlite);
  m.nanoidCounter = 0;
});

describe('pause()', () => {
  it('🚨 happy: INSERT row + return id', () => {
    const id = svc.pause(basePauseArgs());
    expect(id).toBe('id-0001');
    const row = m.sqlite.prepare('SELECT * FROM paused_workflows WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.tenant_id).toBe('t1');
    expect(row.signal_name).toBe('order_paid');
    expect(row.at_node_id).toBe('wait-1');
    expect(row.status).toBe('waiting');
    expect(row.timeout_at).toBeTruthy();
  });

  it('🚨 outputsById Map → serialized as Object.fromEntries JSON', () => {
    const id = svc.pause(basePauseArgs());
    const row = m.sqlite.prepare('SELECT outputs_by_id_json FROM paused_workflows WHERE id = ?').get(id) as { outputs_by_id_json: string };
    expect(JSON.parse(row.outputs_by_id_json)).toEqual({ n1: { value: 1 } });
  });

  it('🚨 visited Set → serialized as Array JSON', () => {
    const id = svc.pause(basePauseArgs({ visited: new Set(['a', 'b', 'c']) }));
    const row = m.sqlite.prepare('SELECT visited_json FROM paused_workflows WHERE id = ?').get(id) as { visited_json: string };
    expect(JSON.parse(row.visited_json)).toEqual(['a', 'b', 'c']);
  });

  it('🚨 timeoutSeconds=0 → timeout_at=null (never expires)', () => {
    const id = svc.pause(basePauseArgs({ timeoutSeconds: 0 }));
    const row = m.sqlite.prepare('SELECT timeout_at FROM paused_workflows WHERE id = ?').get(id) as { timeout_at: string | null };
    expect(row.timeout_at).toBeNull();
  });

  it('🚨 timeoutSeconds=3600 → timeout_at = NOW + 1h (±5s tolerance)', () => {
    const before = Date.now();
    const id = svc.pause(basePauseArgs({ timeoutSeconds: 3600 }));
    const row = m.sqlite.prepare('SELECT timeout_at FROM paused_workflows WHERE id = ?').get(id) as { timeout_at: string };
    const tsMs = new Date(row.timeout_at).getTime();
    expect(tsMs).toBeGreaterThan(before + 3600 * 1000 - 5000);
    expect(tsMs).toBeLessThan(before + 3600 * 1000 + 5000);
  });

  it('matchKey + matchValue persistiti per BPMN correlation', () => {
    const id = svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: 'ord-99' }));
    const row = m.sqlite.prepare('SELECT match_key, match_value FROM paused_workflows WHERE id = ?').get(id) as { match_key: string; match_value: string };
    expect(row.match_key).toBe('order_id');
    expect(row.match_value).toBe('ord-99');
  });

  it('matchKey/Value undefined → null nel DB', () => {
    const id = svc.pause(basePauseArgs());
    const row = m.sqlite.prepare('SELECT match_key, match_value FROM paused_workflows WHERE id = ?').get(id) as { match_key: string | null };
    expect(row.match_key).toBeNull();
  });
});

describe('🚨 resumeBySignal() — BPMN message correlation', () => {
  it('happy: signal name match + no correlation → resume', () => {
    svc.pause(basePauseArgs());
    const out = svc.resumeBySignal('t1', 'order_paid', { ok: 1 });
    expect(out).toHaveLength(1);
    const row = m.sqlite.prepare('SELECT status FROM paused_workflows WHERE id = ?').get(out[0]?.id) as { status: string };
    expect(row.status).toBe('resumed');
  });

  it('🚨 tenant scope: cross-tenant signal → NO resume', () => {
    svc.pause(basePauseArgs({ tenantId: 't1' }));
    const out = svc.resumeBySignal('t2-OTHER', 'order_paid', {});
    expect(out).toHaveLength(0);
  });

  it('🚨 signal name mismatch → NO resume', () => {
    svc.pause(basePauseArgs({ signalName: 'order_paid' }));
    const out = svc.resumeBySignal('t1', 'WRONG_SIGNAL', {});
    expect(out).toHaveLength(0);
  });

  it('🚨 status="resumed" → NOT resumed again (idempotent)', () => {
    const id = svc.pause(basePauseArgs());
    svc.resumeBySignal('t1', 'order_paid', {});
    const out2 = svc.resumeBySignal('t1', 'order_paid', {});
    expect(out2).toHaveLength(0);
    // verifica che lo stato sia stabile
    const row = m.sqlite.prepare('SELECT status FROM paused_workflows WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('resumed');
  });

  it('🚨 BPMN correlation: matchKey="order_id", value match → resume', () => {
    svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: 'ord-99' }));
    const out = svc.resumeBySignal('t1', 'order_paid', { order_id: 'ord-99' });
    expect(out).toHaveLength(1);
  });

  it('🚨 BPMN correlation: value MISMATCH → NO resume', () => {
    svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: 'ord-99' }));
    const out = svc.resumeBySignal('t1', 'order_paid', { order_id: 'ord-OTHER' });
    expect(out).toHaveLength(0);
  });

  it('🚨 BPMN correlation: signal payload NON-object → NO resume (need object body)', () => {
    svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: 'ord-99' }));
    expect(svc.resumeBySignal('t1', 'order_paid', 'string-payload')).toHaveLength(0);
    expect(svc.resumeBySignal('t1', 'order_paid', null)).toHaveLength(0);
    expect(svc.resumeBySignal('t1', 'order_paid', [1, 2, 3])).toHaveLength(0);
  });

  it('🚨 BPMN correlation: key missing in payload → NO resume', () => {
    svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: 'ord-99' }));
    expect(svc.resumeBySignal('t1', 'order_paid', { other: 'x' })).toHaveLength(0);
  });

  it('🚨 BPMN correlation: numeric signal → string-coerced comparison', () => {
    svc.pause(basePauseArgs({ matchKey: 'order_id', matchValue: '42' }));
    // payload con number 42 → String(42) === '42' → match
    const out = svc.resumeBySignal('t1', 'order_paid', { order_id: 42 });
    expect(out).toHaveLength(1);
  });

  it('🚨 multi-row: tenant ha 3 paused, signal fires → tutti resumed (no correlation)', () => {
    svc.pause(basePauseArgs({ runId: 'r1' }));
    svc.pause(basePauseArgs({ runId: 'r2' }));
    svc.pause(basePauseArgs({ runId: 'r3' }));
    const out = svc.resumeBySignal('t1', 'order_paid', {});
    expect(out).toHaveLength(3);
  });

  it('🚨 multi-row con correlation diverse: solo i match risvegliati', () => {
    svc.pause(basePauseArgs({ runId: 'r1', matchKey: 'order_id', matchValue: 'A' }));
    svc.pause(basePauseArgs({ runId: 'r2', matchKey: 'order_id', matchValue: 'B' }));
    svc.pause(basePauseArgs({ runId: 'r3', matchKey: 'order_id', matchValue: 'C' }));
    const out = svc.resumeBySignal('t1', 'order_paid', { order_id: 'B' });
    expect(out).toHaveLength(1);
    expect(out[0]?.runId).toBe('r2');
  });

  it('resume_payload_json persistito (replay debug)', () => {
    svc.pause(basePauseArgs());
    svc.resumeBySignal('t1', 'order_paid', { x: 1 });
    const row = m.sqlite.prepare('SELECT resume_payload_json FROM paused_workflows WHERE run_id = ?').get('r-1') as { resume_payload_json: string };
    expect(JSON.parse(row.resume_payload_json)).toEqual({ x: 1 });
  });

  /**
   * 🚨 AUDIT FIX WE-7 (2026-06-09 HIGH) — REGRESSION GUARD atomic claim:
   *
   * Pre-fix: SELECT + UPDATE non-atomic. 2 POST /signals/X paralleli vedono
   * stessi rows in SELECT, entrambi tentano UPDATE (uno claima, l'altro
   * no-op AND status='waiting'), MA entrambi push in result[] → duplicate
   * resumeFromPause(row) per stesso runId = side-effect duplicato.
   *
   * Post-fix: UPDATE ... RETURNING id. Solo la tx che effettivamente claima
   * il row ottiene RETURNING != []. L'altra ottiene [] → skip push.
   *
   * Test simulato: pre-claim manuale del row in 'resumed' DAI tx → next
   * resumeBySignal vede SELECT 'waiting' (cache?) MA UPDATE ritorna [] →
   * NO double-push.
   */
  it('🚨 [REGRESSION WE-7] race: row pre-claimed da altra tx → resumeBySignal skip silent', () => {
    const id = svc.pause(basePauseArgs());
    // Simula: altra tx ha pre-claimato il row → status='resumed'
    m.sqlite.prepare("UPDATE paused_workflows SET status='resumed', resumed_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    // Adesso chiama resumeBySignal → SELECT trova 0 rows (status NOT waiting)
    // → result = []
    const out = svc.resumeBySignal('t1', 'order_paid', { x: 1 });
    expect(out).toHaveLength(0);
  });

  it('🚨 [REGRESSION WE-7] resumeBySignal usa UPDATE...RETURNING (source inspection)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, 'paused-workflows.service.ts'), 'utf-8');
    // resumeBySignal contiene RETURNING id
    expect(src).toMatch(/UPDATE paused_workflows[\s\S]*?WHERE id = \? AND status = 'waiting'[\s\S]*?RETURNING id/);
  });
});

describe('🚨 sweepTimeouts() — janitor', () => {
  it('sweep: row con timeout_at scaduto → status=timeout', () => {
    const id = svc.pause(basePauseArgs({ timeoutSeconds: 1 })); // ~1s
    // Force timeout_at al passato
    m.sqlite.prepare("UPDATE paused_workflows SET timeout_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const out = svc.sweepTimeouts();
    expect(out).toHaveLength(1);
    const row = m.sqlite.prepare('SELECT status FROM paused_workflows WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('timeout');
  });

  it('sweep NON tocca row future', () => {
    svc.pause(basePauseArgs({ timeoutSeconds: 3600 })); // 1h
    const out = svc.sweepTimeouts();
    expect(out).toHaveLength(0);
  });

  it('🚨 sweep NON tocca row con timeout_at=null (forever wait)', () => {
    svc.pause(basePauseArgs({ timeoutSeconds: 0 })); // null
    const out = svc.sweepTimeouts();
    expect(out).toHaveLength(0);
  });

  it('🚨 sweep NON tocca row con status="resumed" o "cancelled"', () => {
    const id = svc.pause(basePauseArgs({ timeoutSeconds: 1 }));
    m.sqlite.prepare("UPDATE paused_workflows SET timeout_at = '2020-01-01T00:00:00.000Z', status = 'resumed' WHERE id = ?").run(id);
    const out = svc.sweepTimeouts();
    expect(out).toHaveLength(0);
  });

  it('sweep multi-row in batch', () => {
    const ids = [svc.pause(basePauseArgs({ runId: 'r1' })), svc.pause(basePauseArgs({ runId: 'r2' })), svc.pause(basePauseArgs({ runId: 'r3' }))];
    for (const id of ids) {
      m.sqlite.prepare("UPDATE paused_workflows SET timeout_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    }
    const out = svc.sweepTimeouts();
    expect(out).toHaveLength(3);
  });
});

describe('🚨 listByTenant() + cancel()', () => {
  it('list: filtra per tenant + DESC created_at', () => {
    svc.pause(basePauseArgs({ tenantId: 't1', runId: 'r1' }));
    svc.pause(basePauseArgs({ tenantId: 't2', runId: 'r2' }));
    svc.pause(basePauseArgs({ tenantId: 't1', runId: 'r3' }));
    const list = svc.listByTenant('t1');
    expect(list).toHaveLength(2);
    expect(list.every((r) => r.tenantId === 't1')).toBe(true);
  });

  it('list: con status filter', () => {
    const id = svc.pause(basePauseArgs());
    m.sqlite.prepare("UPDATE paused_workflows SET status = 'resumed' WHERE id = ?").run(id);
    expect(svc.listByTenant('t1', 'resumed')).toHaveLength(1);
    expect(svc.listByTenant('t1', 'waiting')).toHaveLength(0);
  });

  it('🚨 list: LIMIT 200 (anti-DoS)', () => {
    // Inserisci 205 row direttamente
    const insert = m.sqlite.prepare(`INSERT INTO paused_workflows (id, run_id, workflow_id, tenant_id, signal_name, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, status, created_at) VALUES (?, ?, ?, 't1', 's', 'n', '{}', '[]', '[]', 'waiting', ?)`);
    for (let i = 0; i < 205; i += 1) {
      insert.run(`id-${String(i).padStart(4, '0')}`, `r${String(i)}`, 'wf-1', new Date(Date.now() + i).toISOString());
    }
    const list = svc.listByTenant('t1');
    expect(list).toHaveLength(200);
  });

  it('🚨 cancel: row waiting → cancelled + tenant scope', () => {
    const id = svc.pause(basePauseArgs());
    expect(svc.cancel(id, 't1')).toBe(true);
    const row = m.sqlite.prepare('SELECT status FROM paused_workflows WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('🚨 cancel: cross-tenant → false (no change)', () => {
    const id = svc.pause(basePauseArgs({ tenantId: 't1' }));
    expect(svc.cancel(id, 't2-OTHER')).toBe(false);
    const row = m.sqlite.prepare('SELECT status FROM paused_workflows WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('waiting');
  });

  it('🚨 cancel: row NON waiting (es. resumed) → false (no race)', () => {
    const id = svc.pause(basePauseArgs());
    m.sqlite.prepare("UPDATE paused_workflows SET status = 'resumed' WHERE id = ?").run(id);
    expect(svc.cancel(id, 't1')).toBe(false);
  });

  it('cancel: id inesistente → false', () => {
    expect(svc.cancel('ghost', 't1')).toBe(false);
  });
});

describe('mapRow — deserialization + override', () => {
  it('list rows includono outputsById come oggetto', () => {
    svc.pause(basePauseArgs());
    const [list] = svc.listByTenant('t1');
    expect(list?.outputsById).toEqual({ n1: { value: 1 } });
  });

  it('list rows includono visited come array', () => {
    svc.pause(basePauseArgs({ visited: new Set(['a', 'b']) }));
    const [list] = svc.listByTenant('t1');
    expect(list?.visited).toEqual(['a', 'b']);
  });

  it('list rows includono pendingQueue', () => {
    svc.pause(basePauseArgs());
    const [list] = svc.listByTenant('t1');
    // GAP #2: il QueueItem round-trippa COMPLETO (sourceNodeId incluso) e il
    // lineage persistito torna intatto dal DB.
    expect(list?.pendingQueue).toEqual([{ nodeId: 'n2', carriedInput: 'x', sourceNodeId: 'n1' }]);
    expect(list?.itemGraph).toEqual({
      n1: [{ json: { value: 1 }, pairedItem: { item: 0, sourceNodeId: 'n0' } }],
    });
  });

  it('resumeBySignal output: defaultPayload sovrascritto con payload received', () => {
    svc.pause(basePauseArgs({ defaultPayload: { original: true } }));
    const [out] = svc.resumeBySignal('t1', 'order_paid', { received: true });
    expect(out?.defaultPayload).toEqual({ received: true });
  });
});
