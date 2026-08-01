// @vitest-environment node
/**
 * CONTRACT anti-drift — il manual mock `__mocks__/logger.ts` deve coprire
 * ESATTAMENTE la superficie a runtime del modulo reale `logger.ts`.
 *
 * È il test che rende IMPOSSIBILE il ripetersi del bug "No <export> is defined
 * on the @/lib/logger.js mock": se domani qualcuno aggiunge un export VALUE a
 * logger.ts senza aggiungerlo al mock, questo test fallisce PRIMA che esploda
 * un'altra suite a caso. + verifica comportamentale del mock.
 *
 * Parsing del SORGENTE (non import del reale): logger.ts esegue `loadConfig()`
 * a top-level → importarlo accoppierebbe il contract alla config. Mirror del
 * pattern del guard `nodes-browser-safe`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as loggerMock from './__mocks__/logger';

const HERE = dirname(fileURLToPath(import.meta.url));
const realSource = readFileSync(join(HERE, 'logger.ts'), 'utf8');

/** Export VALUE (runtime) del modulo reale — esclude `export type` / `export type { }`. */
function realValueExports(src: string): Set<string> {
  const names = new Set<string>();
  // export const|function|class NAME
  for (const m of src.matchAll(/^export\s+(?:const|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
    if (m[1]) names.add(m[1]);
  }
  // export { a, b }  (value re-export) — ma NON `export type { ... }`
  for (const m of src.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const id = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (id) names.add(id);
    }
  }
  return names;
}

describe('🚨 contract — manual mock logger copre la superficie reale', () => {
  const real = realValueExports(realSource);
  const mockKeys = new Set(Object.keys(loggerMock));

  it('il parser trova gli export reali attesi (sanity)', () => {
    expect(real.has('logger')).toBe(true);
    expect(real.has('loggerFor')).toBe(true);
    expect(real.has('dedupedWarn')).toBe(true);
    expect(real.size).toBeGreaterThanOrEqual(5);
    // i type-only NON devono entrare
    expect(real.has('LogChannel')).toBe(false);
    expect(real.has('Logger')).toBe(false);
  });

  it('🚨 OGNI export VALUE reale è presente nel mock (anti-drift)', () => {
    const missing = [...real].filter((name) => !mockKeys.has(name));
    expect(missing, `il mock NON copre: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('🚨 comportamento del manual mock', () => {
  it('🚨 loggerFor ritorna lo spy logger (stesso oggetto) con i metodi spia', () => {
    const log = loggerMock.loggerFor('db-studio.managed-client');
    expect(log).toBe(loggerMock.logger);
    log.error('boom');
    expect(loggerMock.logger.error).toHaveBeenCalledWith('boom');
  });

  it('🚨 logger.child ritorna lo STESSO spy (asserzioni stabili via child)', () => {
    const child = loggerMock.logger.child({ module: 'x' });
    expect(child).toBe(loggerMock.logger);
  });

  it('🚨 createSpyLogger crea istanze ISOLATE (spy indipendenti)', () => {
    const a = loggerMock.createSpyLogger();
    const b = loggerMock.createSpyLogger();
    a.info('hi');
    expect(a.info).toHaveBeenCalledTimes(1);
    expect(b.info).toHaveBeenCalledTimes(0);
    expect(a.child()).toBe(a);
  });

  it('lo spy espone l\'intera forma pino usata nei call-site', () => {
    const l = loggerMock.createSpyLogger();
    for (const m of ['info', 'warn', 'error', 'debug', 'trace', 'fatal', 'silent', 'child'] as const) {
      expect(typeof l[m]).toBe('function');
    }
    expect(typeof l.level).toBe('string');
  });

  it('errorFingerprint/deduped* sono spia invocabili', () => {
    expect(loggerMock.errorFingerprint(new Error('x'), 'ctx')).toContain('ctx');
    expect(vi.isMockFunction(loggerMock.dedupedWarn)).toBe(true);
    expect(vi.isMockFunction(loggerMock.dedupedError)).toBe(true);
  });
});
