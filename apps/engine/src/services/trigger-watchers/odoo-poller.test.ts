/**
 * Bug-bounty — trigger-watchers/odoo-poller.
 *
 * Nel monolite il ciclo DLQ WE-15 era verificabile SOLO per source-inspection
 * (sqlite/import/breaker inline). Con le deps iniettate e un FAKE SQLite
 * comportamentale (odoo_state + odoo_dlq in memoria) qui pinniamo:
 *   - gate config (campi mancanti, model anti-injection);
 *   - clamp batchLimit/timeoutMs propagati nelle chiamate XML-RPC;
 *   - seed: 'skip' (MAX id, mailbox vuota→0), 'last-24h'/'last-week'
 *     (create_date >= orizzonte, cursore = primo id - 1), 'all' (0, NESSUNA
 *     search), seed fallito → persist con errore e retry;
 *   - cursore: bump SOLO sui dispatch riusciti, persist a fine batch;
 *   - WE-15 CICLO COMPLETO: 5 tick falliti → retry_count 1..5, al 5° dlqd_at
 *     settato + cursore bumpato + batch che CONTINUA (continue, non break);
 *   - overlap guard inFlight; breaker open → persist errore, niente crash;
 *   - record malformati (non-object / id non numerico) → saltati in silenzio.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startOdooPoller,
  ODOO_DLQ_MAX_RETRY,
  type OdooPollerDeps,
  type OdooSqlite,
  type OdooClientModule,
} from './odoo-poller.js';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeWf(): Workflow {
  return {
    id: 'wf-od',
    tenantId: 'tenant-a',
    name: 'OD',
    enabled: true,
    schemaVersion: '1.0.0',
    nodes: [],
    edges: [],
    nodeDefs: [],
    createdAt: '2026-06-12',
    updatedAt: '2026-06-12',
  } as unknown as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n1', defId: 'trigger_odoo_polling', config } as unknown as CanvasNode;
}

const VALID = {
  baseUrl: 'https://odoo.test',
  database: 'db',
  login: 'u',
  password: 'p',
  model: 'res.partner',
  pollIntervalSec: '10',
};

interface DlqRow {
  id: number;
  workflow_id: string;
  model: string;
  record_id: number;
  record_json: string;
  error_message: string;
  retry_count: number;
  dlqd_at: string | null;
}

/** Fake SQLite comportamentale: implementa DAVVERO odoo_state e odoo_dlq. */
class FakeOdooDb implements OdooSqlite {
  state = new Map<string, { last_id_seen: number; last_error: string | null }>();
  dlq: DlqRow[] = [];
  private nextDlqId = 1;

  prepare(sql: string): { get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => void } {
    if (sql.includes('SELECT last_id_seen FROM odoo_state')) {
      return {
        get: (wfId, model) => {
          const row = this.state.get(`${String(wfId)}::${String(model)}`);
          return row ? { last_id_seen: row.last_id_seen } : undefined;
        },
        run: () => {
          throw new Error('unexpected run on SELECT');
        },
      };
    }
    if (sql.includes('INSERT INTO odoo_state')) {
      return {
        get: () => undefined,
        run: (wfId, model, lastId, _pollAt, error) => {
          this.state.set(`${String(wfId)}::${String(model)}`, {
            last_id_seen: lastId as number,
            last_error: error as string | null,
          });
        },
      };
    }
    if (sql.includes('SELECT id, retry_count FROM odoo_dlq')) {
      return {
        get: (wfId, model, recordId) => {
          const row = this.dlq.find(
            (r) =>
              r.workflow_id === wfId &&
              r.model === model &&
              r.record_id === recordId &&
              r.dlqd_at === null,
          );
          return row ? { id: row.id, retry_count: row.retry_count } : undefined;
        },
        run: () => {
          throw new Error('unexpected run on SELECT');
        },
      };
    }
    if (sql.includes('UPDATE odoo_dlq')) {
      return {
        get: () => undefined,
        run: (nextRetry, msg, nextRetry2, maxRetry, id) => {
          const row = this.dlq.find((r) => r.id === id);
          if (!row) throw new Error('dlq row not found');
          row.retry_count = nextRetry as number;
          row.error_message = msg as string;
          row.dlqd_at =
            (nextRetry2 as number) >= (maxRetry as number) ? new Date().toISOString() : null;
        },
      };
    }
    if (sql.includes('INSERT INTO odoo_dlq')) {
      return {
        get: () => undefined,
        run: (wfId, model, recordId, json, msg) => {
          this.dlq.push({
            id: this.nextDlqId++,
            workflow_id: wfId as string,
            model: model as string,
            record_id: recordId as number,
            record_json: json as string,
            error_message: msg as string,
            retry_count: 1,
            dlqd_at: null,
          });
        },
      };
    }
    throw new Error(`SQL inattesa nel fake: ${sql.slice(0, 60)}`);
  }
}

