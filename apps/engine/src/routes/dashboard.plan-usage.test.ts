/**
 * Regression test — plan-usage workflow count contro lo SCHEMA REALE.
 *
 * Incident 2026-06-04: GET /dashboard/plan-usage filtrava su
 * `workflows.deleted_at IS NULL`, ma la tabella NON ha quella colonna
 * (hard-delete via db.delete) → `SQLITE_ERROR: no such column: deleted_at`
 * → endpoint 500 in prod. Il test della route mocka `getDatabase()` quindi
 * NON esegue la SQL → non l'avrebbe MAI colto.
 *
 * Questo test chiude il gap: applica `SCHEMA_SQL` (lo schema reale eseguito
 * a boot) in un DB :memory: ed esegue `countActiveWorkflows` davvero, così
 * qualsiasi colonna fantasma o drift di schema fa fallire la CI.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../storage/migrate.schema.js';
import { countActiveWorkflows } from './dashboard.js';

type Sqlite = Parameters<typeof countActiveWorkflows>[0];

function realSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedWorkflow(db: Database.Database, id: string, tenantId: string, enabled: 0 | 1): void {
  db.prepare(
    `INSERT INTO workflows (id, tenant_id, name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-06-04T00:00:00Z', '2026-06-04T00:00:00Z')`,
  ).run(id, tenantId, `wf-${id}`, enabled);
}

describe('countActiveWorkflows — contro schema reale (anti-regressione plan-usage 500)', () => {
  it('GUARD: la query gira sullo schema reale senza SQLITE_ERROR (no such column: deleted_at)', () => {
    const db = realSchemaDb();
    expect(() => countActiveWorkflows(db as unknown as Sqlite, 'any-tenant')).not.toThrow();
    db.close();
  });

  it('CONTRATTO: la tabella workflows NON ha colonna deleted_at, HA enabled', () => {
    const db = realSchemaDb();
    const cols = (db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('deleted_at');
    expect(cols).toContain('enabled');
    db.close();
  });

  it('conta SOLO enabled=1 dello stesso tenant (no leak cross-tenant, no disabled)', () => {
    const db = realSchemaDb();
    seedWorkflow(db, 'w1', 't1', 1);
    seedWorkflow(db, 'w2', 't1', 1);
    seedWorkflow(db, 'w3', 't1', 0); // disabilitato → non conta
    seedWorkflow(db, 'w4', 't2', 1); // altro tenant → non conta
    expect(countActiveWorkflows(db as unknown as Sqlite, 't1')).toBe(2);
    expect(countActiveWorkflows(db as unknown as Sqlite, 't2')).toBe(1);
    expect(countActiveWorkflows(db as unknown as Sqlite, 'inesistente')).toBe(0);
    db.close();
  });

  it('tenant senza workflow → 0 (no crash, no undefined)', () => {
    const db = realSchemaDb();
    expect(countActiveWorkflows(db as unknown as Sqlite, 'vuoto')).toBe(0);
    db.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// fetchRecentRunsByWorkflow — fix N+1 (2026-06-15), contro schema reale
// ════════════════════════════════════════════════════════════════════
import { fetchRecentRunsByWorkflow } from './dashboard.js';

type RunReader = Parameters<typeof fetchRecentRunsByWorkflow>[0];

function seedRun(
  db: Database.Database,
  id: string,
  workflowId: string,
  startedAt: string,
  status = 'success',
): void {
  db.prepare(
    `INSERT INTO runs (id, workflow_id, tenant_id, status, input, steps_json, error_count, started_at, ended_at, total_duration_ms)
     VALUES (?, ?, 't1', ?, '', '[]', 0, ?, ?, 100)`,
  ).run(id, workflowId, status, startedAt, startedAt);
}

describe('fetchRecentRunsByWorkflow — UNA query, no N+1 (schema reale)', () => {
  it('raggruppa per workflow, più-recente-prima, rispetta il cap', () => {
    const db = realSchemaDb();
    seedWorkflow(db, 'wfA', 't1', 1);
    seedWorkflow(db, 'wfB', 't1', 1);
    seedRun(db, 'a1', 'wfA', '2026-06-01T00:00:00Z');
    seedRun(db, 'a2', 'wfA', '2026-06-03T00:00:00Z'); // più recente
    seedRun(db, 'a3', 'wfA', '2026-06-02T00:00:00Z');
    seedRun(db, 'b1', 'wfB', '2026-06-05T00:00:00Z', 'error');
    const res = fetchRecentRunsByWorkflow(db as unknown as RunReader, ['wfA', 'wfB'], 2);
    // wfA: cap 2 → solo i 2 più recenti (a2, a3), a1 escluso, ordine DESC
    expect(res.get('wfA')!.map((r) => r.id)).toEqual(['a2', 'a3']);
    // wfB: 1 run, status preservato
    expect(res.get('wfB')!.map((r) => r.id)).toEqual(['b1']);
    expect(res.get('wfB')![0]!.status).toBe('error');
    db.close();
  });

  it('workflow senza run → assente dalla map (il chiamante usa ?? [])', () => {
    const db = realSchemaDb();
    seedWorkflow(db, 'wfEmpty', 't1', 1);
    const res = fetchRecentRunsByWorkflow(db as unknown as RunReader, ['wfEmpty'], 20);
    expect(res.has('wfEmpty')).toBe(false);
    db.close();
  });

  it('lista id vuota → map vuota, ZERO query (no prepare su 0 id)', () => {
    let prepared = 0;
    const spy = {
      prepare: () => {
        prepared++;
        return { all: () => [] };
      },
    } as unknown as RunReader;
    const res = fetchRecentRunsByWorkflow(spy, [], 20);
    expect(res.size).toBe(0);
    expect(prepared).toBe(0);
  });

  it('chunking: >400 workflow id → batched senza superare il limite var SQLite', () => {
    const db = realSchemaDb();
    const ids: string[] = [];
    for (let i = 0; i < 850; i++) {
      const id = `w${String(i)}`;
      seedWorkflow(db, id, 't1', 1);
      ids.push(id);
    }
    seedRun(db, 'r-last', 'w849', '2026-06-09T00:00:00Z');
    // Non deve lanciare "too many SQL variables" + trova il run del 850° wf.
    const res = fetchRecentRunsByWorkflow(db as unknown as RunReader, ids, 20);
    expect(res.get('w849')!.map((r) => r.id)).toEqual(['r-last']);
    db.close();
  });
});
