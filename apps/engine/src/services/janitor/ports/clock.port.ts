/**
 * Port — IClock.
 *
 * Iniettato a ogni use case che usa il "now". Tutti i test sostituiscono
 * questa interfaccia con un clock controllato (Vitest fake timers o
 * stub manuale). Niente `Date.now()` sparso = niente test flaky.
 *
 * Federico-grade: tempo determinism a livello architetturale.
 */

export interface IClock {
  /** Current instant. */
  now(): Date;
  /** Current epoch millis — comodo per delta calc. */
  epochMs(): number;
  /** ISO 8601 con millisecond precision, sempre UTC. */
  nowIso(): string;
}