interface ExecuteKwCall {
  model: string;
  method: string;
  positional: unknown[];
  kwargs: Record<string, unknown>;
}

function makeDeps(over: Partial<OdooPollerDeps> = {}): {
  deps: OdooPollerDeps;
  db: FakeOdooDb;
  authenticate: ReturnType<typeof vi.fn>;
  executeKw: ReturnType<typeof vi.fn>;
  dispatched: TriggerRunInput[];
} {
  const db = new FakeOdooDb();
  const dispatched: TriggerRunInput[] = [];
  const authenticate = vi.fn(async () => 7);
  const executeKw = vi.fn(async (): Promise<unknown> => []);
  const client = {
    authenticate: authenticate as unknown as OdooClientModule['authenticate'],
    executeKw: executeKw as unknown as OdooClientModule['executeKw'],
  };
  const deps: OdooPollerDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return { runId: 'r-1', status: 'success', errorCount: 0 };
    },
    sqlite: db,
    loadClient: async () => client,
    createTransport: () => (async () => ({ ok: true, status: 200, body: '' })) as never,
    getBreaker: () => ({ execute: (fn: () => Promise<void>) => fn() }),
    ...over,
  };
  return { deps, db, authenticate, executeKw, dispatched };
}

const kwCall = (mock: ReturnType<typeof vi.fn>, i: number): ExecuteKwCall =>
  mock.mock.calls[i]![2] as ExecuteKwCall;

