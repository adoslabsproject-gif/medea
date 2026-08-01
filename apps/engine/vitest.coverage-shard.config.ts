/**
 * Config Vitest per i SINGOLI shard di coverage (vedi scripts/coverage-sharded.mjs).
 *
 * Eredita interamente `vitest.config.ts` ma AZZERA le soglie di coverage:
 * uno shard vede solo una frazione dei file, quindi qualsiasi threshold
 * (globale o per-glob come `src/engine/**`) sparerebbe falsi rossi.
 * Il gate reale resta nella config base ed è applicato SOLO nel merge finale.
 *
 * Niente duplicazione: si parte dall'oggetto base e si sostituisce in blocco
 * `coverage.thresholds` (sostituzione, non deep-merge: così spariscono anche
 * le chiavi per-glob, che un merge ricorsivo conserverebbe).
 */
import base from './vitest.config';

const shardConfig = structuredClone(base);

if (shardConfig.test?.coverage) {
  shardConfig.test.coverage.thresholds = {
    lines: 0,
    functions: 0,
    statements: 0,
    branches: 0,
  };
}

export default shardConfig;
