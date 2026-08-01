/**
 * Janitor — process-wide singleton accessor.
 *
 * Il `JanitorRuntime` è creato in `main.ts` (composition root). Per esporlo
 * ai workflow executors senza passarlo attraverso tutti i layer dell'engine
 * (che è state-agnostic by design), usiamo un singleton modulo set-once.
 *
 * Pattern: setJanitor() chiamato 1 volta al boot; getJanitor() chiamato N
 * volte dagli executor. Se getJanitor() viene invocato prima dell'init →
 * throw con messaggio chiaro (indica che il chiamante sta runando troppo
 * presto nel lifecycle).
 *
 * Federico-grade: niente module-level mutable variable esportata. L'accesso
 * passa SEMPRE dalle funzioni — set/get/reset (per test).
 */

import type { JanitorRuntime } from './infrastructure/janitor.factory.js';

let runtime: JanitorRuntime | null = null;

export function setJanitor(j: JanitorRuntime): void {
  runtime = j;
}

export function getJanitor(): JanitorRuntime {
  if (!runtime) {
    throw new Error(
      'JanitorRuntime non inizializzato. Il chiamante sta runando prima del boot — verifica che `setJanitor()` sia chiamato in main.ts dopo `createJanitorRuntime()`.',
    );
  }
  return runtime;
}

/** Solo per i test che vogliono pulire lo stato. */
export function resetJanitorSingleton(): void {
  runtime = null;
}