describe('gate config', () => {
  it.each([
    ['baseUrl mancante', { ...VALID, baseUrl: '' }],
    ['password mancante', { ...VALID, password: '' }],
    ['model mancante', { ...VALID, model: '' }],
    ['model con injection', { ...VALID, model: 'res.partner; DROP TABLE x' }],
    ['model che inizia con cifra', { ...VALID, model: '1bad' }],
  ])('%s → null, nessuna risorsa', (_label, config) => {
    vi.useFakeTimers();
    const { deps, executeKw } = makeDeps();
    expect(startOdooPoller(makeWf(), makeNode(config), deps)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(executeKw).not.toHaveBeenCalled();
  });
});

describe('seed policy (primo tick, nessuno stato persistito)', () => {
  it("'skip': search(id desc) → cursore = MAX id, persistito; search_read dello stesso tick parte da lì", async () => {
    vi.useFakeTimers();
    const { deps, db, executeKw } = makeDeps();
    executeKw.mockResolvedValueOnce([250]).mockResolvedValueOnce([]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kwCall(executeKw, 0).method).toBe('search');
    expect(kwCall(executeKw, 0).kwargs).toEqual({ limit: 1, order: 'id desc' });
    expect(kwCall(executeKw, 1).method).toBe('search_read');
    expect(kwCall(executeKw, 1).positional[0]).toEqual([['id', '>', 250]]);
    expect(db.state.get('wf-od::res.partner')!.last_id_seen).toBe(250);
    expect(job.lastIdSeen).toBe(250);
    clearInterval(job.timer);
  });

  it("'skip' con tabella vuota → cursore 0", async () => {
    vi.useFakeTimers();
    const { deps, executeKw } = makeDeps();
    executeKw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kwCall(executeKw, 1).positional[0]).toEqual([['id', '>', 0]]);
    clearInterval(job.timer);
  });

  it("'last-24h': search(create_date >= orizzonte, id asc) → cursore = primo id - 1 (il primo poll LO cattura)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    const { deps, executeKw } = makeDeps();
    executeKw.mockResolvedValueOnce([40]).mockResolvedValueOnce([]);
    const job = startOdooPoller(
      makeWf(),
      makeNode({ ...VALID, initialBacklog: 'last-24h' }),
      deps,
    )!;
    await vi.advanceTimersByTimeAsync(10_000);
    const seedCall = kwCall(executeKw, 0);
    expect(seedCall.method).toBe('search');
    // L'orizzonte è calcolato al momento del TICK (12:00:10 dopo i 10s di
    // avanzamento timer), non alla registrazione del poller.
    expect(seedCall.positional[0]).toEqual([['create_date', '>=', '2026-06-11 12:00:10']]);
    expect(seedCall.kwargs).toEqual({ limit: 1, order: 'id asc' });
    expect(kwCall(executeKw, 1).positional[0]).toEqual([['id', '>', 39]]);
    clearInterval(job.timer);
  });

  it("'all': NESSUNA search di seed, cursore 0 diretto", async () => {
    vi.useFakeTimers();
    const { deps, executeKw } = makeDeps();
    executeKw.mockResolvedValueOnce([]);
    const job = startOdooPoller(makeWf(), makeNode({ ...VALID, initialBacklog: 'all' }), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executeKw).toHaveBeenCalledTimes(1); // solo search_read
    expect(kwCall(executeKw, 0).method).toBe('search_read');
    expect(kwCall(executeKw, 0).positional[0]).toEqual([['id', '>', 0]]);
    clearInterval(job.timer);
  });

  it('seed fallito → persist con errore, il tick NON procede; il tick dopo riprova il seed', async () => {
    vi.useFakeTimers();
    const { deps, db, authenticate, executeKw } = makeDeps();
    authenticate.mockRejectedValueOnce(new Error('auth boom'));
    executeKw.mockResolvedValueOnce([10]).mockResolvedValueOnce([]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.state.get('wf-od::res.partner')!.last_error).toBe('auth boom');
    expect(executeKw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); // retry seed
    expect(kwCall(executeKw, 0).method).toBe('search');
    clearInterval(job.timer);
  });

  it('stato persistito esistente → NESSUN seed, cursore ripreso da odoo_state', async () => {
    vi.useFakeTimers();
    const { deps, db, executeKw } = makeDeps();
    db.state.set('wf-od::res.partner', { last_id_seen: 77, last_error: null });
    executeKw.mockResolvedValueOnce([]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executeKw).toHaveBeenCalledTimes(1);
    expect(kwCall(executeKw, 0).positional[0]).toEqual([['id', '>', 77]]);
    clearInterval(job.timer);
  });
});

