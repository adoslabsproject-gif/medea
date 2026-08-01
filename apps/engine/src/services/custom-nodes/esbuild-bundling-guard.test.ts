/**
 * 🚨 GUARD anti-regressione — esbuild NON deve essere bundlato (FIX 2026-06-13).
 *
 * Incidente: esbuild era in `devDependencies` → tsup lo bundlava nell'ESM →
 * il suo `__filename` interno (per trovare il binario nativo) era undefined →
 * OGNI compile di custom node falliva con "esbuild compile failed:
 * __filename is not defined". Fix: esbuild in `dependencies` + in tsup `external`.
 *
 * Questo test pinna le DUE condizioni: se una regredisce, il compile si
 * ri-rompe in produzione → meglio un rosso qui che un'IDE inutilizzabile.
 *
 * @module services/custom-nodes/esbuild-bundling-guard.test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const tsup = readFileSync(join(runtimeRoot, 'tsup.config.ts'), 'utf-8');

describe('🚨 esbuild bundling guard', () => {
  it('esbuild è in dependencies (installato nell\'image prod)', () => {
    expect(pkg.dependencies?.esbuild, 'esbuild deve stare in dependencies').toBeTruthy();
  });

  it('🚨 esbuild NON è in devDependencies (altrimenti tsup lo bundla → __filename undefined)', () => {
    expect(pkg.devDependencies?.esbuild).toBeUndefined();
  });

  it('🚨 esbuild è dichiarato external in tsup.config.ts (NON bundlato)', () => {
    // Deve comparire come elemento dell'array external (stringa quotata).
    expect(tsup).toMatch(/external:\s*\[[\s\S]*['"]esbuild['"][\s\S]*\]/u);
  });
});
