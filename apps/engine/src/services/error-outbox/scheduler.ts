/**
 * Scheduler dell'outbox errori: consuma la coda durevole (sweep periodico) e fa GC
 * delle righe terminate (done/dead) oltre la retention (#6).
 *
 * - Anti-overlap: un guard `inFlight` impedisce due sweep concorrenti se un dispatch
 *   è più lento dell'intervallo (no thundering herd sulla stessa riga; il claim è
 *   comunque idempotente, ma evitiamo lavoro inutile).
 * - Fail-soft: un errore nel sweep/GC viene loggato, MAI propagato (il timer continua).
 * - now() iniettabile per i test (fake timers + tempo deterministico per il GC).
 */

import { logger } from '@/lib/logger.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ErrorOutboxChannel } from '@/storage/schema.js';
import { runOutboxSweepOnce, type ChannelDispatcher } from './worker.js';
import { gcErrorOutbox } from './repository.js';

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_GC_INTERVAL_MS = 3_600_000; // 1h
const DEFAULT_GC_RETENTION_MS = 7 * 24 * 3_600_000; // 7 giorni
const SWEEP_LIMIT = 50;

export interface OutboxSchedulerDeps {
  sqlite: SqliteCompatProxy;
  dispatchers: Record<ErrorOutboxChannel, ChannelDispatcher>;
  sweepIntervalMs?: number;
  gcIntervalMs?: number;
  gcRetentionMs?: number;
  now?: () => number;
}

export interface OutboxSchedulerHandle {
  /** Esegue un singolo sweep ora (usato anche dal timer). Non rilancia errori. */
  sweepNow(): Promise<void>;
  /** Esegue il GC ora. Ritorna le righe eliminate. Non rilancia errori. */
  gcNow(): number;
  stop(): void;
}

export function startOutboxScheduler(deps: OutboxSchedulerDeps): OutboxSchedulerHandle {
  const now = deps.now ?? Date.now;
  const sweepInterval = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const gcInterval = deps.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
  const gcRetention = deps.gcRetentionMs ?? DEFAULT_GC_RETENTION_MS;

  let inFlight = false;

  async function sweepNow(): Promise<void> {
    if (inFlight) return; // anti-overlap: salta se uno sweep è ancora in corso
    inFlight = true;
    try {
      const res = await runOutboxSweepOnce(
        { sqlite: deps.sqlite, dispatchers: deps.dispatchers, now: () => new Date(now()) },
        SWEEP_LIMIT,
      );
      if (res.claimed > 0) {
        logger.info({ ...res }, '[error-outbox] sweep');
      }
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[error-outbox] sweep failed (fail-soft)',
      );
    } finally {
      inFlight = false;
    }
  }

  function gcNow(): number {
    try {
      const before = new Date(now() - gcRetention).toISOString();
      const deleted = gcErrorOutbox(deps.sqlite, before);
      if (deleted > 0) logger.info({ deleted }, '[error-outbox] gc');
      return deleted;
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[error-outbox] gc failed (fail-soft)',
      );
      return 0;
    }
  }

  const sweepTimer = setInterval(() => {
    void sweepNow();
  }, sweepInterval);
  const gcTimer = setInterval(() => {
    gcNow();
  }, gcInterval);
  // unref: lo scheduler non deve tenere vivo il processo da solo.
  sweepTimer.unref?.();
  gcTimer.unref?.();

  return {
    sweepNow,
    gcNow,
    stop(): void {
      clearInterval(sweepTimer);
      clearInterval(gcTimer);
    },
  };
}
