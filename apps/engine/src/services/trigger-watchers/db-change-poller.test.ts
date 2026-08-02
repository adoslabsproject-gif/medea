/**
 * Bug-bounty — trigger-watchers/db-change-poller.
 *
 * Nel monolite il poller usava `this.dbStudio`/`this.runs` inline → il
 * comportamento del TICK (cursore, filtro ops, resilienza) era testabile solo
 * e2e via reload(). Con le deps iniettate pinniamo qui:
 *   - gate config: databaseId/tableName vuoti → null, NESSUNA query;
 *   - seed esatto (cursor=0, scan-limit 1M) e cursore al MAX corrente;
 *   - tick: payload di dispatch ESATTO, cursore che avanza tra i tick;
 *   - filtro ops: i non-matching avanzano il cursore SENZA run (no replay);
 *   - resilienza: throw nel reader o reject del dispatch → loggato, vivo;
 *   - clamp intervallo [2, 86400]s, default 5 (clampNumber — mai NaN);
 *   - FIX post-split (erano QUIRK del monolite, caratterizzati e POI fixati):
 *       1. pollIntervalSec non numerico → fallback 5s, MAI setInterval(NaN);
 *       2. seed fallito → FAIL-CLOSED: cursore null + retry al tick, niente
 *          replay del backlog.
 *   - QUIRK residuo (vero, documentato): job.lastIdSeen è lo SNAPSHOT alla
 *     registrazione — i tick aggiornano solo il cursore nella closure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startDbChangePoller,
  DB_CHANGE_SEED_SCAN_LIMIT,
  type DbChangePollerDeps,
  type DbChangeRecord,
} from './db-change-poller.js';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeWf(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-db', tenantId: 'tenant-a', name: 'DB', enabled: true,
    schemaVersion: '1.0.0', nodes: [], edges: [], nodeDefs: [],
    createdAt: '2026-06-12', updatedAt: '2026-06-12',
    ...over,
  } as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n1', defId: 'trigger_db_change', config } as unknown as CanvasNode;
}

function makeDeps(over: Partial<DbChangePollerDeps> = {}): {
  deps: DbChangePollerDeps;
  getChanges: ReturnType<typeof vi.fn>;
  dispatched: TriggerRunInput[];
} {
  const dispatched: TriggerRunInput[] = [];
  const getChanges = vi.fn((..._args: unknown[]): DbChangeRecord[] => []);
  const deps: DbChangePollerDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return { runId: 'r-1', status: 'success', errorCount: 0 };
    },
    getChangesSince: getChanges as unknown as DbChangePollerDeps['getChangesSince'],
    ...over,
  };
  return { deps, getChanges, dispatched };
}

const VALID = { databaseId: 'db-1', tableName: 'orders', pollIntervalSec: '5' };
const ch = (id: number, op = 'insert', payload: unknown = {}): DbChangeRecord =>
  ({ id, op, payload, createdAt: `T${String(id)}` });

describe('startDbChangePoller — gate config e seed', () => {
  it('databaseId vuoto → null, NESSUNA query al change-log', () => {
    vi.useFakeTimers();
    const { deps, getChanges } = makeDeps();
    expect(startDbChangePoller(makeWf(), makeNode({ databaseId: '', tableName: 'orders' }), deps)).toBeNull();
    expect(getChanges).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(getChanges).not.toHaveBeenCalled(); // e NESSUN timer registrato
  });

  it('tableName mancante → null', () => {
    const { deps } = makeDeps();
    expect(startDbChangePoller(makeWf(), makeNode({ databaseId: 'db-1' }), deps)).toBeNull();
  });

  it('seed: query esatta (cursor=0, scan-limit 1M) e cursore = ULTIMO id del batch', () => {
    vi.useFakeTimers();
    const { deps, getChanges } = makeDeps();
    getChanges.mockReturnValueOnce([ch(7), ch(100)]);
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    expect(getChanges).toHaveBeenCalledWith('tenant-a', 'db-1', 'orders', 0, DB_CHANGE_SEED_SCAN_LIMIT);
    expect(job.lastIdSeen).toBe(100);
    // Primo tick: parte dal cursore seedato, non da 0 → niente replay storico.
    getChanges.mockReturnValueOnce([]);
    vi.advanceTimersByTime(5_000);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 100);
    clearInterval(job.timer);
  });

  it('FIX fail-closed: seed che lancia → warn, NESSUN replay del backlog; il tick ritenta il seed e spara solo sui FUTURI', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    getChanges.mockImplementationOnce(() => { throw new Error('seed boom'); });
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    expect(job).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-db' }),
      'Failed to seed db-change cursor',
    );

    // Tick 1: retry del seed (backlog fino a id=2) + poll dal cursore seedato
    // → il backlog NON viene rigiocato.
    getChanges
      .mockReturnValueOnce([ch(1), ch(2)]) // retry seed
      .mockReturnValueOnce([]);            // poll post-seed
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toHaveLength(0);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 2);

    // Tick 2: change futuro → UN run.
    getChanges.mockReturnValueOnce([ch(3)]);
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]!.triggerInput as { changeId: number }).changeId).toBe(3);
    clearInterval(job.timer);
  });

  it('FIX fail-closed: seed che fallisce ANCHE al retry → nessun poll, nessun run, riprova al tick dopo (mai cursore 0 implicito)', async () => {
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    getChanges
      .mockImplementationOnce(() => { throw new Error('seed boom 1'); })  // registrazione
      .mockImplementationOnce(() => { throw new Error('seed boom 2'); }); // retry tick 1
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toHaveLength(0);
    // Il tick 1 ha fatto SOLO il retry del seed (con cursore 0 esplicito da
    // seed-scan), MAI un poll col cursore non inizializzato.
    expect(getChanges).toHaveBeenCalledTimes(2);
    expect(getChanges.mock.calls.every((c) => c[3] === 0 && c[4] === DB_CHANGE_SEED_SCAN_LIMIT)).toBe(true);
    // Tick 2: seed finalmente ok → poll regolare.
    getChanges.mockReturnValueOnce([ch(9)]).mockReturnValueOnce([]);
    vi.advanceTimersByTime(5_000);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 9);
    clearInterval(job.timer);
  });

  it('wf senza tenantId → tenant "default" in query e dispatch', () => {
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    const wf = makeWf();
    delete (wf as Partial<Record<'tenantId', string>>).tenantId;
    const job = startDbChangePoller(wf, makeNode(VALID), deps)!;
    expect(getChanges).toHaveBeenCalledWith('default', 'db-1', 'orders', 0, DB_CHANGE_SEED_SCAN_LIMIT);
    getChanges.mockReturnValueOnce([ch(1)]);
    vi.advanceTimersByTime(5_000);
    expect(dispatched[0]!.tenantId).toBe('default');
    clearInterval(job.timer);
  });
});

describe('tick — dispatch e cursore', () => {
  it('payload di dispatch ESATTO + triggerType db_change', () => {
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    getChanges.mockReturnValueOnce([ch(101, 'update', { total: 9 })]);
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toEqual([{
      workflowId: 'wf-db',
      tenantId: 'tenant-a',
      triggerType: 'db_change',
      triggerInput: {
        changeId: 101, op: 'update', databaseId: 'db-1', tableName: 'orders',
        payload: { total: 9 }, createdAt: 'T101',
      },
    }]);
    clearInterval(job.timer);
  });

  it('filtro ops: i non-matching AVANZANO il cursore senza run (no replay al tick dopo)', () => {
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    const job = startDbChangePoller(makeWf(), makeNode({ ...VALID, ops: 'insert' }), deps)!;
    getChanges.mockReturnValueOnce([ch(1, 'update'), ch(2, 'insert'), ch(3, 'delete')]);
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]!.triggerInput as { changeId: number }).changeId).toBe(2);
    getChanges.mockReturnValueOnce([]);
    vi.advanceTimersByTime(5_000);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 3);
    clearInterval(job.timer);
  });

  it('reader che lancia nel tick → error loggato, il poller sopravvive e riprova', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.useFakeTimers();
    const { deps, getChanges, dispatched } = makeDeps();
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    getChanges.mockImplementationOnce(() => { throw new Error('db gone'); });
    vi.advanceTimersByTime(5_000);
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-db' }),
      'db_change poll failed',
    );
    getChanges.mockReturnValueOnce([ch(9)]);
    vi.advanceTimersByTime(5_000);
    expect(dispatched).toHaveLength(1);
    clearInterval(job.timer);
  });

  it('dispatch rigettato → error loggato con changeId, MAI unhandled, il cursore resta avanzato (at-most-once)', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.useFakeTimers();
    const { getChanges, deps } = makeDeps({
      dispatchRun: async () => { throw new Error('run boom'); },
    });
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    getChanges.mockReturnValueOnce([ch(5)]);
    vi.advanceTimersByTime(5_000);
    await vi.advanceTimersByTimeAsync(0); // flush della microtask del .catch
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-db', changeId: 5 }),
      'db_change run failed',
    );
    // Il change fallito NON viene ritentato: cursore già avanzato (at-most-once).
    getChanges.mockReturnValueOnce([]);
    vi.advanceTimersByTime(5_000);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 5);
    clearInterval(job.timer);
  });

  it('QUIRK: job.lastIdSeen è lo snapshot alla REGISTRAZIONE — i tick non lo aggiornano (cursore vivo nella closure)', () => {
    vi.useFakeTimers();
    const { deps, getChanges } = makeDeps();
    getChanges.mockReturnValueOnce([ch(10)]); // seed → 10
    const job = startDbChangePoller(makeWf(), makeNode(VALID), deps)!;
    getChanges.mockReturnValueOnce([ch(20)]);
    vi.advanceTimersByTime(5_000);
    expect(job.lastIdSeen).toBe(10); // NON 20: comportamento storico documentato
    getChanges.mockReturnValueOnce([]);
    vi.advanceTimersByTime(5_000);
    expect(getChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 20); // la closure invece avanza
    clearInterval(job.timer);
  });
});

describe('intervallo di poll', () => {
  it('clamp MIN 2s: pollIntervalSec=0 → tick ogni 2s esatti', () => {
    vi.useFakeTimers();
    const { deps, getChanges } = makeDeps();
    const job = startDbChangePoller(makeWf(), makeNode({ ...VALID, pollIntervalSec: '0' }), deps)!;
    const callsAfterSeed = getChanges.mock.calls.length;
    vi.advanceTimersByTime(1_999);
    expect(getChanges.mock.calls.length).toBe(callsAfterSeed);
    vi.advanceTimersByTime(1);
    expect(getChanges.mock.calls.length).toBe(callsAfterSeed + 1);
    clearInterval(job.timer);
  });

  it('FIX bug NaN: pollIntervalSec non numerico → fallback al default 5s, MAI delay NaN a setInterval', () => {
    // Pre-fix: Math.max(2, NaN)=NaN → setInterval(NaN) → Node ≈1ms → martellamento DB.
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const { deps } = makeDeps();
    startDbChangePoller(makeWf(), makeNode({ ...VALID, pollIntervalSec: 'abc' }), deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(5_000); // default 5s
  });

  it('FIX bug overflow: pollIntervalSec assurdo (1e99) → clampato al MAX 86400s (niente overflow setInterval→1ms)', () => {
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const { deps } = makeDeps();
    startDbChangePoller(makeWf(), makeNode({ ...VALID, pollIntervalSec: '1e99' }), deps);
    expect(spy.mock.calls[0]![1]).toBe(86_400_000);
  });
});
