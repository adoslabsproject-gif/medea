/**
 * Built-in CodeRules registry.
 *
 * Quando aggiungi una nuova code rule:
 *   1. crea il file `<scope>/<rule>.rule.ts`
 *   2. importala qui
 *   3. aggiungila a `BUILTIN_CODE_RULES`
 * Niente magia auto-discover. Federico-grade: registrazione esplicita.
 */

import type { CodeRule } from '@/services/janitor/domain/index.js';
import { runsZombieRule } from './runs/runs-zombie.rule.js';
import { runsCorruptedJsonRule } from './runs/runs-corrupted-json.rule.js';
import { runsTruncatedStepsRule } from './runs/runs-truncated-steps.rule.js';
import { runsOrphanCheckpointRule } from './runs/runs-orphan-checkpoint.rule.js';

export const BUILTIN_CODE_RULES: readonly CodeRule[] = Object.freeze([
  runsZombieRule,
  runsCorruptedJsonRule,
  runsTruncatedStepsRule,
  runsOrphanCheckpointRule,
]);

export { runsZombieRule, runsCorruptedJsonRule, runsTruncatedStepsRule, runsOrphanCheckpointRule };
