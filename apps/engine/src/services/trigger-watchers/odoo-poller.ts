/**
 * trigger-watchers/odoo-poller — trigger_odoo_polling, production-grade (split
 * 2026-06-12, estratto dal monolite TriggerWatchersService).
 *
 * Loop per tick:
 *   1. authenticate (uid cached 5min inside the XML-RPC lib)
 *   2. search_read on `model` with `[(id, ">", lastIdSeen), ...domain]`
 *   3. for each new record: dispatchRun({ triggerType: 'odoo_polling', ... })
 *   4. persist lastIdSeen in `odoo_state` (per workflow + model)
 *
 * First-run backlog policy (config.initialBacklog):
 *   • skip       — seed lastIdSeen with the current MAX(id) so we only see
 *                  records created after the trigger went live
 *   • last-24h   — seed via search on create_date >= now()-24h
 *   • last-week  — seed via search on create_date >= now()-7d
 *   • all        — start at 0 (= scoop everything; brutal but documented)
 *
 * Overlap guard: `inFlight` flag prevents a second tick from starting while
 * the previous one is still walking a slow Odoo.
 *
 * AUDIT FIX WE-15 (poison-pill DLQ): un record il cui run fallisce viene
 * ritentato fino a MAX_RETRY=5 (cursore NON bumpato, batch stoppato); al
 * raggiungimento finisce in `odoo_dlq` (dlqd_at) e il cursore AVANZA per
 * sbloccare il poller.
 *
 * Elevazione vs monolite (no downgrade): store SQLite, client XML-RPC,
 * transport e circuit-breaker sono INIETTABILI (`OdooPollerDeps`) — il metodo
 * privato usava getDatabase()/import dinamico/registry inline, rendendo il
 * ciclo DLQ testabile solo per source-inspection. Default = produzione reale.
 */

import type * as NodesStdlibNS from '@medea/engine-nodes-stdlib';
import { logger } from '@/lib/logger.js';
import { getDatabase } from '@/storage/db.js';
import { makeOdooHttpTransport } from './odoo-transport.js';
import { clampNumber } from './parsing.js';
import { resolveTriggerBreaker, type TriggerBreaker } from './breaker.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

/** Tentativi prima che un record finisca in DLQ e il cursore avanzi (WE-15). */
export const ODOO_DLQ_MAX_RETRY = 5;

export interface OdooPollerJob {
  workflowId: string;
  timer: ReturnType<typeof setInterval>;
  /** Last record id we've fired the workflow on. Persisted in `odoo_state`. */
  lastIdSeen: number;
  /** True while a poll is in flight — prevents overlapping polls on slow Odoo. */
  inFlight: boolean;
}

/** Superficie minima di better-sqlite3 usata qui (odoo_state + odoo_dlq). */
export interface OdooSqlite {
  prepare(sql: string): {
    get: (...p: unknown[]) => unknown;
    run: (...p: unknown[]) => void;
  };
}

/** Client XML-RPC stdlib — type-only import, nessun caricamento a runtime. */
export type OdooClientModule = Pick<typeof NodesStdlibNS, 'authenticate' | 'executeKw'>;

/** Superficie minima del circuit breaker usata dal poller — fake-abile nei test. */
export type OdooBreaker = TriggerBreaker;

export interface OdooPollerDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Store per odoo_state/odoo_dlq. Default: `getDatabase().sqlite`. */
  sqlite?: OdooSqlite;
  /** Loader del client XML-RPC. Default: import lazy di `@medea/engine-nodes-stdlib`. */
  loadClient?: () => Promise<OdooClientModule>;
  /** Factory del transport HTTP per-chiamata. Default: `makeOdooHttpTransport`. */
  createTransport?: typeof makeOdooHttpTransport;
  /** Resolver del circuit breaker per host. Default: registry condiviso o nuova istanza. */
  getBreaker?: (name: string) => OdooBreaker;
}

