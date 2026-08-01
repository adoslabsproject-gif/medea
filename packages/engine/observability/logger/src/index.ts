/**
 * @flowforge/observability-logger — structured logger condiviso.
 *
 * Wrapper attorno a Pino con configurazione FlowForge-grade:
 *   • Output JSON in produzione (compatibile con journald/Loki/Elasticsearch)
 *   • Output pino-pretty colorato in development
 *   • Redaction automatica di password/apiKey/token/secret nei log
 *   • `base` field con service name + env per filtraggio centralizzato
 *   • Custom serializer `err` che SUMMARIZZA Zod/Error invece di dump
 *     full multi-KB (fix log explosion)
 *   • `dedupedWarn(logger, fingerprint, payload, msg)` — LRU+TTL 60s
 *     che logga UNA volta + count incrementale invece di flood per
 *     errori ricorrenti (community node broken al boot, retry loop ecc.)
 *
 * Estratto da apps/runtime/src/lib/logger.ts in Phase 2 refactor — ora
 * disponibile come libreria condivisa per:
 *   • apps/runtime (consumer attuale)
 *   • apps/cli (future)
 *   • apps/desktop (future Electron worker)
 *   • apps/runtime-edge (future Cloudflare Workers)
 *
 * Uso:
 *   import { createLogger, dedupedWarn } from '@flowforge/observability-logger';
 *   const logger = createLogger({ service: 'flowforge-runtime', env: 'production' });
 *   logger.info({ tenantId: 'x', userId: 'y' }, 'request handled');
 *   dedupedWarn(logger, `cnload:${vendor}:${id}`, { err, vendor, id }, 'Failed to load');
 */

import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  /** Service name (es. "flowforge-runtime"). Iniettato in ogni log line. */
  service: string;
  /** Environment (es. "production", "development", "test"). */
  env: string;
  /** Log level (default "info"). */
  level?: string;
  /** Pretty-print in development (auto-attivo se env="development"). */
  pretty?: boolean;
  /** Path da redactare (default: password/apiKey/token/secret in headers). */
  redactPaths?: string[];
  /**
   * Max bytes per ogni `err.message`/`err.stack` field. Default 500.
   * ZodError grezzi possono essere 5-10KB → con 200 occorrenze/min = 1-2MB
   * di log inutilizzabile. Cap stretto è la differenza fra log usabile
   * (grep, tail -f) e log discarica (curl all-on-fire).
   */
  maxErrFieldBytes?: number;
}

const DEFAULT_REDACT_PATHS = [
  'req.headers.authorization',
  '*.password',
  '*.apiKey',
  '*.token',
  '*.secret',
];

const DEFAULT_MAX_ERR_BYTES = 500;

/**
 * Custom serializer per il campo `err`. Pino di default fa JSON.stringify(err)
 * che su ZodError espone l'intero `.message` (string multi-KB con tutti gli
 * issue formattati). Qui invece estraiamo i campi utili:
 *   - type, name → identificazione classe
 *   - message → TRUNCATED a maxBytes
 *   - issueCount + first 5 issues paths (solo per ZodError)
 *   - stack → prima riga + count totale
 */
