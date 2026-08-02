/**
 * CONTRACT TEST — migration VERA ↔ servizi snapshot (GAP #2 persistenza).
 *
 * I test unit di CheckpointService/PausedWorkflowsService usano una
 * CREATE TABLE duplicata DENTRO il test: se lo schema reale
 * (migrate.schema.ts + ensureColumn) divergesse dal servizio (typo di
 * colonna, ALTER mancante), quei test resterebbero VERDI mentre la prod
 * esplode al primo INSERT. Questo file chiude il buco: costruisce lo schema
 * con `runMigrations()` (la stessa funzione del boot) e ci fa girare sopra
 * i servizi VERI — pause/save → read-back → round-trip di itemGraph e
 * sourceNodeId. Copre anche l'upgrade path: DB pre-4.2 SENZA
 * item_graph_json → runMigrations → ensureColumn → il servizio scrive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));
vi.mock('@/lib/logger.js');

const { runMigrations } = await import('@/storage/migrate.js');
const { CheckpointService } = await import('./checkpoint.service.js');
const { PausedWorkflowsService } = await import('./paused-workflows.service.js');

const GRAPH = new Map([
  ['src', [{ json: { value: 'a' } }, { json: { value: 'b' } }]],
  ['filter', [{ json: { value: 'b' }, pairedItem: { item: 1, sourceNodeId: 'src' } }]],
]);
const GRAPH_AS_RECORD = {
  src: [{ json: { value: 'a' } }, { json: { value: 'b' } }],
  filter: [{ json: { value: 'b' }, pairedItem: { item: 1, sourceNodeId: 'src' } }],
};

beforeEach(() => {
  sqliteInst = new Database(':memory:');
  runMigrations(); // ← lo schema VERO del boot, non una copia nel test
});
afterEach(() => {
  sqliteInst.close();
});

describe('🚨🚨 contract: schema da runMigrations() ↔ servizi snapshot', () => {
  it('🚨 checkpoint: save sullo schema REALE → latest() round-trippa itemGraph + sourceNodeId', () => {
    const svc = new CheckpointService();
    svc.save({
      runId: 'r-1',
      workflowId: 'wf-1',
      tenantId: 't-1',
      atNodeId: 'filter',
      outputsById: new Map([['src', ['a', 'b']]]),
      visited: new Set(['src', 'filter']),
      pendingQueue: [{ nodeId: 'next', carriedInput: { kept: ['b'] }, sourceNodeId: 'filter' }],
      itemGraph: GRAPH,
      stepCount: 2,
    });
    const cp = svc.latest('r-1');
    expect(cp).not.toBeNull();
    expect(cp!.itemGraph).toEqual(GRAPH_AS_RECORD);
    expect(cp!.pendingQueue).toEqual([
      { nodeId: 'next', carriedInput: { kept: ['b'] }, sourceNodeId: 'filter' },
    ]);
  });

  it('🚨 pause: pause sullo schema REALE → list() round-trippa itemGraph + sourceNodeId', () => {
    const svc = new PausedWorkflowsService();
    const id = svc.pause({
      runId: 'r-2',
      workflowId: 'wf-1',
      tenantId: 't-1',
      signalName: 'go',
      atNodeId: 'wait',
      outputsById: new Map([['src', ['a', 'b']]]),
      visited: new Set(['src', 'wait']),
      pendingQueue: [
        { nodeId: 'P', carriedInput: ['a', 'b'], mapMode: 'auto', sourceNodeId: 'src' },
      ],
      itemGraph: GRAPH,
      timeoutSeconds: 60,
      defaultPayload: {},
    });
    expect(id).toBeTruthy();
    const rows = svc.listByTenant('t-1');
    const row = rows.find((r) => r.runId === 'r-2');
    expect(row).toBeDefined();
    expect(row!.itemGraph).toEqual(GRAPH_AS_RECORD);
    expect(row!.pendingQueue).toEqual([
      { nodeId: 'P', carriedInput: ['a', 'b'], mapMode: 'auto', sourceNodeId: 'src' },
    ]);
  });

  it('🚨 upgrade path pre-4.2: DB con tabelle SENZA item_graph_json → runMigrations aggiunge la colonna e i servizi scrivono', () => {
    // Simula un tenant DB creato PRIMA della 4.2: tabella senza la colonna.
    sqliteInst.close();
    sqliteInst = new Database(':memory:');
    sqliteInst.exec(`
      CREATE TABLE workflow_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default', at_node_id TEXT NOT NULL,
        outputs_by_id_json TEXT NOT NULL, visited_json TEXT NOT NULL,
        pending_queue_json TEXT NOT NULL,
        step_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
    `);
    // Riga legacy scritta dal runtime vecchio.
    sqliteInst
      .prepare(
        `INSERT INTO workflow_checkpoints
      (run_id, workflow_id, tenant_id, at_node_id, outputs_by_id_json, visited_json, pending_queue_json, step_count, created_at)
      VALUES ('r-legacy', 'wf', 't-1', 'n', '{}', '[]', '[]', 1, '2026-01-01')`,
      )
      .run();

    runMigrations(); // ← ensureColumn deve aggiungere item_graph_json SENZA rompere la riga legacy

    const svc = new CheckpointService();
    // La riga legacy si legge: itemGraph {} (NULL → vuoto, mai crash).
    const legacy = svc.latest('r-legacy');
    expect(legacy).not.toBeNull();
    expect(legacy!.itemGraph).toEqual({});
    // E il runtime nuovo scrive nella colonna migrata.
    svc.save({
      runId: 'r-new',
      workflowId: 'wf',
      tenantId: 't-1',
      atNodeId: 'n',
      outputsById: new Map(),
      visited: new Set(),
      pendingQueue: [],
      itemGraph: GRAPH,
      stepCount: 1,
    });
    expect(svc.latest('r-new')!.itemGraph).toEqual(GRAPH_AS_RECORD);
  });
});
