/**
 * error-response.ts — sanitizzazione errori per HTTP responses (#194 H5).
 *
 * Pre-fix: 8+ endpoint db-studio/db-rest ritornavano `err.message` raw al
 * client, leakando schema PostgreSQL, file path, SQL state, stack trace.
 *
 * Pattern enterprise: client riceve `{ code, message, reqId }` generico,
 * dettagli completi vanno SOLO al logger (correlation via reqId).
 *
 * Stesso pattern di apps/flowforge-runtime/src/server.ts:239-249 (C3 fix).
 * Centralizzato qui per evitare drift tra route differenti.
 */

import type { Context } from 'hono';
import { logger } from './logger.js';
import { classifyDbConnectionError } from './db-connection-error.js';

export interface SanitizedErrorOptions {
  /**
   * Codice machine-readable per l'errore (es. 'DB_QUERY_FAILED', 'DB_MIGRATION_FAILED').
   * Sostituisce il messaggio raw nel response body.
   */
  code: string;
  /** HTTP status code. Default 400. */
  status?: number;
  /** Messaggio user-friendly (sostituisce err.message in prod). Default 'Operazione fallita'. */
  userMessage?: string;
  /** Contesto extra per il logger (es. workspaceId, queryHash). NON va al client. */
  logContext?: Record<string, unknown>;
}

/**
 * Violazione di vincolo UNIQUE / PRIMARY KEY (riga duplicata). Va distinta dal
 * generico "insert fallita": è il CONTRATTO su cui si appoggia `onConflict:
 * 'ignore'` di db_insert (executor packages/flowforge/nodes/db — regex
 * /UNIQUE|duplicate|PRIMARY KEY|already exists/i sul messaggio). La
 * sanitizzazione #194 H5 mascherava il dettaglio → l'idempotenza dichiarata
 * nel def era rotta su TUTTO il path API (bug trovato E2E 2026-07-06 sul
 * workflow pizzeria). Il messaggio classificato non leaka dati: nomina solo
 * il tipo di vincolo, mai i valori della riga.
 */
export function classifyDbConflictError(err: unknown): { conflict: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  // Firme specifiche UNIQUE/PK (sqlite, better-sqlite3, postgres, mysql). NIENTE
  // match sul generico SQLITE_CONSTRAINT: matcherebbe anche NOT NULL/CHECK, che
  // NON sono conflitti-duplicato e devono restare 400.
  return { conflict: /UNIQUE constraint|PRIMARY KEY|duplicate key|already exists|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(msg) };
}

export function sanitizedErrorResponse(
  c: Context,
  err: unknown,
  opts: SanitizedErrorOptions,
): Response {
  const reqId = c.req.header('x-request-id') ?? (c.get('requestId' as never) as string | undefined) ?? 'unknown';

  // Un fallimento di CONNETTIVITÀ (tunnel SSH/host irraggiungibile/timeout) è un
  // errore INFRA a monte: va comunicato come 503 + messaggio chiaro, MAI come 400
  // muto (la UI deve poter mostrare "database non raggiungibile", non congelarsi).
  // Override centralizzato → vale per OGNI route che usa questo helper.
  const conn = classifyDbConnectionError(err);
  // Conflitto UNIQUE/PK → 409 + messaggio che NOMINA il vincolo (actionable e
  // non sensibile), così il contratto onConflict degli executor db funziona.
  const conflict = !conn.unreachable && classifyDbConflictError(err).conflict;
  const status = conn.unreachable
    ? 503
    : conflict
      ? 409
      : ((opts.status ?? 400) as 400 | 401 | 403 | 404 | 409 | 412 | 422 | 500 | 503);
  const code = conn.unreachable ? 'DB_UNREACHABLE' : conflict ? 'DB_CONFLICT_UNIQUE' : opts.code;

  // SEMPRE log dettagliato server-side (incluso err.message + stack se presente)
  logger.error(
    {
      err,
      reqId,
      code,
      path: c.req.path,
      method: c.req.method,
      ...(opts.logContext ?? {}),
    },
    `[ERR ${code}] ${err instanceof Error ? err.message : String(err)}`,
  );

  // In dev, esponi err.message per debug local. In prod, generico (ma per gli
  // errori di connettività il messaggio chiaro è SEMPRE esposto: è actionable, non sensibile).
  const isProd = process.env.NODE_ENV === 'production';
  const clientMessage = conn.unreachable
    ? conn.userMessage
    : conflict
      ? 'Riga duplicata — viola un vincolo UNIQUE / PRIMARY KEY della tabella'
      : isProd
        ? (opts.userMessage ?? 'Operazione fallita')
        : `[DEV] ${err instanceof Error ? err.message : String(err)}`;

  return c.json({
    error: {
      code,
      message: clientMessage,
      reqId,
    },
  }, status);
}