function makeErrSerializer(maxBytes: number) {
  return (err: unknown): Record<string, unknown> => {
    if (!err || typeof err !== 'object') return { value: String(err) };
    const e = err as {
      name?: string;
      message?: string;
      stack?: string;
      issues?: { path?: unknown[]; code?: string; message?: string }[];
      cause?: unknown;
    };
    const out: Record<string, unknown> = {};
    if (e.name) out.type = e.name;
    if (e.message) {
      out.message = e.message.length > maxBytes
        ? `${e.message.slice(0, maxBytes)}…[+${(e.message.length - maxBytes).toString()}ch]`
        : e.message;
    }
    // ZodError-specific: estrai issues summary invece di dump completo
    if (Array.isArray(e.issues)) {
      out.issueCount = e.issues.length;
      out.issues = e.issues.slice(0, 5).map((i) => ({
        path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
        code: i.code,
        message: i.message,
      }));
      if (e.issues.length > 5) out.issuesTruncated = e.issues.length - 5;
    }
    // Stack: solo le prime 3 righe (la riga 0 è già nel message)
    if (e.stack) {
      const lines = e.stack.split('\n').slice(0, 4);
      out.stack = lines.join('\n');
    }
    // Cause chain — coercizione display-safe (cause è `unknown`; mai "[object Object]").
    if (e.cause != null) {
      const c: unknown = e.cause;
      let causeStr: string;
      if (typeof c === 'string') causeStr = c;
      else if (c instanceof Error) causeStr = c.message;
      else if (typeof c === 'number' || typeof c === 'boolean' || typeof c === 'bigint') causeStr = String(c);
      else { try { causeStr = JSON.stringify(c) ?? ''; } catch { causeStr = ''; } }
      out.cause = causeStr.slice(0, 200);
    }
    return out;
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pretty = options.pretty ?? options.env === 'development';
  const maxErrBytes = options.maxErrFieldBytes ?? DEFAULT_MAX_ERR_BYTES;
  return pino({
    level: options.level ?? 'info',
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              ignore: 'pid,hostname',
              translateTime: 'SYS:HH:MM:ss.l',
            },
          },
        }
      : {}),
    base: {
      service: options.service,
      env: options.env,
    },
    redact: {
      paths: options.redactPaths ?? DEFAULT_REDACT_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      err: makeErrSerializer(maxErrBytes),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// dedupedWarn — fingerprint-based rate-limiting per log ricorrenti
// ─────────────────────────────────────────────────────────────────────────
//
// PATTERN: alcuni errori sono "known broken state" (community node
// firmato male, network blip ricorrente, rate-limit upstream). Loggare
// ogni occorrenza è waste: 200 log/sec identici nascondono i log veri.
//
// Pattern Federico-grade: una hashmap LRU bounded (default 1000 chiavi)
// + TTL (default 60s). Prima occorrenza loggata immediatamente. Successive
// nello stesso TTL window: contate. Alla fine del TTL, se ci sono stati
// N>1 hit, log finale `dedup_summary` con count.
//
// Trade-off vs sampling random: sampling perde sempre la PRIMA occorrenza
// di un nuovo errore — il caso più informativo. Fingerprinting cattura
// SEMPRE il first-seen e silenzia il rest.

interface DedupEntry {
  firstSeen: number;
  count: number;
  lastPayload: Record<string, unknown>;
  lastMsg: string;
  level: 'warn' | 'error';
}

const dedupMap = new Map<string, DedupEntry>();
const DEDUP_MAX_KEYS = 1000;
const DEDUP_TTL_MS = 60_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlushTimer(logger: Logger): void {
  if (flushTimer) return;
  // Periodicamente emette summary dei dedup expired
  flushTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of dedupMap.entries()) {
      if (now - entry.firstSeen >= DEDUP_TTL_MS) {
        if (entry.count > 1) {
          logger[entry.level]({
            ...entry.lastPayload,
            dedup_key: key,
            dedup_count: entry.count,
            dedup_window_ms: DEDUP_TTL_MS,
          }, `${entry.lastMsg} [×${entry.count.toString()} in last ${(DEDUP_TTL_MS / 1000).toString()}s]`);
        }
        dedupMap.delete(key);
      }
    }
  }, 10_000);
  // Non bloccare process exit
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function dedupedLog(
  logger: Logger,
  level: 'warn' | 'error',
  fingerprint: string,
  payload: Record<string, unknown>,
  msg: string,
): void {
  ensureFlushTimer(logger);
  const existing = dedupMap.get(fingerprint);
  if (!existing) {
    // First occurrence → log immediatamente
    if (dedupMap.size >= DEDUP_MAX_KEYS) {
      // LRU eviction: rimuovi più vecchio
      const oldest = dedupMap.keys().next().value;
      if (oldest) dedupMap.delete(oldest);
    }
    dedupMap.set(fingerprint, {
      firstSeen: Date.now(),
      count: 1,
      lastPayload: payload,
      lastMsg: msg,
      level,
    });
    logger[level](payload, msg);
    return;
  }
  // Duplicato in TTL window → solo conta
  existing.count += 1;
  existing.lastPayload = payload;
  existing.lastMsg = msg;
}

/**
 * Logga `warn` UNA volta per ogni fingerprint univoco entro la TTL window
 * (default 60s). Le occorrenze duplicate sono contate e emesso un summary
 * al termine della window.
 *
 * @param fingerprint chiave di dedup — tipico: `${operationName}:${id}:${errorType}`
 */
export function dedupedWarn(
  logger: Logger,
  fingerprint: string,
  payload: Record<string, unknown>,
  msg: string,
): void {
  dedupedLog(logger, 'warn', fingerprint, payload, msg);
}

/** Variant per error level — stesso pattern. */
export function dedupedError(
  logger: Logger,
  fingerprint: string,
  payload: Record<string, unknown>,
  msg: string,
): void {
  dedupedLog(logger, 'error', fingerprint, payload, msg);
}

/** Utility — fingerprint da un Error (name + first stack frame + msg slice). */
export function errorFingerprint(err: unknown, prefix = ''): string {
  if (!err || typeof err !== 'object') return `${prefix}:${String(err).slice(0, 64)}`;
  const e = err as { name?: string; message?: string; stack?: string };
  const stack0 = e.stack?.split('\n')[1]?.trim().slice(0, 80) ?? '';
  return `${prefix}:${e.name ?? 'Error'}:${(e.message ?? '').slice(0, 64)}:${stack0}`;
}
