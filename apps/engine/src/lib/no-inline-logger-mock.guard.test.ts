// @vitest-environment node
/**
 * GUARD anti-regressione — vietato il mock INLINE di `@/lib/logger.js`.
 *
 * La fonte unica è il manual mock `__mocks__/logger.ts` (drift-proof via
 * `logger.contract.test.ts`). I test devono usare la forma SENZA factory:
 *     vi.mock('@/lib/logger.js');
 * Un mock inline `vi.mock('@/lib/logger.js', () => …)` è incompleto per
 * costruzione (manca sempre qualche export) → è il bug "No <x> export is
 * defined on the mock" che ha fatto cadere intere suite in caricamento.
 *
 * Ratchet a BURNDOWN: l'allowlist elenca i file legacy ancora da migrare
 * (asseriscono su uno spy esterno → richiedono rewiring manuale a
 * `vi.mocked(logger)`). Il guard:
 *   • FALLISCE se un file NON in allowlist introduce un mock inline (regressione);
 *   • FALLISCE se un file in allowlist NON ha più il mock inline (entry stale →
 *     va RIMOSSA da qui) → l'allowlist può solo rimpicciolirsi, fino a 0.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Mock inline = `vi.mock('@/lib/logger.js'` seguito (dopo la stringa) da una virgola.
const INLINE_MOCK = /vi\.mock\(\s*['"]@\/lib\/logger\.js['"]\s*,/;

/**
 * Burndown AZZERATO: tutti i test usano il manual mock condiviso. Da qui in poi
 * il guard è assoluto — nessun file può introdurre un mock inline di logger.js.
 */
const BURNDOWN: ReadonlySet<string> = new Set([]);

function walkTests(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...walkTests(full));
    } else if (e.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('🚨 guard — niente mock inline di @/lib/logger.js', () => {
  // I file dell'infrastruttura mock citano il pattern nella doc → esclusi.
  const SELF = new Set(['lib/no-inline-logger-mock.guard.test.ts', 'lib/logger.contract.test.ts']);
  const inline = walkTests(SRC_ROOT)
    .filter((f) => !SELF.has(relative(SRC_ROOT, f)))
    .filter((f) => INLINE_MOCK.test(readFileSync(f, 'utf8')))
    .map((f) => `src/${relative(SRC_ROOT, f)}`)
    .sort();
  const inlineSet = new Set(inline);

  it('il walk trova un numero plausibile di test (sanity)', () => {
    expect(walkTests(SRC_ROOT).length).toBeGreaterThan(100);
  });

  it('🚨 NESSUN file fuori dal burndown usa un mock inline (regressione)', () => {
    const offenders = inline.filter((f) => !BURNDOWN.has(f));
    expect(offenders, `usare vi.mock('@/lib/logger.js') (manual mock). Offenders:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('🚨 il burndown non ha entry STALE (file migrato → rimuovilo da BURNDOWN)', () => {
    const stale = [...BURNDOWN].filter((f) => !inlineSet.has(f));
    expect(stale, `migrati ma ancora in BURNDOWN — rimuovili:\n${stale.join('\n')}`).toEqual([]);
  });

  it('il burndown può solo decrescere (obiettivo: 0)', () => {
    // Snapshot del massimo storico: se sale, qualcuno ha aggiunto inline mock.
    expect(BURNDOWN.size).toBeLessThanOrEqual(0);
  });
});
