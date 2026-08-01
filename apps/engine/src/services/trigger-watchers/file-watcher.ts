/**
 * trigger-watchers/file-watcher — trigger_file_watch: osserva una directory
 * (chokidar) e fa partire un run per ogni evento file (split 2026-06-12,
 * estratto dal monolite TriggerWatchersService).
 *
 * Invarianti (pinnate dai test):
 *   - path RELATIVO → namespace tenant `<dataDir>/tenants/<safeTenant>/files/<dir>`
 *     con tenantId SANITIZZATO ([^a-z0-9_-] → '_', anti path-traversal);
 *   - path ASSOLUTO → pass-through (responsabilità allowlist dell'admin);
 *   - debounce: awaitWriteFinish.stabilityThreshold = debounceMs (MIN 50) —
 *     un CSV scritto a chunk spara UN trigger, non cento;
 *   - filtro `events`: 'all' oppure un solo tipo (add|change|unlink);
 *   - mkdir best-effort (fallimento ignorato: la dir può già esistere o
 *     arrivare dopo);
 *   - dispatch fallito → loggato, MAI unhandled.
 *
 * Elevazione vs monolite (no downgrade): watcher factory, mkdir e dispatcher
 * sono INIETTABILI (`FileWatcherDeps`) — il metodo privato usava chokidar e
 * `this.runs` inline. Default = produzione reale.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import chokidar from 'chokidar';
import { logger } from '@/lib/logger.js';
import { clampNumber } from './parsing.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@flowforge/core-schema';

/** Debounce minimo (ms) su awaitWriteFinish — sotto, chokidar spara a raffica. */
export const FILE_WATCH_MIN_DEBOUNCE_MS = 50;

/** Superficie minima del watcher chokidar usata qui — fake-abile nei test. */
export interface WatchHandle {
  on(event: string, listener: (path: string) => void): unknown;
  close(): Promise<void>;
}

export interface FileWatcherJob {
  workflowId: string;
  watcher: WatchHandle;
}

export interface FileWatcherOptions {
  persistent: boolean;
  ignoreInitial: boolean;
  awaitWriteFinish: { stabilityThreshold: number };
}

export interface FileWatcherDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Factory del watcher. Default: `chokidar.watch`. */
  watch?: (target: string, opts: FileWatcherOptions) => WatchHandle;
  /** mkdir ricorsivo best-effort. Default: `node:fs/promises`. */
  makeDir?: (dir: string) => Promise<unknown>;
}

const defaultWatch = (target: string, opts: FileWatcherOptions): WatchHandle =>
  chokidar.watch(target, opts);

const defaultMakeDir = (dir: string): Promise<unknown> => mkdir(dir, { recursive: true });

/**
 * Avvia il watcher per un nodo trigger_file_watch. Ritorna il job (handle per
 * `watcher.close()`) oppure `null` se `directory` manca — in quel caso NIENTE
 * viene registrato, come nel monolite.
 */
export async function startFileWatcher(
  wf: Workflow,
  node: CanvasNode,
  deps: FileWatcherDeps,
): Promise<FileWatcherJob | null> {
  const directoryRaw = typeof node.config.directory === 'string' ? node.config.directory : '';
  if (!directoryRaw) return null;
  const glob = typeof node.config.glob === 'string' ? node.config.glob : '';
  const events = typeof node.config.events === 'string' ? node.config.events : 'all';
  // Debounce: ms to wait after the LAST write before considering the file
  // "ready". Important for files written in chunks (CSV exports, ffmpeg
  // output) so we don't fire 100 triggers for a single logical write.
  const debounceMs = clampNumber(node.config.debounceMs, FILE_WATCH_MIN_DEBOUNCE_MS, 600_000, 500);

  // Resolve directory to tenant namespace: relative paths land under
  // /var/data/flowforge/tenants/<tenantId>/files/<dir>, absolute paths
  // pass through (admin must have allowlisted them).
  const tenantId = wf.tenantId ?? 'default';
  const safeTenant = tenantId.replace(/[^a-z0-9_-]/gi, '_');
  const baseDir = process.env.FLOWFORGE_DATA_DIR ?? '/var/data/flowforge';
  const tenantRoot = resolve(baseDir, 'tenants', safeTenant, 'files');
  const directory = directoryRaw.startsWith('/') ? directoryRaw : resolve(tenantRoot, directoryRaw);
  await (deps.makeDir ?? defaultMakeDir)(directory).catch(() => undefined);
  const target = glob ? `${directory}/${glob}` : directory;

  const watcher = (deps.watch ?? defaultWatch)(target, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: debounceMs },
  });

  const onEvent = (eventName: string, path: string): void => {
    if (events !== 'all' && events !== eventName) return;
    void deps
      .dispatchRun({
        workflowId: wf.id,
        tenantId: wf.tenantId ?? 'default',
        triggerType: 'file_watch',
        triggerInput: { event: eventName, path, ts: new Date().toISOString() },
      })
      .catch((err: unknown) => {
        logger.error({ err, workflowId: wf.id, path }, 'File-watcher run failed');
      });
  };

  watcher.on('add', (p) => { onEvent('add', p); });
  watcher.on('change', (p) => { onEvent('change', p); });
  watcher.on('unlink', (p) => { onEvent('unlink', p); });

  logger.info({ workflowId: wf.id, target }, 'File watcher registered');
  return { workflowId: wf.id, watcher };
}
