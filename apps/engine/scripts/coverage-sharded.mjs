#!/usr/bin/env node
/**
 * Coverage affidabile per suite grandi — sharding nativo Vitest + merge.
 *
 * PROBLEMA RISOLTO
 *   Il run unico `vitest run --coverage` sull'intera suite runtime (~8500
 *   test) gira decine di worker forked in parallelo. Sotto questa
 *   concorrenza i profili V8 di alcuni worker si perdono nel merge interno
 *   → file effettivamente testati appaiono a 0% (falso negativo di coverage).
 *   La metrica diventa inaffidabile e il gate di soglia spara falsi rossi.
 *
 * SOLUZIONE (best-practice ufficiale Vitest per suite grandi)
 *   Si esegue la suite in N shard SEQUENZIALI. Ogni shard:
 *     - gira un sottoinsieme dei file → pochi worker → niente contention V8;
 *     - scrive un blob report (`--reporter=blob`) con dentro i propri dati
 *       di coverage grezzi.
 *   Al termine un singolo `--mergeReports --coverage` ricostruisce UN report
 *   coverage unificato e deterministico (OR dei profili per riga/branch).
 *
 * USO
 *   node scripts/coverage-sharded.mjs                # intera suite, SHARDS=4
 *   SHARDS=6 node scripts/coverage-sharded.mjs       # 6 shard
 *   node scripts/coverage-sharded.mjs src/engine     # subset (args → vitest)
 *
 * Exit code propagato: !=0 se un qualsiasi shard fallisce o se il gate di
 * soglia coverage non è rispettato nel merge finale.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPORTS_DIR = resolve(process.cwd(), '.vitest-reports');
const SHARDS = Math.max(1, Number.parseInt(process.env.SHARDS ?? '4', 10) || 4);
const extraArgs = process.argv.slice(2); // pattern/path opzionali → inoltrati a vitest

/** Esegue vitest con gli argomenti dati, ereditando stdio. */
function runVitest(args, label) {
  process.stdout.write(`\n→ ${label}\n`);
  const res = spawnSync('npx', ['vitest', 'run', ...args], {
    stdio: 'inherit',
    env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'fatal' },
  });
  if (res.error) {
    console.error(`✗ ${label}: ${res.error.message}`);
    process.exit(1);
  }
  return res.status ?? 1;
}

// Partenza pulita: blob stale di run precedenti falserebbero il merge.
if (existsSync(REPORTS_DIR)) rmSync(REPORTS_DIR, { recursive: true, force: true });

// 1) Shard sequenziali. Ognuno scrive il proprio blob (coverage incluso).
for (let i = 1; i <= SHARDS; i++) {
  const status = runVitest(
    [
      ...extraArgs,
      // Config-shard: eredita tutto MA azzera le soglie (globali + per-glob).
      // Il gate reale resta sulla config base, applicato solo nel merge.
      '--config=vitest.coverage-shard.config.ts',
      `--shard=${i}/${SHARDS}`,
      '--coverage',
      '--reporter=blob',
      `--outputFile=.vitest-reports/blob-${i}.json`,
    ],
    `shard ${i}/${SHARDS}`,
  );
  if (status !== 0) {
    console.error(`✗ shard ${i}/${SHARDS} fallito (exit ${status}) — interrompo prima del merge.`);
    process.exit(status);
  }
}

// 2) Merge: niente test rieseguiti, solo ricostruzione del report unificato.
//    Qui i threshold della vitest.config tornano ATTIVI → gate reale.
const mergeStatus = runVitest(
  ['--mergeReports=.vitest-reports', '--coverage'],
  `merge ${SHARDS} shard → report coverage unificato`,
);

process.exit(mergeStatus);