describe('poll → dispatch e cursore', () => {
  function withState(deps: ReturnType<typeof makeDeps>): void {
    deps.db.state.set('wf-od::res.partner', { last_id_seen: 100, last_error: null });
  }

  it('un run per record (payload esatto), cursore bumpato per-record e persistito a fine batch', async () => {
    vi.useFakeTimers();
    const made = makeDeps();
    withState(made);
    const { deps, db, executeKw, dispatched } = made;
    executeKw.mockResolvedValueOnce([
      { id: 101, name: 'a' },
      { id: 102, name: 'b' },
    ]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatched).toHaveLength(2);
    const first = dispatched[0]!;
    expect(first.triggerType).toBe('odoo_polling');
    expect(first.tenantId).toBe('tenant-a');
    const ti = first.triggerInput as {
      model: string;
      recordId: number;
      record: unknown;
      triggeredAt: string;
    };
    expect(ti.model).toBe('res.partner');
    expect(ti.recordId).toBe(101);
    expect(ti.record).toEqual({ id: 101, name: 'a' });
    expect(db.state.get('wf-od::res.partner')!.last_id_seen).toBe(102);
    expect(job.lastIdSeen).toBe(102);
    clearInterval(job.timer);
  });

  it('FIX bug NaN: pollIntervalSec/batchLimit/timeoutMs non numerici → default 60s/50/30000, MAI NaN', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, 'setInterval');
    const made = makeDeps();
    withState(made);
    const { deps, executeKw } = made;
    executeKw.mockResolvedValue([]);
    const job = startOdooPoller(
      makeWf(),
      makeNode({ ...VALID, pollIntervalSec: 'abc', batchLimit: 'xx', timeoutMs: 'boom' }),
      deps,
    )!;
    expect(spy.mock.calls[0]![1]).toBe(60_000); // default, non NaN
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kwCall(executeKw, 0).kwargs.limit).toBe(50);
    expect((executeKw.mock.calls[0]![4] as { timeoutMs: number }).timeoutMs).toBe(30_000);
    clearInterval(job.timer);
    spy.mockRestore();
  });

  it('clamp: batchLimit cap 500 e timeoutMs cap 180000 propagati nella chiamata', async () => {
    vi.useFakeTimers();
    const made = makeDeps();
    withState(made);
    const { deps, executeKw } = made;
    executeKw.mockResolvedValueOnce([]);
    const job = startOdooPoller(
      makeWf(),
      makeNode({ ...VALID, batchLimit: '99999', timeoutMs: '999999999' }),
      deps,
    )!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kwCall(executeKw, 0).kwargs.limit).toBe(500);
    expect((executeKw.mock.calls[0]![4] as { timeoutMs: number }).timeoutMs).toBe(180_000);
    clearInterval(job.timer);
  });

  it('fieldsJson valido → kwargs.fields; invalido → ignorato', async () => {
    vi.useFakeTimers();
    const made = makeDeps();
    withState(made);
    const { deps, executeKw } = made;
    executeKw.mockResolvedValue([]);
    const job = startOdooPoller(
      makeWf(),
      makeNode({ ...VALID, fieldsJson: '["name","email"]' }),
      deps,
    )!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kwCall(executeKw, 0).kwargs.fields).toEqual(['name', 'email']);
    clearInterval(job.timer);

    const made2 = makeDeps();
    withState(made2);
    made2.executeKw.mockResolvedValue([]);
    const job2 = startOdooPoller(
      makeWf(),
      makeNode({ ...VALID, fieldsJson: '{rotto' }),
      made2.deps,
    )!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kwCall(made2.executeKw, 0).kwargs.fields).toBeUndefined();
    clearInterval(job2.timer);
  });

  it('record malformati (non-object, id mancante) → saltati senza dispatch né crash', async () => {
    vi.useFakeTimers();
    const made = makeDeps();
    withState(made);
    const { deps, executeKw, dispatched } = made;
    executeKw.mockResolvedValueOnce([null, 'stringa', { name: 'senza id' }, { id: 105 }]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]!.triggerInput as { recordId: number }).recordId).toBe(105);
    clearInterval(job.timer);
  });

  it('overlap guard: poll in volo → tick saltato', async () => {
    vi.useFakeTimers();
    const made = makeDeps();
    withState(made);
    const { deps, authenticate, executeKw } = made;
    let release!: (v: number) => void;
    authenticate.mockImplementationOnce(
      () =>
        new Promise<number>((r) => {
          release = r;
        }),
    );
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 in volo
    await vi.advanceTimersByTimeAsync(10_000); // tick 2 saltato
    expect(authenticate).toHaveBeenCalledTimes(1);
    release(7);
    executeKw.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(10_000); // tick 3 riparte
    expect(authenticate).toHaveBeenCalledTimes(2);
    clearInterval(job.timer);
  });

  it('breaker open (execute lancia) → persist con errore, poller vivo', async () => {
    vi.useFakeTimers();
    const made = makeDeps({
      getBreaker: () => ({
        execute: async () => {
          throw new Error('breaker open');
        },
      }),
    });
    withState(made);
    const { deps, db } = made;
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.state.get('wf-od::res.partner')!.last_error).toBe('breaker open');
    expect(job.inFlight).toBe(false);
    clearInterval(job.timer);
  });
});

