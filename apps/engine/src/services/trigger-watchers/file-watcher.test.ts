/**
 * Bug-bounty — trigger-watchers/file-watcher.
 *
 * Nel monolite il watcher usava chokidar + `this.runs` inline → il wiring degli
 * eventi era testabile solo e2e con vi.mock('chokidar'). Con watch/makeDir/
 * dispatcher INIETTATI pinniamo qui:
 *   - gate: directory vuota → null, NESSUNA risorsa creata;
 *   - namespace tenant per path relativi + sanitizzazione anti-traversal del
 *     tenantId + override FLOWFORGE_DATA_DIR letto a runtime;
 *   - path assoluto pass-through; glob appeso al target ma mkdir sulla DIR;
 *   - opzioni chokidar esatte (persistent, ignoreInitial, debounce clamp 50);
 *   - mkdir best-effort: il fallimento NON blocca la registrazione;
 *   - eventi add/change/unlink → payload esatto; filtro `events` selettivo;
 *   - dispatch fallito → loggato, MAI unhandled.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startFileWatcher,
  FILE_WATCH_MIN_DEBOUNCE_MS,
  type FileWatcherDeps,
  type FileWatcherOptions,
  type WatchHandle,
} from './file-watcher.js';
import type { TriggerRunInput, TriggerRunResult } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@flowforge/core-schema';

const ENV_KEY = 'FLOWFORGE_DATA_DIR';
const envBackup = process.env[ENV_KEY];

afterEach(() => {
  vi.restoreAllMocks();
  if (envBackup === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = envBackup;
});

function makeWf(tenantId = 'tenant-a'): Workflow {
  return {
    id: 'wf-fw', tenantId, name: 'FW', enabled: true,
    schemaVersion: '1.0.0', nodes: [], edges: [], nodeDefs: [],
    createdAt: '2026-06-12', updatedAt: '2026-06-12',
  } as unknown as Workflow;
}

function makeNode(config: Record<string, string>): CanvasNode {
  return { id: 'n1', defId: 'trigger_file_watch', config } as unknown as CanvasNode;
}

class FakeWatch implements WatchHandle {
  handlers = new Map<string, (path: string) => void>();
  on(event: string, listener: (path: string) => void): unknown {
    this.handlers.set(event, listener);
    return this;
  }
  async close(): Promise<void> { /* no-op */ }
  fire(event: string, path: string): void { this.handlers.get(event)?.(path); }
}

function makeDeps(over: Partial<FileWatcherDeps> = {}): {
  deps: FileWatcherDeps;
  watch: ReturnType<typeof vi.fn>;
  makeDir: ReturnType<typeof vi.fn>;
  fakes: FakeWatch[];
  dispatched: TriggerRunInput[];
} {
  const fakes: FakeWatch[] = [];
  const dispatched: TriggerRunInput[] = [];
  const watch = vi.fn((_target: string, _opts: FileWatcherOptions): WatchHandle => {
    const f = new FakeWatch();
    fakes.push(f);
    return f;
  });
  const makeDir = vi.fn(async () => undefined);
  const deps: FileWatcherDeps = {
    dispatchRun: async (input: TriggerRunInput): Promise<TriggerRunResult> => {
      dispatched.push(input);
      return { runId: 'r-1', status: 'success', errorCount: 0 };
    },
    watch,
    makeDir,
    ...over,
  };
  return { deps, watch, makeDir, fakes, dispatched };
}

