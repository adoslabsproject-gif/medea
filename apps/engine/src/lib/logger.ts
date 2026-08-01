/**
 * Logger del runtime — facade su @flowforge/observability-logger.
 *
 * Phase 2 refactor: la logica logger (pino + redact + base context) è stata
 * estratta in `@flowforge/observability-logger` come libreria condivisa.
 * Questo file resta come adapter app-specifico che injecta:
 *   • service: "flowforge-runtime"
 *   • env: dal config FlowForge
 *   • level: dal config FlowForge
 *
 * Vantaggi: future app (apps/cli, apps/desktop, apps/runtime-edge) possono
 * usare lo stesso logger senza duplicare la config Pino + redact paths.
 *
 * API invariata per i consumer: continua a esportare `logger` e `Logger`,
 * zero changes nei call site (`import { logger } from '@/lib/logger.js'`).
 */
import {
  createLogger,
  dedupedWarn as _dedupedWarn,
  dedupedError as _dedupedError,
  errorFingerprint as _errorFingerprint,
  type Logger,
} from '@flowforge/observability-logger';
import { loadConfig } from '@/config.js';

const config = loadConfig();

export const logger: Logger = createLogger({
  service: 'flowforge-runtime',
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
});

/**
 * Dedup wrappers già "boundati" al singleton `logger` runtime.
 *
 * Uso typico in punti con potenziale flood (community node loaders,
 * polling loops, IMAP reconnect cycles):
 *
 *   import { logger, dedupedWarn, errorFingerprint } from '@/lib/logger.js';
 *   try { ... }
 *   catch (err) {
 *     dedupedWarn(errorFingerprint(err, `loadNode:${vendor}:${id}`),
 *                 { err, vendor, id }, 'Failed to load community node');
 *   }
 *
 * Risultato: prima occorrenza loggata immediata, successive nello stesso
 * fingerprint contate e emesso summary "[×N in last 60s]" allo scadere
 * della TTL window. ZodError completi non vengono più dumpati (serializer
 * `err` truncate a 500 char + first 5 issues).
 */
export function dedupedWarn(fingerprint: string, payload: Record<string, unknown>, msg: string): void {
  _dedupedWarn(logger, fingerprint, payload, msg);
}
export function dedupedError(fingerprint: string, payload: Record<string, unknown>, msg: string): void {
  _dedupedError(logger, fingerprint, payload, msg);
}
export const errorFingerprint = _errorFingerprint;

/**
 * Smistamento child logger per canale PSR-3 (#194-bis).
 *
 * Stesso mapping del portal (apps/portal/src/logger.ts) per consistency
 * cross-app. Il `channel` finisce nel JSON log e Grafana/Loki può
 * filtrare per `{service="flowforge-runtime", channel="security"}`.
 *
 * NB: a differenza del portal NON spezziamo su file multipli a livello
 * pino transport (il runtime gira in Docker container → stdout finisce
 * in `docker logs` → un loro aggregator tipo Loki/Vector smista poi).
 * Qui esponiamo SOLO il binding `channel` come bridge.
 */
export type LogChannel = 'app' | 'security' | 'audit' | 'http' | 'system' | 'liara' | 'performance';

const CHANNEL_RULES: readonly (readonly [RegExp, LogChannel])[] = [
  [/^security\./i, 'security'],
  [/^honeypot/i, 'security'],
  [/^sentinel/i, 'security'],
  [/^auth\./i, 'security'],
  [/^audit\./i, 'audit'],
  [/^admin\./i, 'audit'],
  [/^http(-access)?$/i, 'http'],
  [/^webhooks?\./i, 'http'],
  [/^dashboard\./i, 'http'],
  [/^liara\./i, 'liara'],
  [/^llm\./i, 'liara'],
  [/^perf(ormance)?\./i, 'performance'],
  [/^metrics\./i, 'performance'],
  [/^system\./i, 'system'],
  [/^cron\./i, 'system'],
  [/^boot\./i, 'system'],
  [/^lifecycle/i, 'system'],
  [/^engine\./i, 'system'],
];

function detectChannel(moduleName: string): LogChannel {
  for (const [regex, channel] of CHANNEL_RULES) {
    if (regex.test(moduleName)) return channel;
  }
  return 'app';
}

/**
 * Child logger con binding `module` + `channel` (smistato per prefisso).
 *
 *   loggerFor('honeypot')           → channel='security'
 *   loggerFor('dashboard.sse')      → channel='http'
 *   loggerFor('liara.gateway')      → channel='liara'
 *   loggerFor('integrations.gmail') → channel='app' (default)
 */
export function loggerFor(moduleName: string): Logger {
  const channel = detectChannel(moduleName);
  return logger.child({ module: moduleName, channel });
}

export type { Logger };
