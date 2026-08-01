/**
 * AUDIT FIX WE-6 (2026-06-09 HIGH) — REGRESSION GUARD source inspection.
 *
 * Verifica che il workflow-engine.ts contiene i 3 cap anti-runaway:
 *   1. MAX_STEP_COUNT (default 10_000)
 *   2. MAX_RUN_DURATION_MS (default 30 minuti)
 *   3. MAX_QUEUE_SIZE (default 5000)
 *
 * Pre-fix bug:
 *   BFS executeFromQueue girava fino a coda vuota → workflow malformato
 *   (cycle non rilevato da visited, fan-out N-edges, loop_logic re-entrant)
 *   = OOM container. outputsById accumulava OGNI nodo output per la run
 *   intera (1000 nodi × 100KB = 100MB tenuti vivi).
 *
 * Post-fix: throw RunQuotaExceededError-like su threshold. Audit visible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(__dirname, 'workflow-engine.ts'), 'utf-8');

describe('🚨 [REGRESSION WE-6] workflow-engine hard caps', () => {
  it('🚨 MAX_STEP_COUNT definito con default 10_000', () => {
    expect(engineSource).toMatch(/MAX_STEP_COUNT\s*=\s*Number\(.*?FLOWFORGE_ENGINE_MAX_STEPS.*?'10000'\)/);
  });

  it('🚨 MAX_RUN_DURATION_MS definito con default 30min (1_800_000ms)', () => {
    expect(engineSource).toMatch(/MAX_RUN_DURATION_MS\s*=\s*Number\(.*?FLOWFORGE_ENGINE_MAX_RUN_DURATION_MS/);
    // 30 * 60_000 = 1_800_000ms default
    expect(engineSource).toMatch(/30\s*\*\s*60_000/);
  });

  it('🚨 MAX_QUEUE_SIZE definito con default 5000', () => {
    expect(engineSource).toMatch(/MAX_QUEUE_SIZE\s*=\s*Number\(.*?FLOWFORGE_ENGINE_MAX_QUEUE_SIZE.*?'5000'\)/);
  });

  it('🚨 check totalStepsExecuted >= MAX_STEP_COUNT → throw', () => {
    expect(engineSource).toMatch(/totalStepsExecuted\s*>=?\s*MAX_STEP_COUNT/);
    expect(engineSource).toMatch(/throw new Error\(`Engine cap hit: max-step-count/);
  });

  it('🚨 check Date.now() - startedAt > MAX_RUN_DURATION_MS → throw', () => {
    expect(engineSource).toMatch(/Date\.now\(\)\s*-\s*startedAt\s*>\s*MAX_RUN_DURATION_MS/);
    expect(engineSource).toMatch(/throw new Error\(`Engine cap hit: max-run-duration/);
  });

  it('🚨 check queue.length > MAX_QUEUE_SIZE → throw', () => {
    expect(engineSource).toMatch(/queue\.length\s*>\s*MAX_QUEUE_SIZE/);
    expect(engineSource).toMatch(/throw new Error\(`Engine cap hit: max-queue-size/);
  });

  it('🚨 totalStepsExecuted incrementato dentro al while loop', () => {
    expect(engineSource).toMatch(/totalStepsExecuted\s*\+=\s*1/);
  });
});
