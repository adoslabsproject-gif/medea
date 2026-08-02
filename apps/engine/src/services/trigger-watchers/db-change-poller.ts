/**
 * trigger-watchers/db-change-poller — trigger_db_change: polla il change-log di
 * una tabella DB Studio e fa partire un run per ogni change nuovo (split
 * 2026-06-12, estratto dal monolite TriggerWatchersService).
 *
 * Invarianti (pinnate dai test):
 *   - seed del cursore al MAX corrente → fire SOLO su change FUTURI;
 *   - seed fallito → FAIL-CLOSED: warn, cursore null, retry del seed a ogni
 *     tick — il backlog non viene MAI rigiocato (fix 2026-06-12, era un quirk
 *     del monolite);
 *   - filtro ops: i change non-matching AVANZANO il cursore senza run
 *     (niente replay dei filtrati al tick dopo);
 *   - errore nel tick (change-log o dispatch) → loggato, il poller sopravvive;
 *   - intervallo clampato [2, 86400]s default 5 via clampNumber (anti-DoS,
 *     mai setInterval(NaN) — fix 2026-06-12).
 *
 * Elevazione vs monolite (no downgrade): change-log reader e dispatcher dei run
 * sono INIETTABILI (`DbChangePollerDeps`) — il metodo privato usava
 * `this.dbStudio` e `this.runs` inline. Default cablato dal service.
 */

import { logger } from '@/lib/logger.js';
import { clampNumber } from './parsing.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';

/** Riga del change-log DB Studio (shape di `DbStudioService.getChangesSince`). */
export interface DbChangeRecord {
  id: number;
  op: string;
  payload: unknown;
  createdAt: string;
}

export interface DbChangePollerJob {
  workflowId: string;
  timer: ReturnType<typeof setInterval>;
  /** Cursore al momento della REGISTRAZIONE (il cursore vivo è nella closure del poll). */
  lastIdSeen: number;
}

export interface DbChangePollerDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Change-log reader. In produzione: `DbStudioService.getChangesSince` (bound). */
  getChangesSince: (
    tenantId: string,
    databaseId: string,
    tableName: string,
    sinceId: number,
    limit?: number,
  ) => DbChangeRecord[];
}

/** Scan-limit del seed: quanto in alto cerchiamo il MAX(id) corrente. */
export const DB_CHANGE_SEED_SCAN_LIMIT = 1_000_000;
/** Intervallo minimo di poll (anti-DoS sul DB del tenant). */
export const DB_CHANGE_MIN_INTERVAL_SEC = 2;

/**
 * Avvia il poller per un nodo trigger_db_change. Ritorna il job (handle per
 * `clearInterval`) oppure `null` se databaseId/tableName mancano — in quel
 * caso NIENTE viene registrato, come nel monolite.
 */
export function startDbChangePoller(
  wf: Workflow,
  node: CanvasNode,
  deps: DbChangePollerDeps,
): DbChangePollerJob | null {
  const databaseId = typeof node.config.databaseId === 'string' ? node.config.databaseId : '';
  const tableName = typeof node.config.tableName === 'string' ? node.config.tableName : '';
  const opsFilter = typeof node.config.ops === 'string' ? node.config.ops : 'all';
  const intervalSec = clampNumber(
    node.config.pollIntervalSec,
    DB_CHANGE_MIN_INTERVAL_SEC,
    86_400,
    5,
  );
  if (!databaseId || !tableName) return null;

  const tenantId = wf.tenantId ?? 'default';
  // FIX fail-closed (2026-06-12): cursore `null` finché il seed non riesce.
  // Pre-fix un seed fallito lasciava il cursore a 0 e il primo tick rigiocava
  // l'INTERO backlog (ri-esecuzioni non idempotenti su righe storiche). Ora il
  // poll RITENTA il seed a ogni tick e non interroga MAI il change-log con un
  // cursore non inizializzato.
  let lastIdSeen: number | null = null;
  // Seed lastIdSeen at the current max so we only fire on FUTURE changes
  const seedCursor = (): void => {
    const seed = deps.getChangesSince(
      tenantId,
      databaseId,
      tableName,
      0,
      DB_CHANGE_SEED_SCAN_LIMIT,
    );
    lastIdSeen = seed.length > 0 ? (seed[seed.length - 1]?.id ?? 0) : 0;
  };
  try {
    seedCursor();
  } catch (err) {
    logger.warn({ err, workflowId: wf.id }, 'Failed to seed db-change cursor');
  }

  const poll = (): void => {
    try {
      if (lastIdSeen === null) seedCursor(); // retry: throw → catch sotto → tick dopo
      const cursor = lastIdSeen;
      if (cursor === null) return; // irraggiungibile (seedCursor setta o lancia) — narrowing per TS
      const changes = deps.getChangesSince(tenantId, databaseId, tableName, cursor);
      for (const change of changes) {
        if (opsFilter !== 'all' && opsFilter !== change.op) {
          lastIdSeen = change.id;
          continue;
        }
        lastIdSeen = change.id;
        void deps
          .dispatchRun({
            workflowId: wf.id,
            tenantId,
            triggerType: 'db_change',
            triggerInput: {
              changeId: change.id,
              op: change.op,
              databaseId,
              tableName,
              payload: change.payload,
              createdAt: change.createdAt,
            },
          })
          .catch((err: unknown) => {
            logger.error({ err, workflowId: wf.id, changeId: change.id }, 'db_change run failed');
          });
      }
    } catch (err) {
      logger.error({ err, workflowId: wf.id }, 'db_change poll failed');
    }
  };

  const timer = setInterval(poll, intervalSec * 1000);
  logger.info({ workflowId: wf.id, databaseId, tableName }, 'db_change poller registered');
  return { workflowId: wf.id, timer, lastIdSeen: lastIdSeen ?? 0 };
}