describe('WE-15 poison-pill DLQ — ciclo COMPLETO behaviorale', () => {
  it('run fallito → INSERT dlq retry=1, batch STOPPATO, cursore fermo; 5 tick falliti → dlqd_at + cursore bumpato + batch CONTINUA', async () => {
    vi.useFakeTimers();
    const made = makeDeps({
      dispatchRun: vi.fn(async (input: TriggerRunInput) => {
        if ((input.triggerInput as { recordId: number }).recordId === 101)
          throw new Error('poison');
        return { runId: 'r', status: 'success', errorCount: 0 };
      }),
    });
    made.db.state.set('wf-od::res.partner', { last_id_seen: 100, last_error: null });
    const { deps, db, executeKw } = made;
    // Ogni tick rivede gli stessi 2 record (cursore fermo a 100 finché 101 non è DLQ).
    executeKw.mockResolvedValue([{ id: 101 }, { id: 102 }]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;

    // Tick 1: INSERT retry_count=1, batch stoppato (102 NON dispatchato), cursore fermo.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.dlq).toHaveLength(1);
    expect(db.dlq[0]).toMatchObject({
      record_id: 101,
      retry_count: 1,
      dlqd_at: null,
      error_message: 'poison',
    });
    expect(db.state.get('wf-od::res.partner')!.last_id_seen).toBe(100);
    expect((deps.dispatchRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // Tick 2..4: retry_count sale a 2,3,4 — ancora nessun DLQ definitivo.
    for (const expected of [2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(db.dlq[0]!.retry_count).toBe(expected);
      expect(db.dlq[0]!.dlqd_at).toBeNull();
      expect(db.state.get('wf-od::res.partner')!.last_id_seen).toBe(100);
    }

    // Tick 5: retry_count=5=MAX → dlqd_at settato, cursore BUMPATO a 101 e il
    // batch CONTINUA: il record 102 viene finalmente dispatchato.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.dlq[0]!.retry_count).toBe(ODOO_DLQ_MAX_RETRY);
    expect(db.dlq[0]!.dlqd_at).not.toBeNull();
    expect(db.state.get('wf-od::res.partner')!.last_id_seen).toBe(102);
    const calls = (deps.dispatchRun as ReturnType<typeof vi.fn>).mock.calls as [TriggerRunInput][];
    const dispatchedIds = calls.map((c) => (c[0].triggerInput as { recordId: number }).recordId);
    expect(dispatchedIds.filter((x) => x === 102)).toHaveLength(1);
    clearInterval(job.timer);
  });

  it('record_json troncato a 32768 char (cap anti-bloat)', async () => {
    vi.useFakeTimers();
    const made = makeDeps({
      dispatchRun: async () => {
        throw new Error('boom');
      },
    });
    made.db.state.set('wf-od::res.partner', { last_id_seen: 100, last_error: null });
    const { deps, db, executeKw } = made;
    executeKw.mockResolvedValueOnce([{ id: 101, blob: 'x'.repeat(50_000) }]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db.dlq[0]!.record_json.length).toBe(32_768);
    clearInterval(job.timer);
  });

  it('scrittura DLQ che fallisce → warn non-fatale, il poller sopravvive', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.useFakeTimers();
    const made = makeDeps({
      dispatchRun: async () => {
        throw new Error('boom');
      },
    });
    made.db.state.set('wf-od::res.partner', { last_id_seen: 100, last_error: null });
    const brokenDlq = made.db;
    const origPrepare = brokenDlq.prepare.bind(brokenDlq);
    vi.spyOn(brokenDlq, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('odoo_dlq')) throw new Error('disk full');
      return origPrepare(sql);
    });
    made.executeKw.mockResolvedValue([{ id: 101 }]);
    const job = startOdooPoller(makeWf(), makeNode(VALID), made.deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-od', recordId: 101 }),
      '[WE-15] odoo_dlq write failed (non-fatal)',
    );
    expect(job.inFlight).toBe(false);
    clearInterval(job.timer);
  });
});
