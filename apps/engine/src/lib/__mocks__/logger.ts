/**
 * Manual mock CONDIVISO di `@/lib/logger.js` (convenzione vitest `__mocks__`).
 *
 * Fonte UNICA per silenziare/asserire il logger nei test del runtime. Prima
 * ~147 file dichiaravano un mock inline DIVERGENTE (13+ varianti): tutti
 * incompleti rispetto alla superficie reale di `logger.ts` → bastava che un
 * test raggiungesse un modulo che usa un export non mockato (es. `loggerFor`
 * in `db-studio.managed-client`) per far fallire l'INTERA suite in caricamento
 * ("No loggerFor export is defined on the mock").
 *
 * Uso nei test:
 *   vi.mock('@/lib/logger.js');                 // ← niente factory: usa QUESTO
 *   import { logger, loggerFor } from '@/lib/logger.js';
 *   expect(vi.mocked(logger).error).toHaveBeenCalledWith(...);
 *
 * Invarianti blindati da test dedicati:
 *  • `logger.contract.test.ts` — la superficie del mock == quella reale (anti-drift);
 *  • `no-inline-logger-mock.guard.test.ts` — vietati nuovi mock inline.
 *
 * @module lib/__mocks__/logger
 */
import { vi } from 'vitest';

/** Spy logger completo: stessa forma del `Logger` (pino) reale. */
export interface SpyLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  silent: ReturnType<typeof vi.fn>;
  level: string;
  /** Ritorna SE STESSO → asserzioni stabili sul medesimo spy anche via child. */
  child: ReturnType<typeof vi.fn>;
}

/** Crea uno spy logger isolato (per chi vuole un'istanza dedicata). */
export function createSpyLogger(): SpyLogger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child: vi.fn(),
  };
  l.child.mockReturnValue(l);
  return l;
}

/**
 * Singleton per-FILE su globalThis: gli spy DEVONO sopravvivere a
 * `vi.resetModules()` (molti test re-importano il modulo sotto test dopo il
 * reset). Senza, ogni re-istanziazione del mock creerebbe spy nuovi e le
 * asserzioni del test — catturate una volta in cima — punterebbero a spy morti
 * (0 chiamate / falsi verdi). vitest isola ogni file di test in un proprio
 * contesto → `globalThis` è per-file: nessun leak cross-file.
 */
interface SharedLoggerMock {
  logger: SpyLogger;
  loggerFor: ReturnType<typeof vi.fn>;
  dedupedWarn: ReturnType<typeof vi.fn>;
  dedupedError: ReturnType<typeof vi.fn>;
  errorFingerprint: ReturnType<typeof vi.fn>;
}

function shared(): SharedLoggerMock {
  const g = globalThis as { __ffSharedLoggerMock?: SharedLoggerMock };
  if (!g.__ffSharedLoggerMock) {
    const l = createSpyLogger();
    g.__ffSharedLoggerMock = {
      logger: l,
      loggerFor: vi.fn((_moduleName: string): SpyLogger => l),
      dedupedWarn: vi.fn(),
      dedupedError: vi.fn(),
      errorFingerprint: vi.fn((_err: unknown, context?: string): string => `fp:${context ?? ''}`),
    };
  }
  return g.__ffSharedLoggerMock;
}

// ── Superficie mockata == export reali di logger.ts (verificata dal contract) ──
export const logger: SpyLogger = shared().logger;
export const loggerFor = shared().loggerFor;
export const dedupedWarn = shared().dedupedWarn;
export const dedupedError = shared().dedupedError;
export const errorFingerprint = shared().errorFingerprint;