const defaultLoadClient = async (): Promise<OdooClientModule> => {
  // Lazy import the published stdlib client (it's re-exported from
  // the package barrel via `export * from lib/odoo/index.js`).
  const stdlibMod = await import('@medea/engine-nodes-stdlib');
  return stdlibMod;
};

/**
 * Avvia il poller per un nodo trigger_odoo_polling. Ritorna il job (handle per
 * `clearInterval`) oppure `null` se la config è incompleta o il nome modello è
 * invalido (anti-injection) — in quel caso NIENTE viene registrato.
 */
export function startOdooPoller(
  wf: Workflow,
  node: CanvasNode,
  deps: OdooPollerDeps,
): OdooPollerJob | null {
  const tenantId = wf.tenantId ?? 'default';

  const baseUrl = typeof node.config.baseUrl === 'string' ? node.config.baseUrl.trim() : '';
  const database = typeof node.config.database === 'string' ? node.config.database.trim() : '';
  const login = typeof node.config.login === 'string' ? node.config.login.trim() : '';
  const password = typeof node.config.password === 'string' ? node.config.password : '';
  const model = typeof node.config.model === 'string' ? node.config.model.trim() : '';
  if (!baseUrl || !database || !login || !password || !model) {
    logger.warn({ workflowId: wf.id }, 'trigger_odoo_polling missing required config — skipped');
    return null;
  }
  if (!/^[a-z][a-z0-9_.]*$/i.test(model)) {
    logger.warn({ workflowId: wf.id, model }, 'trigger_odoo_polling invalid model name — skipped');
    return null;
  }

  const interval = clampNumber(node.config.pollIntervalSec, 10, 3600, 60) * 1000;
  const batchLimit = clampNumber(node.config.batchLimit, 1, 500, 50);
  const initialBacklog =
    typeof node.config.initialBacklog === 'string' ? node.config.initialBacklog : 'skip';
  const timeoutMs = clampNumber(node.config.timeoutMs, 1_000, 180_000, 30_000);

  // Parse user domain (Odoo domain array form). Bad JSON → empty domain.
  let userDomain: unknown[] = [];
  const domainRaw = typeof node.config.domainJson === 'string' ? node.config.domainJson : '';
  if (domainRaw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(domainRaw);
      if (Array.isArray(parsed)) userDomain = parsed;
    } catch (err) {
      logger.warn({ workflowId: wf.id, err }, 'trigger_odoo_polling: invalid domainJson — ignored');
    }
  }

  // Optional fields list (limit returned columns).
  let fieldsList: string[] | undefined;
  const fieldsRaw = typeof node.config.fieldsJson === 'string' ? node.config.fieldsJson : '';
  if (fieldsRaw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(fieldsRaw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        fieldsList = parsed;
      }
    } catch (err) {
      logger.warn({ workflowId: wf.id, err }, 'trigger_odoo_polling: invalid fieldsJson — ignored');
    }
  }

  const loadClient = deps.loadClient ?? defaultLoadClient;
  const createTransport = deps.createTransport ?? makeOdooHttpTransport;

  // Seed lastIdSeen from `odoo_state` or via initialBacklog policy.
  const sqlite = deps.sqlite ?? getDatabase().sqlite;
  const stateRow = sqlite
    .prepare('SELECT last_id_seen FROM odoo_state WHERE workflow_id = ? AND model = ?')
    .get(wf.id, model) as { last_id_seen: number } | undefined;
  let lastIdSeen = stateRow?.last_id_seen ?? -1;

  const persistState = (error?: string): void => {
    try {
      sqlite
        .prepare(
          `
        INSERT INTO odoo_state (workflow_id, model, last_id_seen, last_poll_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT (workflow_id, model)
        DO UPDATE SET last_id_seen=excluded.last_id_seen, last_poll_at=excluded.last_poll_at,
                      last_error=excluded.last_error, updated_at=excluded.updated_at
      `,
        )
        .run(wf.id, model, lastIdSeen, new Date().toISOString(), error ?? null);
    } catch (err) {
      logger.warn({ err, workflowId: wf.id }, 'odoo_state persist failed (non-fatal)');
    }
  };

  // Per-host circuit breaker keyed on the Odoo origin. Match the
  // existing imap-pattern: query the registry, fallback to a new instance.
  let hostKey = baseUrl;
  try {
    hostKey = new URL(baseUrl).host;
  } catch {
    /* keep raw */
  }
  const breakerName = `odoo:${hostKey}`;
  const breaker = (deps.getBreaker ?? resolveTriggerBreaker)(breakerName);

  const job: OdooPollerJob = {
    workflowId: wf.id,
    timer: null as unknown as ReturnType<typeof setInterval>,
    lastIdSeen,
    inFlight: false,
  };

  const seed = async (): Promise<void> => {
    if (lastIdSeen >= 0) return;
    try {
      const { authenticate, executeKw } = await loadClient();
      const transport = createTransport();
      const auth = { baseUrl, database, login, password };
      const uid = await authenticate(auth, transport, { timeoutMs });
      let seedDomain: unknown[] = [];
      if (initialBacklog === 'skip') {
        // Search the current max id and seed cursor to it (= no historical fire).
        const ids = await executeKw(
          auth,
          uid,
          {
            model,
            method: 'search',
            positional: [[] as never],
            kwargs: { limit: 1, order: 'id desc' },
          },
          transport,
          { timeoutMs },
        );
        const arr = Array.isArray(ids) ? ids : [];
        lastIdSeen = typeof arr[0] === 'number' ? arr[0] : 0;
      } else if (initialBacklog === 'last-24h' || initialBacklog === 'last-week') {
        const horizonMs = initialBacklog === 'last-24h' ? 24 * 3600_000 : 7 * 24 * 3600_000;
        const horizonIso = new Date(Date.now() - horizonMs)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ');
        seedDomain = [['create_date', '>=', horizonIso]];
        const ids = await executeKw(
          auth,
          uid,
          {
            model,
            method: 'search',
            positional: [seedDomain as never],
            kwargs: { limit: 1, order: 'id asc' },
          },
          transport,
          { timeoutMs },
        );
        const arr = Array.isArray(ids) ? ids : [];
        // Cursor = first matching id minus 1 so the first poll catches it.
        lastIdSeen = typeof arr[0] === 'number' ? arr[0] - 1 : 0;
      } else {
        // 'all' — start from 0
        lastIdSeen = 0;
      }
      job.lastIdSeen = lastIdSeen;
      persistState();
      logger.info({ workflowId: wf.id, model, lastIdSeen, initialBacklog }, 'odoo poller seeded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, workflowId: wf.id, model }, 'odoo poller seed failed');
      persistState(msg);
    }
  };

  const poll = async (): Promise<void> => {
    if (job.inFlight) return; // overlapping tick → skip silently
    if (lastIdSeen < 0) {
      await seed();
      if (lastIdSeen < 0) return;
    }
    job.inFlight = true;
    try {
      await breaker.execute(async () => {
        const { authenticate, executeKw } = await loadClient();
        const transport = createTransport();
        const auth = { baseUrl, database, login, password };
        const uid = await authenticate(auth, transport, { timeoutMs });
        const fullDomain: unknown[] = [['id', '>', lastIdSeen], ...userDomain];
        const kwargs: Record<string, unknown> = { limit: batchLimit, order: 'id asc' };
        if (fieldsList) kwargs.fields = fieldsList;
        const records = await executeKw(
          auth,
          uid,
          {
            model,
            method: 'search_read',
            positional: [fullDomain as never],
            kwargs: kwargs as never,
          },
          transport,
          { timeoutMs },
        );
        if (!Array.isArray(records) || records.length === 0) {
          persistState();
          return;
        }
        for (const rec of records) {
          if (!rec || typeof rec !== 'object') continue;
          const id = (rec as Record<string, unknown>).id;
          if (typeof id !== 'number') continue;
          // Dispatch the workflow run BEFORE bumping the cursor so a
          // failed dispatch results in a retry next tick. Cursor only
          // moves on records we've SUCCESSFULLY dispatched.
          try {
            await deps.dispatchRun({
              workflowId: wf.id,
              tenantId,
              triggerType: 'odoo_polling',
              triggerInput: {
                model,
                record: rec,
                recordId: id,
                triggeredAt: new Date().toISOString(),
              },
            });
            lastIdSeen = id;
            job.lastIdSeen = id;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(
              { err, workflowId: wf.id, model, recordId: id },
              'odoo_polling run failed',
            );
            // AUDIT FIX WE-15 (2026-06-09 MEDIUM): poison-pill DLQ.
            //
            // Pre-fix: `break` qui lasciava lastIdSeen=N-1. Prossimo tick
            // ritentava lo stesso record N → stallo infinito.
            //
            // Post-fix: track retry count su `odoo_dlq`. UPSERT incrementa
            // retry_count fino a MAX_RETRY=5. Al raggiungimento, BUMP
            // lastIdSeen=N + sposta in DLQ (set dlqd_at) per sbloccare il
            // poller. Operatore vede il record orfano in DLQ admin UI.
            const MAX_RETRY = ODOO_DLQ_MAX_RETRY;
            try {
              const existing = sqlite
                .prepare(
                  'SELECT id, retry_count FROM odoo_dlq WHERE workflow_id = ? AND model = ? AND record_id = ? AND dlqd_at IS NULL',
                )
                .get(wf.id, model, id) as { id: number; retry_count: number } | undefined;
              if (existing) {
                const nextRetry = existing.retry_count + 1;
                sqlite
                  .prepare(
                    `
                  UPDATE odoo_dlq SET
                    retry_count = ?,
                    last_failed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error_message = ?,
                    dlqd_at = CASE WHEN ? >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
                  WHERE id = ?
                `,
                  )
                  .run(nextRetry, msg, nextRetry, MAX_RETRY, existing.id);
                if (nextRetry >= MAX_RETRY) {
                  // Poison-pill confermato: bump cursor + log critical
                  logger.error(
                    {
                      workflowId: wf.id,
                      model,
                      recordId: id,
                      retries: nextRetry,
                    },
                    '[WE-15] poison-pill detected — record moved to DLQ, cursor bumped',
                  );
                  lastIdSeen = id;
                  job.lastIdSeen = id;
                  continue; // procedi al prossimo record nella batch
                }
              } else {
                // Prima failure su questo record: INSERT con retry_count=1
                sqlite
                  .prepare(
                    `
                  INSERT INTO odoo_dlq (workflow_id, model, record_id, record_json, error_message)
                  VALUES (?, ?, ?, ?, ?)
                `,
                  )
                  .run(wf.id, model, id, JSON.stringify(rec).slice(0, 32_768), msg);
              }
            } catch (dlqErr) {
              logger.warn(
                { err: dlqErr, workflowId: wf.id, recordId: id },
                '[WE-15] odoo_dlq write failed (non-fatal)',
              );
            }
            // Stop il loop su questo tick — il record verrà ritentato al prossimo
            // poll (a meno che non sia stato già marcato DLQ → cursor avanzato).
            break;
          }
        }
        persistState();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, workflowId: wf.id, model }, 'odoo poll failed');
      persistState(msg);
    } finally {
      job.inFlight = false;
    }
  };

  job.timer = setInterval(() => {
    void poll();
  }, interval);
  logger.info(
    { workflowId: wf.id, model, intervalSec: interval / 1000, batchLimit },
    'odoo poller registered',
  );
  return job;
}