describe('startFileWatcher — gate e risoluzione path', () => {
  it('directory vuota → null, NESSUN watcher/mkdir', async () => {
    const { deps, watch, makeDir } = makeDeps();
    expect(await startFileWatcher(makeWf(), makeNode({}), deps)).toBeNull();
    expect(watch).not.toHaveBeenCalled();
    expect(makeDir).not.toHaveBeenCalled();
  });

  it('path relativo → namespace tenant sotto FLOWFORGE_DATA_DIR (letto a runtime)', async () => {
    process.env[ENV_KEY] = '/custom/data';
    const { deps, watch, makeDir } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: 'inbox' }), deps);
    expect(makeDir).toHaveBeenCalledWith('/custom/data/tenants/tenant-a/files/inbox');
    expect(watch.mock.calls[0]![0]).toBe('/custom/data/tenants/tenant-a/files/inbox');
  });

  it('senza env → default /var/data/flowforge', async () => {
    delete process.env[ENV_KEY];
    const { deps, watch } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: 'inbox' }), deps);
    expect(watch.mock.calls[0]![0]).toBe('/var/data/flowforge/tenants/tenant-a/files/inbox');
  });

  it('tenantId ostile → sanitizzato (anti path-traversal)', async () => {
    process.env[ENV_KEY] = '/d';
    const { deps, watch } = makeDeps();
    await startFileWatcher(makeWf('tenant/../etc/passwd'), makeNode({ directory: 'inbox' }), deps);
    const target = watch.mock.calls[0]![0] as string;
    expect(target).toBe('/d/tenants/tenant____etc_passwd/files/inbox');
    expect(target).not.toContain('/etc/passwd');
  });

  it('path assoluto → pass-through; glob appeso al TARGET ma mkdir sulla DIRECTORY', async () => {
    const { deps, watch, makeDir } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: '/var/spool/scan', glob: '*.csv' }), deps);
    expect(makeDir).toHaveBeenCalledWith('/var/spool/scan');
    expect(watch.mock.calls[0]![0]).toBe('/var/spool/scan/*.csv');
  });

  it('opzioni chokidar esatte: persistent, ignoreInitial, debounce clamp MIN 50', async () => {
    const { deps, watch } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: '/x', debounceMs: '1' }), deps);
    expect(watch.mock.calls[0]![1]).toEqual({
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_WATCH_MIN_DEBOUNCE_MS },
    });
  });

  it('FIX bug NaN: debounceMs non numerico → default 500 (MAI stabilityThreshold NaN a chokidar)', async () => {
    const { deps, watch } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: '/x', debounceMs: 'abc' }), deps);
    expect((watch.mock.calls[0]![1] as FileWatcherOptions).awaitWriteFinish.stabilityThreshold).toBe(500);
  });

  it('mkdir che fallisce → swallowed, il watcher viene comunque registrato', async () => {
    const { deps, watch } = makeDeps({ makeDir: vi.fn(async () => { throw new Error('EACCES'); }) });
    const job = await startFileWatcher(makeWf(), makeNode({ directory: '/x' }), deps);
    expect(job).not.toBeNull();
    expect(watch).toHaveBeenCalledTimes(1);
  });
});

describe('eventi → run dispatch', () => {
  it('add/change/unlink tutti cablati; payload esatto {event, path, ts ISO}', async () => {
    const { deps, fakes, dispatched } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: '/in' }), deps);
    const f = fakes[0]!;
    expect([...f.handlers.keys()]).toEqual(['add', 'change', 'unlink']);
    f.fire('change', '/in/report.csv');
    expect(dispatched).toHaveLength(1);
    const input = dispatched[0]!;
    expect(input.workflowId).toBe('wf-fw');
    expect(input.tenantId).toBe('tenant-a');
    expect(input.triggerType).toBe('file_watch');
    const ti = input.triggerInput as { event: string; path: string; ts: string };
    expect(ti.event).toBe('change');
    expect(ti.path).toBe('/in/report.csv');
    expect(() => new Date(ti.ts).toISOString()).not.toThrow();
  });

  it('filtro events="unlink": add/change ignorati, unlink spara', async () => {
    const { deps, fakes, dispatched } = makeDeps();
    await startFileWatcher(makeWf(), makeNode({ directory: '/in', events: 'unlink' }), deps);
    const f = fakes[0]!;
    f.fire('add', '/in/a');
    f.fire('change', '/in/a');
    expect(dispatched).toHaveLength(0);
    f.fire('unlink', '/in/a');
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0]!.triggerInput as { event: string }).event).toBe('unlink');
  });

  it('dispatch rigettato → error loggato con path, MAI unhandled', async () => {
    const { logger } = await import('@/lib/logger.js');
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const { fakes, deps } = makeDeps({
      dispatchRun: async () => { throw new Error('run boom'); },
    });
    await startFileWatcher(makeWf(), makeNode({ directory: '/in' }), deps);
    fakes[0]!.fire('add', '/in/x.bin');
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-fw', path: '/in/x.bin' }),
      'File-watcher run failed',
    );
  });
});
